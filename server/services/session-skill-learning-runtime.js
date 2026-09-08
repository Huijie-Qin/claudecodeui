const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_LENGTH = 120_000;

function runtimeError(message, code, statusCode = 502, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isAuthenticationError(error) {
  return /not logged in|please run \/login|authentication[_ ](?:error|failed)|invalid (?:api )?key|api key (?:is )?(?:missing|not found)/i
    .test([error?.message, error?.cause?.message].filter(Boolean).join('\n'));
}

function assistantText(message) {
  if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) return '';
  return message.message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * One isolated, text-only Claude call. No original session or workspace skill
 * is loaded: all material for this phase must be supplied explicitly in prompt.
 * The caller must authorize workspace access before calling this adapter.
 * Dependencies are injectable so verification does not require model calls.
 */
export async function completeSessionSkillText({
  workspacePath,
  tenantId,
  userId,
  workspaceId,
  phase = 'completion',
  systemPrompt,
  prompt,
  signal,
}, dependencies = {}) {
  if (![workspacePath, systemPrompt, prompt].every((value) => typeof value === 'string' && value.trim())) {
    throw runtimeError('Workspace path, system prompt, and prompt are required.', 'SESSION_SKILL_INVALID_REQUEST', 400);
  }
  const phaseName = String(phase).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'completion';
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw runtimeError('Model timeout must be a positive number.', 'SESSION_SKILL_INVALID_REQUEST', 400);
  }

  const abortController = new AbortController();
  let queryInstance;
  let timer;
  let onAbort;
  const execute = async () => {
    let runtimeContext;
    let runtimeManager;
    let succeeded = false;
    try {
      const runQuery = dependencies.runQuery || (await import('@anthropic-ai/claude-agent-sdk')).query;
      runtimeManager = dependencies.runtimeManager
        || (await import('./agent-session-runtime.js')).agentSessionRuntimeManager;
      const mapOptions = dependencies.mapOptions || (await import('../claude-sdk.js')).mapCliOptionsToSDK;
      if (abortController.signal.aborted) throw abortController.signal.reason;
      runtimeContext = await runtimeManager.prepareClaudeRuntime({
        tenantId,
        userId,
        workspaceId,
        cwd: workspacePath,
        projectPath: workspacePath,
      });
      if (abortController.signal.aborted) throw abortController.signal.reason;
      const sdkOptions = mapOptions({
        cwd: runtimeContext.cwd || workspacePath,
        projectPath: runtimeContext.projectPath || workspacePath,
        pathToClaudeCodeExecutable: runtimeContext.pathToClaudeCodeExecutable,
        executableArgs: runtimeContext.executableArgs,
        spawnClaudeCodeProcess: runtimeContext.spawnClaudeCodeProcess,
        executionEnv: runtimeContext.executionEnv,
        settingSources: [],
        permissionMode: 'bypassPermissions',
      });
      Object.assign(sdkOptions, {
        persistSession: false,
        includePartialMessages: false,
        maxTurns: 1,
        systemPrompt,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        settings: {
          autoMemoryEnabled: false,
          disableAllHooks: true,
          claudeMdExcludes: ['**'],
        },
        skills: [],
        agents: {},
        hooks: {},
        plugins: [],
        additionalDirectories: [],
        abortController,
        canUseTool: async () => ({ behavior: 'deny', message: 'Session skill learning is text-only.' }),
      });
      for (const key of ['resume', 'continue', 'sessionId', 'resumeSessionAt', 'forkSession', 'sessionStore']) {
        delete sdkOptions[key];
      }

      let responseText = '';
      let completed = false;
      queryInstance = runQuery({ prompt, options: sdkOptions });
      for await (const message of queryInstance) {
        if (abortController.signal.aborted) throw abortController.signal.reason;
        if (message?.type === 'result') {
          if (message.is_error || (message.subtype && message.subtype !== 'success')) {
            const errorDetails = [message.result, ...(message.errors || [])].filter(Boolean).join('\n');
            throw runtimeError(`Claude failed during skill ${phaseName}.`, 'SESSION_SKILL_MODEL_FAILED', 502, new Error(errorDetails));
          }
          completed = true;
          if (typeof message.result === 'string' && message.result.trim()) responseText = message.result;
        } else {
          const text = assistantText(message);
          if (text) responseText = text;
        }
        if (responseText.length > MAX_RESPONSE_LENGTH) {
          throw runtimeError(`Claude returned an oversized skill ${phaseName} response.`, 'SESSION_SKILL_RESPONSE_TOO_LARGE');
        }
      }
      if (!completed) {
        throw runtimeError(`Claude ended before completing skill ${phaseName}.`, 'SESSION_SKILL_INCOMPLETE_RESPONSE');
      }
      if (!responseText.trim()) {
        throw runtimeError(`Claude returned an empty skill ${phaseName} response.`, 'SESSION_SKILL_EMPTY_RESPONSE');
      }
      succeeded = true;
      return responseText.trim();
    } catch (error) {
      if (abortController.signal.aborted) throw abortController.signal.reason;
      if (isAuthenticationError(error)) {
        throw runtimeError('Claude authentication is required for session skill learning. Configure Claude credentials and retry.', 'SESSION_SKILL_AUTH_REQUIRED', 401);
      }
      if (error?.code?.startsWith('SESSION_SKILL_')) throw error;
      throw runtimeError(`Claude could not complete skill ${phaseName}. Check the configured Claude runtime and retry.`, 'SESSION_SKILL_MODEL_FAILED', 502, error);
    } finally {
      if (runtimeContext?.runtimeId) {
        if (succeeded) runtimeManager.markIdle(runtimeContext.runtimeId);
        else runtimeManager.markFailed(runtimeContext.runtimeId);
      }
    }
  };
  if (signal?.aborted) {
    throw runtimeError(`Skill ${phaseName} was cancelled.`, 'SESSION_SKILL_CANCELLED', 409);
  }
  try {
    return await Promise.race([
      execute(),
      new Promise((_, reject) => {
        const stop = (error) => {
          reject(error);
          abortController.abort(error);
          try { queryInstance?.close?.(); } catch { /* Preserve the cancellation error. */ }
        };
        onAbort = () => stop(runtimeError(`Skill ${phaseName} was cancelled.`, 'SESSION_SKILL_CANCELLED', 409));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        timer = setTimeout(() => {
          stop(runtimeError(`Claude skill ${phaseName} timed out after ${timeoutMs} ms.`, 'SESSION_SKILL_MODEL_TIMEOUT', 504));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
