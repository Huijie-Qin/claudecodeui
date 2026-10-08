import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CLAUDE_MODELS } from '../../../shared/modelConstants.js';

import { fail, redact } from './contracts.js';
import { writeTree } from './files.js';
import { createSandboxImageManager, resolveEvaluationSandboxConfig } from './sandbox-image.js';
import { NATIVE_CASE_TOOLS, prepareEvaluationSession, readEvaluationMcpConfig } from './session-container.js';
import { interruptionError, timeoutError, timeoutSetting } from './interruption.js';

const COLLECT_ARTIFACTS = `
import os, stat, json, base64
files = {}; total = 0
for directory, dirs, names in os.walk('/output', followlinks=False):
    if len(directory.split('/')) > 23: raise ValueError('Artifact nesting limit')
    for name in dirs + names:
        full = os.path.join(directory, name)
        mode = os.lstat(full).st_mode
        if not stat.S_ISDIR(mode) and not stat.S_ISREG(mode): raise ValueError('Unsafe artifact')
    for name in names:
        full = os.path.join(directory, name)
        with open(full, 'rb') as handle: data = handle.read(5 * 1024 * 1024 + 1)
        total += len(data)
        if len(data) > 5 * 1024 * 1024 or total > 50 * 1024 * 1024 or len(files) >= 500: raise ValueError('Artifact limit')
        files[os.path.relpath(full, '/output')] = base64.b64encode(data).decode('ascii')
print(json.dumps(files))
`;
const exec = promisify(execFile);
const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'];

