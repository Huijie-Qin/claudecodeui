// Isolated CCUI + deterministic Anthropic endpoint; every Agent/Bash/Hook event
// still comes from the installed Claude CLI and the application's real SDK path.
// Source: tsx --tsconfig server/tsconfig.json scripts/hook-subagents-e2e.mjs --serve
// Built: HOOK_SUBAGENTS_E2E_DIST=1 node scripts/hook-subagents-e2e.mjs --serve
// Add --smoke to run a real main agent and two child agents before browser QA.
// --serve reuses its last isolated database after a restart; --fresh resets QA.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import express from 'express';
import bcrypt from 'bcrypt';
import { TWENTY_MINUTES_MS, createMcpLoopDemoTaskServer } from './mcp-loop-demo-task-service.mjs';
import { createMcpLoopDemoMcpServer } from './mcp-loop-demo-mcp.mjs';
import { findTaskResult } from './hook-subagents-fixture-payload.mjs';

const moduleRoot = process.env.HOOK_SUBAGENTS_E2E_DIST === '1' ? '../dist-server/server/' : '../server/';
const appImport = (name) => import(new URL(`${moduleRoot}${name}`, import.meta.url));
// Load .env first: its override behavior must never restore real data paths.
await appImport('load-env.js');
const storage = path.resolve(process.env.HOOK_SUBAGENTS_E2E_ROOT || '.tmp');
await fs.mkdir(storage, { recursive: true });
const serve = process.argv.includes('--serve');
let priorState;
if (serve && !process.argv.includes('--fresh')) {
  try { priorState = JSON.parse(await fs.readFile(path.join(storage, 'hook-subagents-latest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const root = priorState?.root || await fs.mkdtemp(path.join(storage, 'ccui-hook-subagents-'));
assert.ok(root.startsWith(`${storage}${path.sep}ccui-hook-subagents-`), 'Reused fixture root must stay inside isolated storage');
const port = Number(process.env.HOOK_SUBAGENTS_E2E_PORT || 3911);
const modelPort = Number(process.env.HOOK_SUBAGENTS_E2E_MODEL_PORT || 3912);
const smoke = process.argv.includes('--smoke');
const loopDemoEnabled = process.env.HOOK_SUBAGENTS_E2E_LOOP_DEMO === '1'
  || await fs.access(path.join(root, 'enable-loop20-demo')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
const loopTaskUrl = 'http://127.0.0.1:40140';
// A container's own hostname resolves locally for both Node and the Claude CLI.
// It also avoids the normal preset-probe loopback -> host.docker.internal rewrite.
const loopMcpUrl = `http://${process.env.HOOK_SUBAGENTS_E2E_MCP_HOSTNAME || hostname()}:40141/mcp`;
const loopPresetName = 'qa_subagent_loop20';
const loopStatusTool = `mcp__${loopPresetName}__get_task_status`;
const loopExecuteTool = `mcp__${loopPresetName}__execute_task`;
const modelUrl = `http://127.0.0.1:${modelPort}`;
const base = `http://127.0.0.1:${port}`;
const password = 'Subagent-QA-only-20260910';
const correctionMarker = 'HOOK_SUBAGENTS_FIX_REQUIRED';
// The history provider reads runtimeHome/.claude/projects. Keep the fixture's
// local CLI configuration in the same isolated home for its seeded workspace.
const configDirectoryFor = (username) => path.join(root, 'runtimes', 'claude', 'hook-subagents-qa', username, 'hook-subagents-qa', 'home', '.claude');
const requests = priorState
  ? (await fs.readFile(path.join(root, 'model-requests.jsonl'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const sdkMessages = [];
let database;
let state;
let loopTaskServer;
let loopMcpServer;

if (loopDemoEnabled) {
  // No injected clock and no duration override: browser acceptance waits for the
  // real service's entire twenty-minute interval after execute_task submits it.
  loopTaskServer = createMcpLoopDemoTaskServer({ durationMs: TWENTY_MINUTES_MS });
  loopMcpServer = createMcpLoopDemoMcpServer({ taskServiceUrl: loopTaskUrl });
  for (const [server, listenPort] of [[loopTaskServer, 40140], [loopMcpServer, 40141]]) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, server === loopMcpServer ? '0.0.0.0' : '127.0.0.1', resolve);
    });
  }
}

for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[name];
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'auth.db'),
  WORKSPACES_ROOT: path.join(root, 'workspaces'),
  CLOUDCLI_RUNTIME_ROOT: path.join(root, 'runtimes'),
  CLOUDCLI_DATA_ROOT: path.join(root, 'data'),
  CLOUDCLI_MCP_HELPER_ROOT: path.join(root, 'mcp-helper-scripts'),
  CLOUDCLI_HOOK_SKILLS_ROOT: path.join(root, 'hook-skills'),
  CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: path.join(root, 'agent-template-assets'),
  CLAUDE_CONFIG_DIR: configDirectoryFor('subagent-qa-admin'),
  CLAUDE_EXECUTION_MODE: 'local',
  ANTHROPIC_BASE_URL: modelUrl,
  ANTHROPIC_API_KEY: 'qa-local-subagents-fixture-only',
  ANTHROPIC_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-6',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  NO_PROXY: '127.0.0.1,localhost',
  VITE_IS_PLATFORM: 'false',
  SERVER_PORT: String(port),
  HOST: process.env.HOOK_SUBAGENTS_E2E_HOST || '127.0.0.1',
  API_KEY: '',
  CODEHUB_MCP_URL: '',
  SKILL_MARKET_AUTH_APPID: '',
  SKILL_MARKET_AUTH_KEY: '',
  SKILL_MARKET_BASE_URL: modelUrl,
});
if (!process.env.CLAUDE_CLI_PATH) {
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
  try {
    process.env.CLAUDE_CLI_PATH = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  } catch { /* mapCliOptionsToSDK uses an installed claude on PATH otherwise. */ }
}
await fs.writeFile(process.env.DATABASE_PATH, '', { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
await fs.mkdir(process.env.WORKSPACES_ROOT, { recursive: true });
await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
// Preserve genuine JSONL evidence from fixtures started before the canonical
// runtime location was used. Existing/newer destination files remain intact.
if (priorState) {
  const legacyProjects = path.join(root, 'claude-config', 'projects');
  try {
    await fs.access(legacyProjects);
    await fs.cp(legacyProjects, path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), {
      recursive: true, force: false, errorOnExist: false, preserveTimestamps: true,
    });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function textBlocks(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

function nextLoopResponse({ tools, messages, child, actor, run, usedId, tool }) {
  const results = messages.filter((message) => message.role === 'user')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_result');
  const resultFor = (suffix) => results.find((block) => block.tool_use_id === `toolu_${run}_${actor}_${suffix}`);
  const final = (phase, text, details = {}) => ({ actor, run, phase, correctionSeen: false, content: [{ type: 'text', text }], ...details });
  if (!child) {
    if (!usedId('spawn-A') && (tools.has('Agent') || tools.has('Task'))) {
      return { actor, run, phase: 'loop-spawn-child', correctionSeen: false, content: [tool('spawn-A', tools.has('Agent') ? 'Agent' : 'Task', {
        description: 'Wait for a real twenty-minute task', subagent_type: 'general-purpose', run_in_background: false,
        prompt: `FIXTURE_CHILD_ROLE=A RUN=${run}. Use the ${loopExecuteTool} MCP tool exactly once to submit a task. Read task_id from its real result and call ${loopStatusTool} exactly once with that ID. A PostToolUse hook will poll until the remote task completes and replace that tool result. Finish by reporting the status and task_id you actually observed in the get_task_status result. Do not use Bash to simulate either tool and do not repeat the status tool yourself.`,
      })] };
    }
    const childResult = JSON.stringify(resultFor('spawn-A') || {});
    const taskId = childResult.match(/TASK_ID=([a-zA-Z0-9_-]+)/)?.[1] || 'unknown';
    const observedStatus = childResult.match(/STATUS=(success|running|failed)/)?.[1] || 'unknown';
    return final('loop-complete', `HOOK_SUBAGENTS_LOOP_DONE RUN=${run} ACTOR=main TASK_ID=${taskId} STATUS=${observedStatus}`, { taskId, observedStatus });
  }
  const executeName = [...tools].find((name) => name === loopExecuteTool);
  const statusName = [...tools].find((name) => name === loopStatusTool);
  if ((!executeName || !statusName) && tools.has('ToolSearch') && !usedId('discover')) {
    return { actor, run, phase: 'loop-discover-tools', correctionSeen: false, content: [tool('discover', 'ToolSearch', { query: `select:${loopExecuteTool},${loopStatusTool}`, max_results: 2 })] };
  }
  if (!usedId('execute')) {
    if (!executeName) return final('loop-error', `FIXTURE_ERROR RUN=${run} missing real MCP execute_task tool`);
    return { actor, run, phase: 'loop-execute-task', correctionSeen: false, content: [tool('execute', executeName, {})] };
  }
  const submitted = findTaskResult(resultFor('execute'));
  if (!submitted) return final('loop-error', `FIXTURE_ERROR RUN=${run} execute_task did not return a task_id and status`);
  if (!usedId('status')) {
    if (!statusName) return final('loop-error', `FIXTURE_ERROR RUN=${run} missing real MCP get_task_status tool`);
    return { actor, run, phase: 'loop-get-task-status', correctionSeen: false, taskId: submitted.task_id, content: [tool('status', statusName, { task_id: submitted.task_id })] };
  }
  const observed = findTaskResult(resultFor('status'));
  const observedStatus = observed?.status || 'unknown';
  const taskId = observed?.task_id || submitted.task_id;
  return final('loop-complete', `HOOK_SUBAGENTS_LOOP_DONE RUN=${run} ACTOR=${actor} TASK_ID=${taskId} STATUS=${observedStatus}`, { taskId, observedStatus });
}

function nextResponse(body) {
  const tools = new Set((body.tools || []).map((tool) => tool.name));
  const messages = body.messages || [];
  const directUserText = messages.filter((message) => message.role === 'user').map(textBlocks).join('\n');
  const child = [...directUserText.matchAll(/FIXTURE_CHILD_ROLE=([AB])/g)].at(-1)?.[1];
  const actor = child ? `child-${child}` : 'main';
  const run = [...directUserText.matchAll(/RUN=([a-zA-Z0-9_-]+)/g)].at(-1)?.[1] || 'browser';
  // Child prompt text is separate from parent Agent input/tool-result blocks.
  const used = messages.filter((message) => message.role === 'assistant')
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === 'tool_use');
  const usedId = (suffix) => used.some((block) => block.id === `toolu_${run}_${actor}_${suffix}`);
  const tool = (suffix, name, input) => ({ type: 'tool_use', id: `toolu_${run}_${actor}_${suffix}`, name, input });
  const bash = (suffix) => tool(suffix, 'Bash', {
    command: `printf 'HOOK_SUBAGENTS_${run}_${actor}_${suffix}\\n'`,
    description: `Local fixture ${actor} ${suffix}`,
  });
  const history = JSON.stringify(messages);
  const correctionSeen = history.includes(correctionMarker);
  if (loopDemoEnabled && run.startsWith('loop20') && tools.has('Bash')) {
    return nextLoopResponse({ tools, messages, child, actor, run, usedId, tool });
  }
  let phase;
  let content;
  if (!tools.has('Bash')) {
    phase = 'auxiliary';
    content = [{ type: 'text', text: 'Hook subagent verification' }];
  } else if (!usedId('bash')) {
    phase = 'bash';
    content = [bash('bash')];
  } else if (!child && !usedId('spawn-A') && (tools.has('Agent') || tools.has('Task'))) {
    phase = 'spawn-children';
    content = ['A', 'B'].map((label) => tool(`spawn-${label}`, tools.has('Agent') ? 'Agent' : 'Task', {
      description: `Fixture child ${label}`,
      subagent_type: 'general-purpose',
      run_in_background: false,
      prompt: `FIXTURE_CHILD_ROLE=${label} RUN=${run}. Run the harmless Bash fixture command, then finish. If a Stop hook requests a correction, run one correction Bash command and finish with FIXTURE_CORRECTED.`,
    }));
  } else if (correctionSeen && !usedId('correction')) {
    phase = 'correction';
    content = [bash('correction')];
  } else {
    phase = usedId('correction') ? 'corrected' : 'complete';
    content = [{ type: 'text', text: `HOOK_SUBAGENTS_DONE RUN=${run} ACTOR=${actor}${phase === 'corrected' ? ' FIXTURE_CORRECTED' : ''}` }];
  }
  return { actor, run, phase, correctionSeen, content };
}

function jsonColumns(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!key.endsWith('_json') || typeof value !== 'string') return [key, value];
    try { return [key.slice(0, -5), JSON.parse(value)]; } catch { return [key, value]; }
  }));
}

function evidence() {
  const table = (name) => database ? database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(jsonColumns) : [];
  const optionalTable = (name) => database?.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) ? table(name) : [];
  return {
    state,
    modelRequests: requests,
    sdkMessages,
    hooks: table('hooks'),
    hookVersions: table('hook_published_versions'),
    hookExecutions: table('hook_executions'),
    hookDataRecords: table('hook_data_records'),
    workspaceAssignments: table('workspace_hook_assignments'),
    userPreferences: table('user_workspace_hook_preferences'),
    ...(loopDemoEnabled ? { loopDemo: {
      taskService: { ...loopTaskServer.demoState, tasks: [...loopTaskServer.demoState.tasks.values()] },
      mcp: loopMcpServer.demoState,
      jobs: optionalTable('mcp_loop_jobs'),
      attempts: optionalTable('mcp_loop_attempts'),
    } } : {}),
  };
}
const fixture = express();
fixture.use(express.json({ limit: '30mb' }));
fixture.get('/evidence', (_req, res) => res.json(evidence()));
fixture.get('/state', (_req, res) => res.json(state || { root, starting: true }));
fixture.post('/v1/messages/count_tokens', (_req, res) => res.json({ input_tokens: 100 }));
fixture.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const response = nextResponse(body);
  const entry = { index: requests.length + 1, at: new Date().toISOString(), ...response, request: body };
  requests.push(entry);
  await fs.appendFile(path.join(root, 'model-requests.jsonl'), `${JSON.stringify(entry)}\n`);
  console.log(`FIXTURE MODEL ${entry.index} RUN=${response.run} ${response.actor} ${response.phase}`);
  const stopReason = response.content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const message = { id: `msg_hook_subagents_${entry.index}`, type: 'message', role: 'assistant', model: body.model, content: response.content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } };
  if (!body.stream) return res.json(message);
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  response.content.forEach((block, index) => {
    emit('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    emit('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    emit('content_block_stop', { index });
  });
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 30 } });
  emit('message_stop', {});
  res.end();
});
// No fixture application API: these are only model-provider and read-only routes.
fixture.use((_req, res) => res.status(404).json({ error: 'No fixture route' }));
const modelServer = http.createServer(fixture);
await new Promise((resolve, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(modelPort, process.env.HOOK_SUBAGENTS_E2E_HOST || '127.0.0.1', resolve);
});

