// Real CCUI browser demonstration with an isolated DB and local model endpoint.
// TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx scripts/processing-loop-repro.mjs [--verify]
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import bcrypt from 'bcrypt';
import { createServer as createViteServer } from 'vite';

import { startProcessingLoopModelFixture } from './processing-loop-model-fixture.mjs';
import { createMcpLoopDemoTaskServer } from './mcp-loop-demo-task-service.mjs';
import { createMcpLoopDemoMcpServer } from './mcp-loop-demo-mcp.mjs';
import { WebSocketServer } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Cache this import before overriding settings; later application imports must
// never restore the user's live database or model endpoint from .env.
await import('../server/load-env.js');
const storage = path.join(repoRoot, '.tmp', 'processing-loop-repro');
await fs.mkdir(storage, { recursive: true });
const root = await fs.mkdtemp(path.join(storage, 'run-'));
const port = Number(process.env.PROCESSING_REPRO_PORT || 4431);
const uiPort = Number(process.env.PROCESSING_REPRO_UI_PORT || 4430);
const base = `http://127.0.0.1:${port}`;
const ui = `http://127.0.0.1:${uiPort}`;
const username = 'processing-repro';
const password = 'Hook-demo-20260920!';
const tenantCode = 'processing-repro';
const runtimeHome = path.join(root, 'runtimes', 'claude', tenantCode, username, tenantCode, 'home', '.claude');
const fixture = await startProcessingLoopModelFixture();
const taskServer = createMcpLoopDemoTaskServer({ durationMs: 8_000 });
await new Promise(resolve => taskServer.listen(0, '127.0.0.1', resolve));
const mcpServer = createMcpLoopDemoMcpServer({ taskServiceUrl: `http://127.0.0.1:${taskServer.address().port}` });
await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
const mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
const emit = WebSocketServer.prototype.emit;
WebSocketServer.prototype.emit = function(event, ...args) {
  if (event === 'connection') {
    const socket = args[0];
    const send = socket.send;
    socket.send = function(data, ...rest) {
      try {
        const message = JSON.parse(String(data));
        void fs.appendFile(path.join(root, 'ws-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), message }) + '\n');
      } catch {}
      return send.call(this, data, ...rest);
    };
  }
  return emit.call(this, event, ...args);
};
for (const name of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY',
  'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'CLAUDECODE']) delete process.env[name];
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'auth.db'),
  WORKSPACES_ROOT: path.join(root, 'workspaces'),
  CLOUDCLI_RUNTIME_ROOT: path.join(root, 'runtimes'),
  CLOUDCLI_DATA_ROOT: path.join(root, 'data'),
  CLOUDCLI_MCP_HELPER_ROOT: path.join(root, 'mcp-helpers'),
  CLOUDCLI_HOOK_SKILLS_ROOT: path.join(root, 'hook-skills'),
  CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: path.join(root, 'template-assets'),
  CLAUDE_CONFIG_DIR: runtimeHome, CLAUDE_EXECUTION_MODE: 'local',
  ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'local-mainloop-ccui-fixture',
  ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-6',
  CCUI_HOOK_PYTHON: process.env.CCUI_HOOK_PYTHON || '/usr/bin/python3',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  NO_PROXY: '127.0.0.1,localhost', VITE_IS_PLATFORM: 'false', SERVER_PORT: String(port),
  HOST: '127.0.0.1', VITE_PORT: String(uiPort), API_KEY: '', CODEHUB_MCP_URL: '',
  SKILL_MARKET_AUTH_APPID: '', SKILL_MARKET_AUTH_KEY: '', SKILL_MARKET_BASE_URL: fixture.url,
});
const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
process.env.CLAUDE_CLI_PATH = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
await fs.writeFile(process.env.DATABASE_PATH, '');
await fs.mkdir(runtimeHome, { recursive: true });
await fs.mkdir(process.env.WORKSPACES_ROOT, { recursive: true });

// Work around the bundled Node 24/native SQLite statement-finalizer crash only
// in this demo process, as in preview-tenant-management.mjs.
const statements = [];
if (process.versions.node.startsWith('24.')) {
  const native = require('better-sqlite3/build/Release/better_sqlite3.node');
  const prepare = native.Database.prototype.prepare;
  native.Database.prototype.prepare = function (...args) {
    const statement = prepare.apply(this, args);
    statements.push(statement);
    return statement;
  };
}
const { db, userDb, initializeDatabase } = await import('../server/database/db.js');
await initializeDatabase();
const { multitenancyDb } = await import('../server/database/multitenancy-db.js');
const { generateToken } = await import('../server/middleware/auth.js');
const user = userDb.createUser(username, await bcrypt.hash(password, 4), { isSystemAdmin: true,
  env: { ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: 'claude-sonnet-4-6' } });
userDb.completeOnboarding(user.id);
userDb.updateClaudeEnvForUsers({ userIds: [user.id], env: { CLAUDE_CONFIG_DIR: runtimeHome } });
const tenant = multitenancyDb.tenants.createTenant({ code: tenantCode, name: 'Processing 循环复现' });
multitenancyDb.memberships.upsertMembership({ tenantId: tenant.id, userId: user.id,
  role: 'admin', permission: 'edit', status: 'active' });
