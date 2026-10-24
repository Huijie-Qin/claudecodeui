// Real CCUI browser demonstration with an isolated DB and local model endpoint.
// TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx scripts/hook-post-actions-audit-fixture.mjs
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import bcrypt from 'bcrypt';
import { createServer as createViteServer } from 'vite';

import { startMainloopModelFixture } from './python-mainloop-model-fixture.mjs';
import { AUDIT_CASES as ALL_AUDIT_CASES } from './hook-post-actions-audit-cases.mjs';
import { createServer } from 'node:http';
import { createMcpLoopDemoTaskServer } from './mcp-loop-demo-task-service.mjs';
import { createMcpLoopDemoMcpServer } from './mcp-loop-demo-mcp.mjs';
import { WebSocketServer } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.env.HOOK_AUDIT_VERSION || 'source';
const serverRoot = version === 'deployed' ? '../deployed-dist-server/server' : '../server';
const controlPort = Number(process.env.HOOK_AUDIT_CONTROL_PORT || 4462);
const selectedCases = process.env.HOOK_AUDIT_CASES?.split(',');
const AUDIT_CASES = structuredClone(ALL_AUDIT_CASES.filter(c => !selectedCases || selectedCases.includes(c.id)));
if (process.env.HOOK_AUDIT_INJECT_TO_CONTEXT !== undefined) {
  for (const c of AUDIT_CASES) if (c.hook) c.hook.injectToContext = process.env.HOOK_AUDIT_INJECT_TO_CONTEXT !== 'false';
}
// Cache this import before overriding settings; later application imports must
// never restore the user's live database or model endpoint from .env.
await import(`${serverRoot}/load-env.js`);
const storage = path.resolve(process.env.HOOK_AUDIT_OUTPUT || path.join(repoRoot, 'artifacts', 'hook-post-actions-audit-20261021'));
await fs.mkdir(storage, { recursive: true });
const root = await fs.mkdtemp(path.join(storage, 'run-'));
const port = Number(process.env.PROCESSING_REPRO_PORT || 4461);
const uiPort = Number(process.env.PROCESSING_REPRO_UI_PORT || 4460);
const base = `http://127.0.0.1:${port}`;
const ui = `http://127.0.0.1:${uiPort}`;
const username = 'hook-audit';
const password = 'Hook-demo-20260920!';
const tenantCode = 'hook-audit';
let currentCase = AUDIT_CASES[0];
let mainCount = 0, reviewCount = 0;
const fixture = await startMainloopModelFixture({ reply: async ({body}) => {
  const isReview = JSON.stringify(body.messages).includes('currentUserTask');
  const isIsolated = JSON.stringify(body.system).includes('CCUI_ISOLATED_HOOK');
  const textOnly = (body.messages || []).filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
  const isChild = textOnly.includes('AUDIT_CHILD_ROLE');
  const role = isIsolated ? 'isolated' : isReview ? 'review' : isChild ? 'child' : 'main';
  await fs.appendFile(path.join(root, 'model-requests.jsonl'), JSON.stringify({at: Date.now(), caseId: currentCase.id, role, body}) + '\n');
  await new Promise(resolve => setTimeout(resolve, isReview ? 1800 : 700));
  if (isIsolated) {
    const toolId = `toolu_isolated_${currentCase.id}`;
    const blocks = (body.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []);
    if (!blocks.some(b => b.type === 'tool_result' && b.tool_use_id === toolId)) {
      return { content: [{ type: 'tool_use', id: toolId, name: 'mcp__processing_repro__execute_task', input: { should_fail: false } }] };
    }
    return 'HOOK_ISOLATED_RESULT_SENTINEL';
  }
  if (isReview) {
    reviewCount++;
    if (currentCase.id === 'review_invalid') return 'not a valid review';
    const complete = currentCase.id === 'review_pass' || (currentCase.id === 'review_retry' && reviewCount > 1);
    return JSON.stringify({complete, reason: currentCase.marker, nextStep: complete ? '' : '完成下一步测试'});
  }
  mainCount++;
  if (currentCase.id.startsWith('stopfailure_') && mainCount === 1) throw new Error('Controlled local model failure');
  const messages = body.messages || [];
  const transcript = JSON.stringify(messages);
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (JSON.stringify(lastUser).includes('AUDIT_PROBE')) return `AUDIT_PROBE_DONE ${currentCase.id}`;
  const blocks = messages.flatMap(m => Array.isArray(m.content) ? m.content : []);
  const resultFor = id => blocks.find(b => b.type === 'tool_result' && b.tool_use_id === id);
  if (process.env.HOOK_AUDIT_RESULT_FILES === 'true') {
    const resultFiles = [...new Set([...transcript.matchAll(/\/(?:[^"\\\s<>]*\/)\.cloudcli\/hook-results\/mcp-loops\/[A-Za-z0-9_-]+\.json/g)].map(match => match[0]))];
    const reads = resultFiles.map((file, index) => ({ file, id: `toolu_read_loop_${currentCase.id}_${index}` }));
    const pending = reads.filter(read => !resultFor(read.id));
    if (pending.length) return { content: pending.map(read => ({ type: 'tool_use', id: read.id,
      name: 'Read', input: { file_path: read.file } })) };
    if (reads.length) {
      const readable = reads.every(read => !resultFor(read.id).is_error
        && JSON.stringify(resultFor(read.id).content).includes('replacesToolUseId'));
      return `AUDIT_RESULT_FILE_${readable ? 'READ_OK' : 'READ_FAILED'} ${currentCase.id} files=${reads.length}`;
    }
  }
  const childId = `toolu_audit_child_${currentCase.id}`;
  if (currentCase.mode.startsWith('child') && !isChild) {
    if (!resultFor(childId)) return {content:[{type:'tool_use',id:childId,name:(body.tools||[]).some(t=>t.name==='Agent')?'Agent':'Task',input:{description:'Hook audit child',subagent_type:'general-purpose',run_in_background:false,prompt:'AUDIT_CHILD_ROLE 请完成子代理测试并返回结果。'}}]};
    return `AUDIT_FINAL ${currentCase.id} parent`;
  }
  const executeId = `toolu_audit_execute_${currentCase.id}`;
  const statusId = `toolu_audit_status_${currentCase.id}`;
  const executeResult = resultFor(executeId);
  if (currentCase.mode === 'loop_parallel') {
    const executionIds = [0, 1].map(index => `${executeId}_${index}`);
    const pendingExecutions = executionIds.filter(id => !resultFor(id));
    if (pendingExecutions.length) return { content: pendingExecutions.map(id => ({ type: 'tool_use', id,
      name: 'mcp__processing_repro__execute_task', input: { should_fail: false } })) };
    const statusCalls = executionIds.map((id, index) => ({ id: `${statusId}_${index}`,
      taskId: JSON.stringify(resultFor(id).content).match(/task_id[^a-z0-9]+([a-f0-9-]{36})/)?.[1] }));
    const pendingStatuses = statusCalls.filter(call => call.taskId && !resultFor(call.id));
    if (pendingStatuses.length && !transcript.includes('<ccui-mcp-loop-result')) {
      return { content: pendingStatuses.map(call => ({ type: 'tool_use', id: call.id,
        name: 'mcp__processing_repro__get_task_status', input: { task_id: call.taskId } })) };
    }
  }
  if (['tool','loop','child_loop'].includes(currentCase.mode)) {
    if (!executeResult) return {content:[{type:'tool_use', id:executeId, name:'mcp__processing_repro__execute_task', input:{should_fail: currentCase.id === 'loop_failed'}}]};
    if (['loop','child_loop'].includes(currentCase.mode) && !resultFor(statusId) && !transcript.includes('<ccui-mcp-loop-result')) {
      const taskId = JSON.stringify(executeResult.content).match(/task_id[^a-z0-9]+([a-f0-9-]{36})/)?.[1];
      if (taskId) return {content:[{type:'tool_use', id:statusId, name:'mcp__processing_repro__get_task_status', input:{task_id:taskId}}]};
    }
  }
  return `AUDIT_FINAL ${currentCase.id} main=${mainCount}`;
} });
const taskServer = createMcpLoopDemoTaskServer({ durationMs: 12_000 });
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
  'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR']) delete process.env[name];
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'auth.db'),
  WORKSPACES_ROOT: path.join(root, 'workspaces'),
  CLOUDCLI_RUNTIME_ROOT: path.join(root, 'runtimes'),
  CLOUDCLI_DATA_ROOT: path.join(root, 'data'),
  CLOUDCLI_MCP_HELPER_ROOT: path.join(root, 'mcp-helpers'),
  CLOUDCLI_HOOK_SKILLS_ROOT: path.join(root, 'hook-skills'),
  CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: path.join(root, 'template-assets'),
  CLAUDE_EXECUTION_MODE: 'local',
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
const runtimeRequire = version === 'deployed' ? createRequire(path.join(repoRoot,'deployed-dist-server','server','index.js')) : require;
const sdkRequire = createRequire(runtimeRequire.resolve('@anthropic-ai/claude-agent-sdk'));
process.env.CLAUDE_CLI_PATH = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
await fs.writeFile(process.env.DATABASE_PATH, '');
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
const { db, userDb, initializeDatabase } = await import(`${serverRoot}/database/db.js`);
await initializeDatabase();
const { multitenancyDb } = await import(`${serverRoot}/database/multitenancy-db.js`);
const { generateToken } = await import(`${serverRoot}/middleware/auth.js`);
const user = userDb.createUser(username, await bcrypt.hash(password, 4), { isSystemAdmin: true,
  env: { ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: 'claude-sonnet-4-6', session_limit: process.env.HOOK_AUDIT_SESSION_LIMIT || '1' } });
userDb.completeOnboarding(user.id);
const tenant = multitenancyDb.tenants.createTenant({ code: tenantCode, name: 'Hook 后置行为验证' });
multitenancyDb.memberships.upsertMembership({ tenantId: tenant.id, userId: user.id,
  role: 'admin', permission: 'edit', status: 'active' });
const token = generateToken(user);
await import(`${serverRoot}/index.js`);

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
  method: 'POST', body: { workspaceType: 'new', path: 'Hook 后置行为验证' },
})).project;
assert.ok(workspace.path.startsWith(root + path.sep));
// Local Claude must write its JSONL transcript in the workspace runtime home,
// which is also where CCUI reads session history after a page refresh.
const runtimeHome = path.join(root, 'runtimes', 'claude', tenantCode, username, workspace.name, 'home');
await fs.mkdir(path.join(runtimeHome, '.claude'), { recursive: true });
userDb.updateClaudeEnvForUsers({ userIds: [user.id], env: { CLAUDE_CONFIG_DIR: path.join(runtimeHome, '.claude') } });
await fs.writeFile(path.join(workspace.path, '演示说明.md'), '# Hook 后置行为验证\n\n模型响应由本地测试服务提供；CCUI、原生 SDK、MCP 轮询和 Python Hook 实际执行。\n\n模拟任务 8 秒完成，观察最终汇总后 Processing 是否消失。\n');
const presetInput = { tenantId: tenant.id, name: 'processing_repro', displayName: 'Processing repro MCP', config: { type: 'http', url: mcpUrl, alwaysLoad: true } };
const preset = (await request('/admin/mcp-presets', { method: 'POST', body: presetInput })).preset;
await request(`/admin/mcp-presets/${preset.id}/test`, { method: 'POST', body: { tenantId: tenant.id } });
await request(`/admin/mcp-presets/${preset.id}/publish`, { method: 'POST', body: { tenantId: tenant.id } });
await request(`/workspaces/${workspace.workspaceId}/mcp-tools/${preset.id}/install?tenantId=${tenant.id}`, { method: 'POST' });
await request('/admin/hooks/mcp-servers', { method: 'POST', body: presetInput });
await request('/admin/hooks/mcp-servers/processing_repro/test', { method: 'POST', body: { tenantId: tenant.id } });
const { hookConfigService } = await import(`${serverRoot}/services/hook-configs.js`);
const { saveManagedBuiltinHookSkill } = await import(`${serverRoot}/services/hook-builtin-skills.js`);
await saveManagedBuiltinHookSkill({files:[{relativePath:'hook-audit/SKILL.md',buffer:Buffer.from('---\nname: hook-audit\ndescription: Isolated audit skill\n---\nHOOK_SKILL_BODY_SENTINEL\n$ARGUMENTS\n请返回本轮测试完成。\n')}]});
const { hookMcpCatalogService } = await import(`${serverRoot}/services/hook-mcp-catalog.js`);
const caseHooks = {};
const unsupportedCases = [];
for (const c of AUDIT_CASES) {
  if (!c.hook) continue;
  for (const a of c.hook.postActions) if (a.type === 'call_mcp_tool') a.config.mcpServerId = hookMcpCatalogService.listToolResources().find(t => t.name === a.config.toolName).mcpServerId;
  let draft;
  try { draft = hookConfigService.createHook({userId:user.id,input:c.hook}); } catch(error) {
    if (version !== 'deployed') throw error;
    unsupportedCases.push({id:c.id,error:error.message});continue;
  }
  const published = (await request(`/admin/hooks/${draft.id}/publish`, {method:'POST'})).hook;
  hookConfigService.replaceHookBindings({hookId:published.id,scope:'users',userIds:[user.id],defaultEnabled:false,defaultShowInChat:true,boundBy:user.id});
  caseHooks[c.id] = published.id;
}
let blockedResultDirectory = false;
async function activateCase(id, disabled = false) {
  const resultDirectory = path.join(workspace.path, '.cloudcli', 'hook-results', 'mcp-loops');
  if (blockedResultDirectory) {
    await fs.unlink(resultDirectory);
    await fs.rename(`${resultDirectory}.saved`, resultDirectory);
    blockedResultDirectory = false;
  }
  if (!disabled && id === 'loop_write_failure') {
    await fs.mkdir(resultDirectory, { recursive: true });
    await fs.rename(resultDirectory, `${resultDirectory}.saved`);
    await fs.writeFile(resultDirectory, 'Controlled write failure: this path is a file, not a directory.');
    blockedResultDirectory = true;
  }
  for (const [caseId,hookId] of Object.entries(caseHooks)) {
    await request(`/workspaces/${workspace.workspaceId}/hooks/${hookId}?tenantId=${tenant.id}`, {method:'PUT',body:{enabled:!disabled && caseId===id}});
  }
  if (!disabled) { currentCase = AUDIT_CASES.find(c => c.id === id); mainCount = 0; reviewCount = 0; }
}
const vite = await createViteServer({ root: version === 'deployed' ? path.join(repoRoot,'deployed-dist') : repoRoot, configFile: false, envFile: false,
  plugins: [react()], cacheDir: path.join(root, 'vite-cache'),
  define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  server: { host: '127.0.0.1', port: uiPort, strictPort: true,
    proxy: { '/api': base, '/ws': { target: base.replace('http:', 'ws:'), ws: true },
      '/shell': { target: base.replace('http:', 'ws:'), ws: true } },
  },
});
await vite.listen();
const state = {root,ui,base,modelUrl:fixture.url,username,password,tenantId:tenant.id,userId:user.id,workspace,caseHooks,unsupportedCases,mode:'local-model',version,control:`http://127.0.0.1:${controlPort}`};
await fs.writeFile(path.join(root,'state.json'),JSON.stringify(state,null,2));
await fs.writeFile(path.join(storage,'latest.json'),JSON.stringify(state,null,2));
const control = createServer(async(req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    let payload;
    if(url.pathname==='/state') payload={...state,token,cases:AUDIT_CASES.filter(c=>!c.hook||caseHooks[c.id]).map(({hook,...c})=>c)};
    else if(url.pathname==='/activate') {await activateCase(url.searchParams.get('id'));payload={ok:true};}
    else if(url.pathname==='/disable') {await activateCase(currentCase.id,true);payload={ok:true};}
    else if(url.pathname==='/evidence') {
      const sid=url.searchParams.get('sessionId');
      payload={caseId:currentCase.id,mainCount,reviewCount,
        executions:db.prepare('SELECT * FROM hook_executions WHERE session_id=? ORDER BY started_at').all(sid),
        records:db.prepare('SELECT * FROM hook_data_records WHERE session_id=?').all(sid),
        loops:db.prepare('SELECT * FROM mcp_loop_jobs WHERE session_id=? ORDER BY started_at_ms').all(sid),
        modelRequests:fixture.getRawRequests().slice(-50),
      };
    } else payload={error:'unknown route'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));
  } catch(e) {console.error(e);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(e)}));}
});
await new Promise(resolve=>control.listen(controlPort,'127.0.0.1',resolve));
console.log(`HOOK_AUDIT_READY ${ui} ${path.join(root,'state.json')}`);
process.on('SIGTERM',async()=>{await vite.close();await fixture.close();mcpServer.close();taskServer.close();control.close();db.close();process.exit(0);});