const { db, userDb, initializeDatabase } = await appImport('database/db.js');
database = db;
await initializeDatabase();
const { multitenancyDb } = await appImport('database/multitenancy-db.js');
const { generateToken } = await appImport('middleware/auth.js');
const fixtureCredentials = { ANTHROPIC_BASE_URL: modelUrl, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: 'claude-sonnet-4-6' };
const admin = userDb.getUserByUsername('subagent-qa-admin') || userDb.createUser('subagent-qa-admin', await bcrypt.hash(password, 4), { isSystemAdmin: true, env: fixtureCredentials });
const member = userDb.getUserByUsername('subagent-qa-member') || userDb.createUser('subagent-qa-member', await bcrypt.hash(password, 4), { env: fixtureCredentials });
for (const user of [admin, member]) {
  const configDirectory = configDirectoryFor(user.username);
  await fs.mkdir(configDirectory, { recursive: true });
  userDb.updateClaudeEnvForUsers({ userIds: [user.id], env: { CLAUDE_CONFIG_DIR: configDirectory } });
}
const tenant = priorState ? { id: priorState.tenantId } : multitenancyDb.tenants.createTenant({ code: 'hook-subagents-qa', name: 'Hook 子代理验收' });
for (const user of [admin, member]) multitenancyDb.memberships.upsertMembership({ tenantId: tenant.id, userId: user.id, role: user.id === admin.id ? 'admin' : 'member', permission: 'edit', status: 'active' });
const token = generateToken(admin);
await appImport('index.js');
async function request(route, options = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method: options.method || 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json();
  assert.equal(response.status, options.status || 200, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { await request('/auth/status'); break; } catch (error) {
    if (attempt === 99) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const workspace = priorState?.workspace || (await request(`/projects/create-workspace?tenantId=${tenant.id}`, { method: 'POST', body: { workspaceType: 'new', path: 'hook-subagents-qa' } })).project;
multitenancyDb.workspaceAcl.replaceAcl({ workspaceId: workspace.workspaceId, ownerUserId: admin.id, entries: [{ userId: member.id, permission: 'edit' }] });
assert.ok(workspace.path.startsWith(`${root}${path.sep}`), 'Workspace must be inside isolated fixture root');
let loopDemo;
if (loopDemoEnabled) {
  const tenantBody = { tenantId: tenant.id };
  const presetInput = { ...tenantBody, name: loopPresetName, displayName: '子代理20分钟任务 MCP', description: 'Real execute_task and get_task_status on an isolated twenty-minute service', config: { type: 'http', url: loopMcpUrl, alwaysLoad: true } };
  const presets = (await request(`/admin/mcp-presets?tenantId=${tenant.id}`)).presets;
  let preset = presets.find((item) => item.name === loopPresetName);
  if (!preset) preset = (await request('/admin/mcp-presets', { method: 'POST', status: 201, body: presetInput })).preset;
  else if (preset.config.url !== loopMcpUrl) preset = (await request(`/admin/mcp-presets/${preset.id}`, { method: 'PUT', body: presetInput })).preset;
  const probe = await request(`/admin/mcp-presets/${preset.id}/test`, { method: 'POST', body: tenantBody });
  assert.equal(probe.preset.toolCount, 2);
  if (preset.status !== 'published') preset = (await request(`/admin/mcp-presets/${preset.id}/publish`, { method: 'POST', body: tenantBody })).preset;
  await request(`/workspaces/${workspace.workspaceId}/mcp-tools/${preset.id}/install?tenantId=${tenant.id}`, { method: 'POST', status: 201 });
  const { hookMcpCatalogService } = await appImport('services/hook-mcp-catalog.js');
  const existingHookServer = hookMcpCatalogService.getServerByName(loopPresetName);
  if (!existingHookServer) {
    await request('/admin/hooks/mcp-servers', { method: 'POST', status: 201, body: presetInput });
  } else if (existingHookServer.config.url !== loopMcpUrl) {
    await request(`/admin/hooks/mcp-servers/${loopPresetName}`, { method: 'PUT', body: presetInput });
  }
  const hookProbe = await request(`/admin/hooks/mcp-servers/${loopPresetName}/test`, { method: 'POST', body: tenantBody });
  assert.equal(hookProbe.server.toolCount, 2);
  loopDemo = {
    taskUrl: loopTaskUrl, mcpUrl: loopMcpUrl, durationMs: TWENTY_MINUTES_MS,
    presetId: preset.id, hookMcpServerId: hookProbe.server.id,
    executeToolName: loopExecuteTool, statusToolName: loopStatusTool,
    prompt: 'HOOK_SUBAGENTS_E2E RUN=loop20_browser. Delegate to one child agent. It must submit a real task with execute_task, then call get_task_status exactly once using the returned task_id. Wait for the Hook to replace the initial running result after twenty minutes, and report the actual final status and task_id.',
    hookExample: {
      name: 'E2E 子代理等待20分钟任务', eventName: 'PostToolUse', includeSubagents: true,
      matcher: { mode: 'exact', value: loopStatusTool }, extensionLogic: null,
      postActions: [{ id: 'wait-twenty-minute-task', type: 'mcp_loop_run', position: 0, config: {
        pollIntervalMs: 10_000, perCallTimeoutMs: 15_000, maxWaitMs: 3_600_000,
        terminationScript: 'async def run(event, ccui):\n    status = (event.get("result") or {}).get("status")\n    if status in ("success", "failed"):\n        return {"output": {"status": status}}\n    return {"output": {"status": "running"}}\n',
        waitingLabel: '等待子代理20分钟任务',
      } }], claudeResponse: { bindings: {} },
    },
  };
}
const hookScript = `export async function run(event, ccui) {
  const child = Boolean(event.agent_id);
  const retry = child && !String(event.last_assistant_message || '').includes('FIXTURE_CORRECTED');
  await ccui.records.write('subagent-e2e', { eventName: event.hook_event_name, agentId: event.agent_id || null, toolName: event.tool_name || null, command: event.tool_input?.command || null, retry });
  return { output: { decision: retry ? 'block' : 'approve', reason: retry ? '${correctionMarker}: run your correction Bash command then finish with FIXTURE_CORRECTED.' : 'Fixture validation passed.' } };
}`;
state = {
  root, base, modelUrl, evidenceUrl: `${modelUrl}/evidence`, databasePath: process.env.DATABASE_PATH, claudeConfigDirectory: process.env.CLAUDE_CONFIG_DIR,
  admin: { id: admin.id, username: admin.username }, member: { id: member.id, username: member.username },
  password, tenantId: tenant.id, workspace,
  ...(loopDemo ? { loopDemo } : {}),
  prompt: 'HOOK_SUBAGENTS_E2E RUN=ui_off. Run the main Bash check and two child agents, each with its own Bash check, and finish.',
  hookExample: { name: 'QA Stop 子代理', eventName: 'Stop', includeSubagents: false, matcher: {}, activationScope: 'all_users', extensionLogic: { language: 'javascript', code: hookScript, outputs: [{ name: 'decision', type: 'string' }, { name: 'reason', type: 'string' }] }, postActions: [], claudeResponse: { bindings: { decision: { source: 'reference', path: 'script.output.decision' }, reason: { source: 'reference', path: 'script.output.reason' } } } },
};
await fs.writeFile(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
await fs.writeFile(path.join(storage, 'hook-subagents-latest.json'), `${JSON.stringify(state, null, 2)}\n`);
console.log(`HOOK_SUBAGENTS_E2E_READY ${base}/admin login=${admin.username} password=${password} workspace=${workspace.workspaceId} tenant=${tenant.id} evidence=${modelUrl}/evidence root=${root}`);

if (smoke && !priorState) {
  const { queryClaudeSDK, abortClaudeSDKSession } = await appImport('claude-sdk.js');
  let timer;
  try {
    await Promise.race([
      queryClaudeSDK(state.prompt.replace('RUN=ui_off', 'RUN=smoke'), {
        cwd: workspace.path, projectPath: workspace.path, tenantId: tenant.id, userId: admin.id,
        workspaceId: workspace.workspaceId, model: 'claude-sonnet-4-6',
      }, { userId: admin.id, isConnected: () => true, send: (message) => sdkMessages.push(typeof message === 'string' ? JSON.parse(message) : message) }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Real SDK smoke exceeded 120 seconds')), 120_000); }),
    ]);
    assert.ok(sdkMessages.some((message) => message.kind === 'complete' && message.success), JSON.stringify(sdkMessages.slice(-5)));
    for (const actor of ['main', 'child-A', 'child-B']) {
      assert.ok(requests.some((item) => item.run === 'smoke' && item.actor === actor && item.phase === 'bash'), `Missing real ${actor} Bash request`);
      assert.ok(requests.some((item) => item.run === 'smoke' && item.actor === actor && ['complete', 'corrected'].includes(item.phase)), `Missing real ${actor} completion`);
    }
    console.log('HOOK_SUBAGENTS_E2E_SMOKE_PASSED main + two real child agent Bash calls and completions');
  } finally {
    clearTimeout(timer);
    const sessionId = sdkMessages.find((message) => message.sessionId)?.sessionId;
    if (sessionId) await abortClaudeSDKSession(sessionId);
    await fs.writeFile(path.join(root, 'smoke-evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`);
  }
}
if (!serve) {
  await fs.writeFile(path.join(root, 'evidence.json'), `${JSON.stringify(evidence(), null, 2)}\n`);
  process.exit(0);
}