const token = generateToken(user);
await import('../server/index.js');

async function request(route, options = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method: options.method || 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const payload = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { await request('/auth/status'); break; } catch (error) {
    if (attempt === 99) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const workspace = (await request(`/projects/create-workspace?tenantId=${tenant.id}`, {
  method: 'POST', body: { workspaceType: 'new', path: 'Processing 循环复现' },
})).project;
assert.ok(workspace.path.startsWith(root + path.sep));
await fs.writeFile(path.join(workspace.path, '演示说明.md'), '# Processing 循环复现\n\n模型响应由本地测试服务提供；CCUI、原生 SDK、MCP 轮询和 Python Hook 实际执行。\n\n模拟任务 8 秒完成，观察最终汇总后 Processing 是否消失。\n');
const presetInput = { tenantId: tenant.id, name: 'processing_repro', displayName: 'Processing repro MCP', config: { type: 'http', url: mcpUrl, alwaysLoad: true } };
const preset = (await request('/admin/mcp-presets', { method: 'POST', body: presetInput })).preset;
await request(`/admin/mcp-presets/${preset.id}/test`, { method: 'POST', body: { tenantId: tenant.id } });
await request(`/admin/mcp-presets/${preset.id}/publish`, { method: 'POST', body: { tenantId: tenant.id } });
await request(`/workspaces/${workspace.workspaceId}/mcp-tools/${preset.id}/install?tenantId=${tenant.id}`, { method: 'POST' });
await request('/admin/hooks/mcp-servers', { method: 'POST', body: presetInput });
await request('/admin/hooks/mcp-servers/processing_repro/test', { method: 'POST', body: { tenantId: tenant.id } });
const config = {
  name: 'Processing 循环结束复现', eventName: 'PostToolUse', includeSubagents: false,
  matcher: { mode: 'exact', value: 'mcp__processing_repro__get_task_status' },
  postActions: [{ id: 'wait-task', type: 'mcp_loop_run', position: 0, config: {
    pollIntervalMs: 1000, perCallTimeoutMs: 10000, maxWaitMs: 60000,
    terminationScript: 'async def run(event, ccui):\n    status = (event.get("result") or {}).get("status")\n    return {"output": {"status": status if status in ("success", "failed") else "running"}}\n',
    waitingLabel: '等待 8 秒模拟任务',
  } }], claudeResponse: { bindings: {} },
};
const { hookConfigService } = await import('../server/services/hook-configs.js');
const draft = hookConfigService.createHook({ userId: user.id, input: config });
const hook = hookConfigService.publishHook({ userId: user.id, hookId: draft.id });
hookConfigService.replaceHookBindings({ hookId: hook.id, scope: 'users', userIds: [user.id],
  defaultEnabled: true, defaultShowInChat: true, boundBy: user.id });
await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}?tenantId=${tenant.id}`, {
  method: 'PUT', body: { enabled: true },
});
await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}/chat-visibility?tenantId=${tenant.id}`, {
  method: 'PUT', body: { showInChat: true },
});
const active = hookConfigService.listEffectiveHooksForContext({ userId: user.id, tenantId: tenant.id,
  workspaceId: workspace.workspaceId });
assert.ok(active.some((item) => item.id === hook.id));

const vite = await createViteServer({ root: repoRoot, configFile: false, envFile: false,
  plugins: [react()], cacheDir: path.join(root, 'vite-cache'),
  define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  server: { host: '127.0.0.1', port: uiPort, strictPort: true,
    proxy: { '/api': base, '/ws': { target: base.replace('http:', 'ws:'), ws: true },
      '/shell': { target: base.replace('http:', 'ws:'), ws: true } },
  },
});
await vite.listen();
const state = { root, ui, base, modelUrl: fixture.url, username, password, tenantId: tenant.id,
  userId: user.id, workspace, hookId: hook.id, taskDurationMs: 8000, mode: 'local-model',
  prompt: '请提交一次模拟任务，查询一次状态，等待循环 Hook 完成后报告结果。' };
await fs.writeFile(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
await fs.writeFile(path.join(storage, 'latest.json'), `${JSON.stringify(state, null, 2)}\n`);
console.log(`PROCESSING_REPRO_READY ${ui} login=${username} password=${password} workspace=${workspace.workspaceId} hook=${hook.id}`);
console.log(`Demo state: ${path.join(root, 'state.json')}`);

// Keep the real application, WebSocket server, and Vite UI available for the user.
async function shutdownFixture() {
  await vite.close();
  await fixture.close();
  mcpServer.close();
  taskServer.close();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdownFixture);

if (process.argv.includes('--verify')) {
  try {
    const { verifyProcessingLoopLifecycle } = await import('./processing-loop-regression.mjs');
    await verifyProcessingLoopLifecycle({ base, token, tenantId: tenant.id, workspace, root });
    await shutdownFixture();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
