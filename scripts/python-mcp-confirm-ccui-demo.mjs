// Real CCUI MCP confirmation demonstration with an isolated DB and local model endpoint.
// node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json scripts/python-mcp-confirm-ccui-demo.mjs
// Add --post-action to demonstrate the script-free request_confirmation action.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import bcrypt from 'bcrypt';
import { createServer as createViteServer } from 'vite';

import { startMcpConfirmModelFixture } from './python-mcp-confirm-model-fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const postActionMode = process.argv.includes('--post-action');
// Cache this import before overriding settings; later application imports must
// never restore the user's live database or model endpoint from .env.
await import('../server/load-env.js');
const storage = path.join(repoRoot, '.tmp', postActionMode ? 'mcp-confirmation-action-ccui' : 'python-mcp-confirm-ccui');
await fs.mkdir(storage, { recursive: true });
const root = await fs.mkdtemp(path.join(storage, 'run-'));
const port = Number(process.env.MCP_CONFIRM_CCUI_PORT || 3931);
const uiPort = Number(process.env.MCP_CONFIRM_CCUI_UI_PORT || 3930);
const base = `http://127.0.0.1:${port}`;
const ui = `http://127.0.0.1:${uiPort}`;
const username = postActionMode ? 'mcp-post-action-demo' : 'mcp-confirm-demo';
const password = 'Hook-demo-20260920!';
const tenantCode = username;
const runtimeHome = path.join(root, 'runtimes', 'claude', tenantCode, username, tenantCode, 'home', '.claude');
const fixture = await startMcpConfirmModelFixture({ logPath: path.join(root, 'model-requests.jsonl') });
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
  ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'local-mcp-confirm-ccui-fixture',
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
const tenant = multitenancyDb.tenants.createTenant({ code: tenantCode,
  name: postActionMode ? 'MCP 后置行为确认演示' : 'MCP 参数确认演示' });
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
  method: 'POST', body: { workspaceType: 'new',
    path: postActionMode ? 'MCP后置行为逐次确认演示' : 'MCP调用前逐次确认演示' },
})).project;
assert.ok(workspace.path.startsWith(root + path.sep));
const executionLog = path.join(root, 'mcp-executions.jsonl');
await fs.writeFile(executionLog, '');
await fs.writeFile(path.join(workspace.path, '.mcp.json'), JSON.stringify({ mcpServers: {
  confirm_demo: { type: 'stdio', command: process.execPath,
    args: [path.join(repoRoot, 'scripts/python-mcp-confirm-demo-mcp.mjs')],
    env: { MCP_CONFIRM_EXECUTION_LOG: executionLog } },
} }, null, 2));
await fs.writeFile(path.join(workspace.path, '演示说明.md'), `# MCP 调用前参数确认演示\n\n模型响应由本地测试服务提供；CCUI、原生 SDK、${postActionMode ? '请求用户确认后置行为' : 'Python Hook'} 和 MCP 实际执行。\n\n验证：确认前执行次数不变；每次调用单独确认；取消后不执行。\n`);
const configPath = postActionMode ? 'examples/mcp-confirmation-action/hook.json' : 'examples/python-mcp-confirm/hook.json';
const config = JSON.parse(await fs.readFile(path.join(repoRoot, configPath), 'utf8'));
const { hookConfigService } = await import('../server/services/hook-configs.js');
const draft = hookConfigService.createHook({ userId: user.id, input: config });
const hook = hookConfigService.publishHook({ userId: user.id, hookId: draft.id });
hookConfigService.replaceHookBindings({ hookId: hook.id, scope: 'users', userIds: [user.id],
  defaultEnabled: true, defaultShowInChat: true, allowUserDisable: false, boundBy: user.id });
await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}?tenantId=${tenant.id}`, {
  method: 'PUT', body: { enabled: true, userVariables: {} },
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
  userId: user.id, workspace, hookId: hook.id, executionLog, mode: 'local-model',
  confirmationMode: postActionMode ? 'post-action' : 'python',
  prompt: '请连续两次调用演示回声工具。' };
await fs.writeFile(path.join(root, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
await fs.writeFile(path.join(storage, 'latest.json'), `${JSON.stringify(state, null, 2)}\n`);
console.log(`MCP_CONFIRM_CCUI_READY ${ui} login=${username} password=${password} workspace=${workspace.workspaceId} hook=${hook.id}`);
console.log(`Demo state: ${path.join(root, 'state.json')}`);

// Keep the real application, WebSocket server, and Vite UI available for the user.
process.on('SIGTERM', async () => { await vite.close(); await fixture.close(); db.close(); process.exit(0); });
