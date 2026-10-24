export const ISOLATED_HOOK_TIMEOUT_MS = 90_000;

function isolatedOptions(source, controller) {
  const options = {};
  // Preserve the caller's execution environment and permissions, never its
  // conversation identity or Stop/PostToolUse hooks (which could recurse).
  for (const key of ['cwd', 'model', 'mcpServers', 'strictMcpConfig', 'tools',
    'permissionMode', 'allowDangerouslySkipPermissions', 'canUseTool',
    'pathToClaudeCodeExecutable', 'spawnClaudeCodeProcess', 'settings']) {
    if (source[key] !== undefined) options[key] = source[key];
  }
  for (const key of ['allowedTools', 'disallowedTools', 'executableArgs']) {
    if (Array.isArray(source[key])) options[key] = [...source[key]];
  }
  options.env = { ...source.env };
  delete options.env.CLAUDECODE;
  options.hooks = Object.fromEntries(['PreToolUse', 'PermissionRequest', 'PermissionDenied']
    .filter((event) => source.hooks?.[event]).map((event) => [event, source.hooks[event]]));
  const originalPrompt = typeof source.systemPrompt === 'string' ? source.systemPrompt : source.systemPrompt?.append || '';
  options.systemPrompt = { type: 'preset', preset: 'claude_code', append: [originalPrompt,
    'CCUI_ISOLATED_HOOK: Execute only this Hook task in an independent conversation. The parent conversation will not receive your messages or results.',
  ].filter(Boolean).join('\n') };
  // Project/user settings can contain permission denials. Keep those sources;
  // conversation isolation comes from omitting resume/sessionId, not from
  // discarding the user's tool policy.
  return { ...options, persistSession: false, settingSources: [...(source.settingSources || [])], skills: [], plugins: [],
    includePartialMessages: false, maxTurns: 20, abortController: controller };
}

export async function runIsolatedHookAgent({ prompt, sdkOptions = {}, signal, onLog = async () => {},
  queryFn, timeoutMs = ISOLATED_HOOK_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const abortReason = () => signal?.reason instanceof Error ? signal.reason : new Error('Hook task was aborted');
  if (signal?.aborted) throw abortReason();
  const runQuery = queryFn || (await import('@anthropic-ai/claude-agent-sdk')).query;
  let iterator;
  let closed = false;
  const close = () => {
    if (!iterator || closed) return;
    closed = true;
    try {
      Promise.resolve(typeof iterator.close === 'function' ? iterator.close() : iterator.return?.()).catch(() => {});
    } catch { /* Best effort. */ }
  };
  let rejectAbort;
  const interruption = new Promise((_, reject) => { rejectAbort = reject; });
  const interrupt = (error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    close();
    rejectAbort(error);
  };
  const onAbort = () => interrupt(abortReason());
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => interrupt(new Error('Independent Hook task timed out')),
    Math.min(Math.max(1, timeoutMs), ISOLATED_HOOK_TIMEOUT_MS));
  const consume = async () => {
    iterator = await runQuery({ prompt, options: isolatedOptions(sdkOptions, controller) });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      let result;
      let text = '';
      for await (const message of iterator) {
        if (message.type === 'assistant') {
          const blocks = message.message?.content || [];
          text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').slice(0, 32_000) || text;
          await onLog('独立 Hook 任务', { content: blocks });
        }
        if (message.type === 'user') await onLog('独立 Hook 工具结果', { content: message.message?.content });
        if (message.type === 'result') {
          if (message.is_error || message.subtype !== 'success') throw new Error('Independent Hook task failed');
          result = { executed: true, executionMode: 'isolated', sessionId: message.session_id || null,
            result: (message.result || text).slice(0, 32_000), usage: message.usage || null };
        }
      }
      if (!result) throw new Error('Independent Hook task ended without a result');
      return result;
    } finally { close(); }
  };
  try { return await Promise.race([consume(), interruption]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); close(); }
}
