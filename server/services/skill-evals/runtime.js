import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { CLAUDE_MODELS } from '../../../shared/modelConstants.js';

import { fail, redact } from './contracts.js';
import { writeTree } from './files.js';

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
export function buildSandboxArgs({ id, image, projection, jobId }) {
  return ['run', '-d', '--pull=never', '--name', id, '--label', 'cloudcli.skill-eval=true',
    ...(jobId ? ['--label', `cloudcli.eval-job=${jobId}`] : []),
    '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=128', '--memory=512m', '--cpus=1', '--user=1000:1000',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--tmpfs=/work:rw,nosuid,nodev,size=128m,mode=1777',
    '--mount', `type=bind,src=${projection},dst=/skill,readonly`,
    '--tmpfs=/output:rw,nosuid,nodev,size=50m,mode=1777', '-w', '/work', image, 'sleep', 'infinity'];
}

export function createEvaluationRuntime({ resolveEnvironment, runQuery, docker = process.env.DOCKER_CLI_PATH || 'docker', image = process.env.SKILL_EVAL_IMAGE, command = exec } = {}) {
  async function profile(scope) {
    const resolved = await resolveEnvironment(scope);
    const auth = Object.fromEntries(AUTH_KEYS.filter((k) => typeof resolved[k] === 'string').map((k) => [k, resolved[k]]));
    if (!auth.ANTHROPIC_API_KEY && !auth.ANTHROPIC_AUTH_TOKEN) throw fail('Configure Claude API credentials for evaluations', 'EVAL_AUTH_UNAVAILABLE', 503);
    return { auth, model: auth.ANTHROPIC_MODEL || CLAUDE_MODELS.DEFAULT };
  }
  async function preflight(scope) {
    if (!image) throw fail('Set SKILL_EVAL_IMAGE to a locally installed sandbox image with sh, sleep and /usr/bin/python3', 'EVAL_RUNTIME_UNAVAILABLE', 503);
    await profile(scope);
    try {
      await command(docker, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10000, maxBuffer: 4096 });
      const { stdout } = await command(docker, ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 10000, maxBuffer: 4096 });
      return { image: stdout.trim(), model: (await profile(scope)).model, kind: 'sdk-broker-docker-network-none-v1' };
    } catch { throw fail('The evaluation Docker daemon/image is unavailable', 'EVAL_RUNTIME_UNAVAILABLE', 503); }
  }
  async function modelCall({ scope, prompt, systemPrompt, signal, tools = [], onText = () => {}, budget, model, outputSchema }) {
    if (signal?.aborted) throw signal.reason || fail('Cancelled');
    if (budget.remainingUsd <= 0 || budget.calls >= 1500) throw fail('Model budget exhausted', 'EVAL_LIMIT_EXCEEDED');
    budget.calls++;
    const reserved = Math.min(2, budget.remainingUsd);
    budget.remainingUsd -= reserved;
    const { auth, model: defaultModel } = await profile(scope);
    const home = await fs.mkdtemp(path.join(os.tmpdir(), `ccui-eval-model-${scope.id || 'standalone'}-`));
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(fail('Model request timed out', 'EVAL_TIMEOUT')), 300000);
    let query;
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const queryFn = runQuery || sdk.query;
      const toolNames = tools.map((t) => `mcp__evaluation__${t.name}`);
      const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...auth,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: home };
      // Model process has zero native filesystem/shell/Agent tools. All execution is brokered below.
      const input = tools.length ? (async function* () { yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }; })() : prompt;
      query = queryFn({ prompt: input, options: {
        cwd: home, env, executable: 'node', tools: [], settingSources: [], plugins: [],
        persistSession: false, permissionMode: 'dontAsk', allowedTools: toolNames,
        canUseTool: async (name, input) => toolNames.includes(name)
          ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Tool unavailable in evaluations' },
        mcpServers: tools.length ? { evaluation: sdk.createSdkMcpServer({ name: 'evaluation', version: '1.0.0', tools }) } : {},
        model: model || defaultModel, systemPrompt, maxTurns: 24, maxBudgetUsd: reserved,
        abortController: controller, includePartialMessages: false,
        ...(outputSchema ? { outputFormat: { type: 'json_schema', schema: outputSchema } } : {}),
        spawnClaudeCodeProcess: (options) => spawn(options.command === 'node' ? process.execPath : options.command, options.args, {
          cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal,
        }),
      } });
      let text = '', result = null;
      for await (const event of query) {
        if (controller.signal.aborted) throw controller.signal.reason || fail('Cancelled');
        if (event.type === 'assistant') {
          const chunk = (event.message?.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          if (chunk) { text = chunk; await onText(chunk); }
        }
        if (event.type === 'result') result = event;
      }
      if (!result || result.is_error || result.subtype !== 'success') throw fail('Model execution did not complete successfully', 'EVAL_MODEL_ERROR');
      const cost = result.total_cost_usd;
      if (typeof cost === 'number' && Number.isFinite(cost)) { budget.remainingUsd += reserved - cost; budget.costUsd += cost; }
      else throw fail('Model usage is unavailable; stopping to enforce the job budget', 'EVAL_USAGE_UNAVAILABLE');
      if (budget.remainingUsd < 0) throw fail('Model budget exhausted', 'EVAL_LIMIT_EXCEEDED');
      return { text: result.result || text, structured: result.structured_output, model: model || defaultModel };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      query?.close?.();
      await fs.rm(home, { recursive: true, force: true });
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
    const timer = setTimeout(() => controller.abort(fail('Case timed out', 'EVAL_TIMEOUT')), 300000);
    let count = 0, size = 0, created = false;
    function emit(event) {
      const sanitize = (value) => typeof value === 'string' ? redact(value) : Array.isArray(value) ? value.map(sanitize)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)])) : value;
      const safe = sanitize(event);
      size += Buffer.byteLength(JSON.stringify(safe));
      if (size > 10 * 1024 * 1024) throw fail('Evidence limit exceeded', 'EVAL_LIMIT_EXCEEDED');
      const record = { ...safe, id: `message:${events.length + 1}`, seq: events.length + 1, at: new Date().toISOString() };
      events.push(record); onEvent(record); return record;
    }
    const makeTools = (parent = null, depth = 0) => {
      const shell = tool('shell', 'Run a shell command in the offline test container. Skill files: /skill (read only). Inputs under /skill/evals/files. Write deliverables to /output. No external network or production tools.', { command: z.string().min(1).max(16000) }, async ({ command: script }) => {
        if (++count > 32) { controller.abort(fail('Tool call limit exceeded', 'EVAL_LIMIT_EXCEEDED')); throw controller.signal.reason; }
        const call = emit({ role: 'tool', kind: 'tool_use', tool: 'shell', input: script, parent });
        try {
          const result = await command(docker, ['exec', id, 'sh', '-lc', script], { signal: controller.signal, timeout: 60000, maxBuffer: 1024 * 1024 });
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
        if (++count > 32) { controller.abort(fail('Tool call limit exceeded', 'EVAL_LIMIT_EXCEEDED')); throw controller.signal.reason; }
        const started = emit({ role: 'assistant', kind: 'task_started', text: task, parent });
        try {
          const result = await modelCall({ scope, prompt: task, signal: controller.signal, budget, model: runtimeProfile.model,
            systemPrompt: 'Complete only this delegated test task. Use evaluation shell for all file operations. Read skill instructions at /skill/SKILL.md. No external network. Output files under /output.',
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
      created = true; // Even a CLI timeout may leave a started container that needs cleanup.
      await command(docker, buildSandboxArgs({ id, image: runtimeProfile.image, projection, jobId: scope.id }), { timeout: 15000, maxBuffer: 4096 });
      emit({ role: 'user', kind: 'text', text: testCase.prompt });
      result = await modelCall({ scope, prompt: testCase.prompt, signal: controller.signal, budget, model: runtimeProfile.model,
        systemPrompt: `Execute this task using the following skill. Use only evaluation.shell for file/command operations and evaluation.delegate for subagents. Skill resources are at /skill; test inputs: ${JSON.stringify(testCase.files || [])}. Save final files under /output. Network and production tools are unavailable. Do not simulate external results.\n\n${Buffer.from(files['SKILL.md'], 'base64').toString('utf8')}`,
        tools: makeTools(), onText: (text) => emit({ role: 'assistant', kind: 'text', text }) });
      if (controller.signal.aborted) throw controller.signal.reason;
      const processes = await command(docker, ['top', id, '-eo', 'pid,comm'], { timeout: 10000, maxBuffer: 16000 });
      if (processes.stdout.trim().split('\n').length > 2) throw fail('Background processes are still running; artifacts are not complete', 'EVAL_BACKGROUND_ACTIVE');
      // Outputs live in a bounded container tmpfs; never grant generated code a writable host mount.
      const collected = await command(docker, ['exec', id, '/usr/bin/python3', '-I', '-c', COLLECT_ARTIFACTS], { signal: controller.signal, timeout: 15000, maxBuffer: 72 * 1024 * 1024 });
      const artifacts = JSON.parse(collected.stdout);
      await command(docker, ['stop', '-t', '0', id], { timeout: 15000, maxBuffer: 4096 });
      return { events, artifacts, finalText: result.text, complete: true };
    } catch (error) {
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
  return { preflight, modelCall, runCase, cleanupJob };
}