export function createEvaluationRuntime({ resolveEnvironment, resolveSessionEnvironment, runQuery, env = process.env,
  docker = resolveEvaluationSandboxConfig(env).docker, image = resolveEvaluationSandboxConfig(env).image,
  autoBuild = resolveEvaluationSandboxConfig(env).autoBuild,
  autoPull = resolveEvaluationSandboxConfig(env).autoPull && image === resolveEvaluationSandboxConfig(env).image,
  command = exec } = {}) {
  const sandboxImage = createSandboxImageManager({ docker, image, autoBuild, autoPull, command });
  const caseTimeoutMs = timeoutSetting(env, 'SKILL_EVAL_CASE_TIMEOUT_MS', 1800000);
  const modelTimeoutMs = timeoutSetting(env, 'SKILL_EVAL_MODEL_TIMEOUT_MS', 300000);
  const configuredToolLimit = env.SKILL_EVAL_MAX_TOOL_CALLS;
  const maxToolCalls = configuredToolLimit == null || String(configuredToolLimit).trim() === '' ? 100 : Number(configuredToolLimit);
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw fail('SKILL_EVAL_MAX_TOOL_CALLS 必须是正整数（每条用例的工具调用上限）。', 'EVAL_RUNTIME_CONFIGURATION', 503);
  }
  const configuredTurnLimit = env.SKILL_EVAL_MAX_TURNS;
  const maxTurns = configuredTurnLimit == null || String(configuredTurnLimit).trim() === '' ? 100 : Number(configuredTurnLimit);
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
    throw fail('SKILL_EVAL_MAX_TURNS 必须是正整数（单次模型执行的轮次上限）。', 'EVAL_RUNTIME_CONFIGURATION', 503);
  }
  async function profile(scope) {
    const resolved = await resolveEnvironment(scope);
    const auth = Object.fromEntries(AUTH_KEYS.filter((k) => typeof resolved[k] === 'string').map((k) => [k, resolved[k]]));
    if (!auth.ANTHROPIC_API_KEY && !auth.ANTHROPIC_AUTH_TOKEN) throw fail('Configure Claude API credentials for evaluations', 'EVAL_AUTH_UNAVAILABLE', 503);
    return { auth, model: auth.ANTHROPIC_MODEL || CLAUDE_MODELS.DEFAULT };
  }
  async function preflight(scope) {
    if (!image) throw fail('请在 .env 中配置 SKILL_EVAL_IMAGE。', 'EVAL_RUNTIME_UNAVAILABLE', 503);
    const { model } = await profile(scope);
    await readEvaluationMcpConfig(scope.workspacePath);
    if (sandboxImage.preparing) throw fail('测评环境正在准备中，首次拉取或构建镜像可能需要几分钟，请稍后重试。', 'EVAL_RUNTIME_PREPARING', 503);
    return { image: await sandboxImage.ensure(), imageName: image, model, kind: 'sdk-session-docker-mcp-v2' };
  }
  async function modelCall({ scope, prompt, systemPrompt, signal, tools = [], onText = () => {}, budget, model, outputSchema, execution, onToolEvent = () => {} }) {
    if (signal?.aborted) throw interruptionError(signal);
    if (budget.calls >= 1500) throw fail('模型调用次数已达到上限', 'EVAL_LIMIT_EXCEEDED');
    budget.calls++;
    const { auth, model: defaultModel } = await profile(scope);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `ccui-eval-model-${scope.id || 'standalone'}-`));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeoutMs = execution ? caseTimeoutMs : modelTimeoutMs;
    const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs, Boolean(execution))), timeoutMs);
    let query, failure, result = null;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const queryFn = runQuery || sdk.query;
      const brokerName = execution?.brokerName || 'evaluation';
      const toolNames = tools.map((t) => `mcp__${brokerName}__${t.name}`);
      const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...auth,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: home, ...execution?.env };
      // Case execution runs inside Docker; grading and optimization retain a tool-free host model.
      const input = tools.length ? (async function* () { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }; })() : prompt;
      query = queryFn({ prompt: input, options: {
        cwd: execution?.workspace || home, env, executable: 'node', tools: execution ? NATIVE_CASE_TOOLS : [], settingSources: [], plugins: [],
        persistSession: false, permissionMode: execution ? 'default' : 'dontAsk', allowedTools: toolNames,
        disallowedTools: execution?.access.disallowedTools || [], strictMcpConfig: true,
        canUseTool: async (name, input) => toolNames.includes(name) || (execution && (NATIVE_CASE_TOOLS.includes(name)
          || (Object.keys(execution.mcpServers).some(server => name.startsWith(`mcp__${server}__`)) && execution.access.isAllowed(name))))
          ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Tool unavailable in evaluations' },
        mcpServers: { ...execution?.mcpServers, ...(tools.length ? { [brokerName]: sdk.createSdkMcpServer({ name: brokerName, version: '1.0.0', tools }) } : {}) },
        model: model || defaultModel, systemPrompt, maxTurns,
        abortController: controller, includePartialMessages: false,
        ...(outputSchema ? { outputFormat: { type: 'json_schema', schema: outputSchema } } : {}),
        ...(execution ? { pathToClaudeCodeExecutable: 'claude' } : {}),
        spawnClaudeCodeProcess: execution?.spawn || ((options) => spawn(options.command === 'node' ? process.execPath : options.command, options.args, {
          cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
        })),
      } });
      let text = '';
      for await (const event of query) {
        if (controller.signal.aborted) throw interruptionError(controller.signal);
        if (execution && ['assistant', 'user'].includes(event.type)) {
          for (const block of event.message?.content || []) {
            if (['tool_use', 'tool_result'].includes(block.type) && !toolNames.includes(block.name)) await onToolEvent(block);
          }
        }
        if (event.type === 'assistant') {
          const chunk = (event.message?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          if (chunk) { text = chunk; await onText(chunk); }
        }
        if (event.type === 'result') result = event;
      }
      if (controller.signal.aborted) throw interruptionError(controller.signal);
      const cost = result?.total_cost_usd;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        budget.costUsd += cost;
      } else {
        budget.costIncomplete = true;
      }
      if (!result || result.is_error || result.subtype !== 'success') throw fail('Model execution did not complete successfully', 'EVAL_MODEL_ERROR');
      return { text: result.result || text, structured: result.structured_output, model: model || defaultModel };
    } catch (error) {
      const reachedTurnLimit = result?.subtype === 'error_max_turns'
        || /^(?:Claude Code returned an error result:\s*)?Reached max(?:imum|inum) number of turns\b/i.test(error.message || '');
      failure = interruptionError(controller.signal, reachedTurnLimit
        ? fail(`模型执行已达到轮次上限（${maxTurns} 轮），已停止。可通过 SKILL_EVAL_MAX_TURNS 调整；此限制与工具调用次数和自动优化迭代次数分别计算。`, 'EVAL_MAX_TURNS')
        : error);
      throw failure;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { query?.close?.(); } catch (error) { if (!failure) throw error; }
      finally { await fs.rm(home, { recursive: true, force: true }); }
    }
  }
  async function runCase({ scope, files, testCase, signal, budget, runtimeProfile, onEvent = () => {} }) {
    const { tool } = await import('@anthropic-ai/claude-agent-sdk');
    const { z } = await import('zod');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), `ccui-eval-case-${scope.id || 'standalone'}-`));
    const projection = path.join(temp, 'skill');
    const id = `ccui-eval-${randomUUID()}`;
    const events = [], controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(timeoutError(caseTimeoutMs, true)), caseTimeoutMs);
    let count = 0, size = 0, created = false, execution;
    const sanitizeText = text => execution ? execution.sanitize(text) : redact(text);
    const toolCalls = new Map();
    function countToolCall() {
      if (controller.signal.aborted) throw interruptionError(controller.signal);
      if (count >= maxToolCalls) {
        controller.abort(fail(`测试用例的工具调用次数已达到上限（${maxToolCalls} 次），已停止。可通过 SKILL_EVAL_MAX_TOOL_CALLS 调整。`, 'EVAL_LIMIT_EXCEEDED'));
        throw controller.signal.reason;
      }
      count++;
    }
    function toolEvent(block, parent) {
      if (block.type === 'tool_use') {
        countToolCall();
        const event = emit({ role: 'tool', kind: 'tool_use', tool: block.name, input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2), parent });
        toolCalls.set(block.id, event.id);
      } else if (toolCalls.has(block.tool_use_id)) {
        emit({ role: 'tool', kind: 'tool_result', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          parent: toolCalls.get(block.tool_use_id), isError: block.is_error === true });
      }
    }
    function emit(event) {
      const sanitize = (value) => typeof value === 'string' ? sanitizeText(value) : Array.isArray(value) ? value.map(sanitize)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) : value;
      const safe = sanitize(event);
      size += Buffer.byteLength(JSON.stringify(safe));
      if (size > 10 * 1024 * 1024) throw fail('Evidence limit exceeded', 'EVAL_LIMIT_EXCEEDED');
      const record = { ...safe, id: `message:${events.length + 1}`, seq: events.length + 1, at: new Date().toISOString() };
      events.push(record); onEvent(record); return record;
    }
    const makeTools = (parent = null, depth = 0) => {
      const shell = tool('shell', 'Run a shell command in the isolated test container. Working directory: /workspace. Skill files: /skill (read only). Inputs under /skill/evals/files. Write deliverables to /output. Workspace MCP services and network are available; external operations have real effects.', { command: z.string().min(1).max(16000) }, async ({ command: script }) => {
        countToolCall();
        const call = emit({ role: 'tool', kind: 'tool_use', tool: 'shell', input: script, parent });
        try {
          const result = await command(docker, execution.shellArgs(script), { signal: controller.signal, timeout: 60000, maxBuffer: 1024 * 1024 });
          const text = result.stdout + result.stderr;
          emit({ role: 'tool', kind: 'tool_result', text, parent: call.id });
          return { content: [{ type: 'text', text }] };
        } catch (error) {
          if (controller.signal.aborted || error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            controller.abort(fail('Tool execution exceeded a limit', 'EVAL_TOOL_ERROR')); throw controller.signal.reason;
          }
          const text = redact(`${error.stdout || ''}\n${error.stderr || ''}\nExit: ${error.code}`);
          emit({ role: 'tool', kind: 'tool_result', text, parent: call.id, isError: true });
          return { isError: true, content: [{ type: 'text', text }] };
        }
      });
      if (depth) return [shell];
      return [shell, tool('delegate', 'Delegate a bounded subtask to a separate agent in the same test container; waits for completion. No nested delegation.', { task: z.string().min(1).max(16000) }, async ({ task }) => {
        countToolCall();
        const started = emit({ role: 'assistant', kind: 'task_started', text: task, parent });
        try {
          const result = await modelCall({ scope, prompt: task, signal: controller.signal, budget, model: runtimeProfile.model, execution, onToolEvent: block => toolEvent(block, started.id),
            systemPrompt: 'Complete only this delegated test task. Use evaluation shell for all file operations. Read skill instructions at /skill/SKILL.md. Workspace MCP tools are available with the current user permissions. External operations have real effects. Output files under /output.',
            tools: makeTools(started.id, 1), onText: (text) => emit({ role: 'assistant', kind: 'text', text, parent: started.id }) });
          emit({ role: 'assistant', kind: 'task_completed', text: result.text, parent: started.id });
          return { content: [{ type: 'text', text: result.text }] };
        } catch (error) { controller.abort(error); throw error; }
      })];
    };
    let result;
    try {
      const inputs = new Set(testCase.files || []);
      const projected = Object.fromEntries(Object.entries(files).filter(([p]) => !p.startsWith('evals/') || inputs.has(p)));
      await writeTree(projection, projected);
      // Read-only mount still needs traversable/readable modes for the unprivileged container uid.
      await command('chmod', ['-R', 'a+rX', projection], { timeout: 10000 });
      execution = await prepareEvaluationSession({ scope, temp, projection, id, image: runtimeProfile.image, sharedImage: runtimeProfile.imageName || image, docker, env,
        auth: (await profile(scope)).auth, resolvedEnvironment: await resolveSessionEnvironment?.(scope) });
      created = true; // A CLI timeout can leave a container that still needs cleanup.
      await command(docker, execution.args, { timeout: 15000, maxBuffer: 4096 });
      try {
        await command(docker, ['exec', id, 'sh', '-lc', 'command -v claude >/dev/null && test -x /usr/bin/python3'], { timeout: 10000, maxBuffer: 4096 });
      } catch { throw fail('测评镜像需要与会话镜像一样安装 Claude CLI 和 /usr/bin/python3。请检查 CLOUDCLI_CLAUDE_DOCKER_IMAGE 或移除旧的 SKILL_EVAL_IMAGE 覆盖项。', 'EVAL_RUNTIME_UNAVAILABLE', 503); }
      emit({ role: 'user', kind: 'text', text: testCase.prompt });
      result = await modelCall({ scope, prompt: testCase.prompt, signal: controller.signal, budget, model: runtimeProfile.model, execution, onToolEvent: block => toolEvent(block),
        systemPrompt: `Execute this task using the following skill. You may use native file/shell tools, the evaluation shell and delegate tools, and configured workspace MCP tools. Skill resources are at /skill; test inputs: ${JSON.stringify(testCase.files || [])}. Save final files under /output. Your working directory is /workspace, an independent temporary workspace. Workspace MCP tools and network are available with current user permissions. External operations have real effects. Do not simulate external results.\n\n${Buffer.from(files['SKILL.md'], 'base64').toString('utf8')}`,
        tools: makeTools(), onText: (text) => emit({ role: 'assistant', kind: 'text', text }) });
      if (controller.signal.aborted) throw controller.signal.reason;
      // Outputs live in a bounded container tmpfs; only /output is collected, never the temporary home or MCP credentials.
      const collected = await command(docker, ['exec', id, '/usr/bin/python3', '-I', '-c', COLLECT_ARTIFACTS], { signal: controller.signal, timeout: 15000, maxBuffer: 72 * 1024 * 1024 });
      const artifacts = JSON.parse(collected.stdout);
      await command(docker, ['stop', '-t', '0', id], { timeout: 15000, maxBuffer: 4096 });
      return { events, artifacts, finalText: sanitizeText(result.text), complete: true };
    } catch (caught) {
      const error = caught.cleanupRequired ? caught : interruptionError(controller.signal, caught);
      error.message = sanitizeText(error.message);
      error.evidence = { events, artifacts: {}, complete: false };
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (created) {
        try { await command(docker, ['rm', '-f', id], { timeout: 15000, maxBuffer: 4096 }); }
        catch { throw Object.assign(fail('Sandbox cleanup failed; the skill remains locked', 'EVAL_CLEANUP_REQUIRED'), { cleanupRequired: true }); }
      }
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  async function cleanupJob(jobId, { containers = true } = {}) {
    if (!/^[a-zA-Z0-9-]+$/.test(jobId)) throw fail('Invalid job ID');
    if (containers) {
    const { stdout } = await command(docker, ['ps', '-aq', '--filter', `label=cloudcli.eval-job=${jobId}`], { timeout: 10000, maxBuffer: 16000 });
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) await command(docker, ['rm', '-f', ...ids], { timeout: 20000, maxBuffer: 16000 });
    }
    for (const name of await fs.readdir(os.tmpdir())) {
      if ([`ccui-eval-model-${jobId}-`, `ccui-eval-case-${jobId}-`].some((prefix) => name.startsWith(prefix))) await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
    }
  }
  return { preflight, modelCall, runCase, cleanupJob,
    warmup: () => autoBuild ? sandboxImage.ensure() : Promise.resolve(),
  };
}
