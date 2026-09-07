// Run against an isolated application and local Skill Market/MCP fixtures.
// `npm run test:agent-templates:e2e -- --serve` leaves it open for UI QA.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import express from 'express';
import bcrypt from 'bcrypt';

import { ECHO_SETTINGS_TOOL } from './mcp-tool-settings-mock.mjs';
import { createTestSkills } from './skill-market-test-server.mjs';

const testRoot = path.resolve(process.env.AGENT_TEMPLATE_E2E_ROOT || '.tmp');
await fs.mkdir(testRoot, { recursive: true });
const root = await fs.mkdtemp(path.join(testRoot, 'ccui-agent-template-e2e-'));
const port = Number(process.env.AGENT_TEMPLATE_E2E_PORT || 3901);
const serve = process.argv.includes('--serve');
Object.assign(process.env, {
  DATABASE_PATH: path.join(root, 'auth.db'),
  WORKSPACES_ROOT: path.join(root, 'workspaces'),
  CLOUDCLI_RUNTIME_ROOT: path.join(root, 'runtimes'),
  CLOUDCLI_MCP_HELPER_ROOT: path.join(root, 'mcp-helper-scripts'),
  CLOUDCLI_HOOK_SKILLS_ROOT: path.join(root, 'hook-skills'),
  CLOUDCLI_DATA_ROOT: path.join(root, 'data'),
  CLAUDE_EXECUTION_MODE: 'local',
  VITE_IS_PLATFORM: 'false',
  SERVER_PORT: String(port),
  HOST: process.env.AGENT_TEMPLATE_E2E_HOST || '127.0.0.1',
  API_KEY: '',
  SKILL_MARKET_AUTH_APPID: '',
  SKILL_MARKET_AUTH_KEY: '',
});
// An existing empty file prevents the legacy database migration copying real data.
await fs.writeFile(process.env.DATABASE_PATH, '');
await fs.mkdir(process.env.WORKSPACES_ROOT, { recursive: true });

const skills = createTestSkills(137);
const toolDefinitions = [ECHO_SETTINGS_TOOL, {
  name: 'read_status', description: 'Return the local QA fixture status.',
  inputSchema: { type: 'object', properties: { label: { type: 'string' } } },
}];
const calls = [];
const modelRequests = [];
const fixtureApp = express();
fixtureApp.use(express.json());
fixtureApp.post('/v1/messages/count_tokens', (_req, res) => res.json({ input_tokens: 100 }));
fixtureApp.post('/v1/messages', (req, res) => {
  const body = req.body;
  modelRequests.push(body);
  const used = (body.messages || []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((item) => item.type === 'tool_use').map((item) => item.name);
  const isAgent = (body.tools || []).some((tool) => tool.name === 'Skill');
  let content = [{ type: 'text', text: 'QA SDK completed.' }];
  if (isAgent && !used.includes('Skill')) content = [{ type: 'tool_use', id: 'toolu_qa_skill', name: 'Skill', input: { skill: 'test-skill-137' } }];
  else if (isAgent && !used.includes('mcp__qa__echo__echo_settings')) content = [{ type: 'tool_use', id: 'toolu_qa_echo', name: 'mcp__qa__echo__echo_settings', input: { limit: 99, region: 'us', include_metadata: true } }];
  else if (isAgent && !used.includes('mcp__qa__echo__read_status')) content = [{ type: 'tool_use', id: 'toolu_qa_blocked', name: 'mcp__qa__echo__read_status', input: { label: 'must-not-reach-server' } }];
  const stopReason = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
  const message = { id: `msg_qa_${modelRequests.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
  if (!body.stream) return res.json(message);
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const emit = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  const block = content[0];
  emit('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
  emit('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
  emit('content_block_stop', { index: 0 });
  emit('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  emit('message_stop', {});
  return res.end();
});
fixtureApp.post('/data-agent/api/skill/skillList', (req, res) => {
  const search = String(req.body.data?.searchContent || '').toLowerCase();
  const found = skills.filter((skill) => JSON.stringify(skill).toLowerCase().includes(search));
  const page = Number(req.body.pageInfo?.page || 1);
  const size = Number(req.body.pageInfo?.pageSize || 20);
  res.json({ code: 0, data: { list: found.slice((page - 1) * size, page * size), total: found.length } });
});
fixtureApp.post('/data-agent/api/skill/download', (req, res) => {
  const skill = skills.find((entry) => entry.id === req.body.data?.id);
  if (!skill) return res.status(404).json({ error: 'unknown fixture Skill' });
  return res.json({ code: 0, data: { files: {
    'SKILL.md': `---\nname: ${skill.skillName}\ndescription: Local end-to-end test skill ${skill.id}\n---\n\nWhen invoked, include SKILL_E2E_EXECUTED in your response.\n`,
    'references/check.txt': 'SKILL_RESOURCE_E2E\n',
  } } });
});
fixtureApp.all('/mcp', (req, res) => {
  if (req.method === 'DELETE') return res.sendStatus(204);
  if (req.method !== 'POST') return res.sendStatus(405);
  const rpc = req.body;
  res.set('mcp-session-id', 'template-e2e');
  const reply = (result) => res.json({ jsonrpc: '2.0', id: rpc.id, result });
  if (rpc.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'template-e2e', version: '1.0.0' } });
  if (rpc.method === 'notifications/initialized') return res.sendStatus(202);
  if (rpc.method === 'tools/list') return reply({ tools: toolDefinitions });
  if (rpc.method === 'tools/call') {
    if (!toolDefinitions.some((tool) => tool.name === rpc.params?.name)) return res.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'unknown tool' } });
    calls.push({ name: rpc.params.name, input: rpc.params.arguments });
    const output = { receivedArguments: rpc.params.arguments || {}, callNumber: calls.length };
    return reply({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output });
  }
  return res.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown method' } });
});
const fixtureServer = http.createServer(fixtureApp);
await new Promise((resolve) => fixtureServer.listen(0, '0.0.0.0', resolve));
const fixtureHost = Object.values(os.networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address || '127.0.0.1';
const fixtureUrl = `http://${fixtureHost}:${fixtureServer.address().port}`;
process.env.SKILL_MARKET_BASE_URL = fixtureUrl;
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: fixtureUrl, ANTHROPIC_API_KEY: 'qa-local-fixture-only',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
});

const { db, userDb, initializeDatabase } = await import('../server/database/db.js');
await initializeDatabase();
const { multitenancyDb } = await import('../server/database/multitenancy-db.js');
const { hookConfigService } = await import('../server/services/hook-configs.js');
const { createHookRuntimeSession } = await import('../server/services/hook-runtime.js');
const { resolveUserWorkspaceMcpToolAccess } = await import('../server/services/mcp-tool-access.js');
const { applyMcpToolOverrides, readMcpToolOverridesConfig } = await import('../server/services/mcp-tool-overrides.js');
const { callHookMcpTool } = await import('../server/services/hook-mcp-client.js');
const { readWorkspaceMcpConfig } = await import('../server/services/workspace-tools.js');
const { generateToken } = await import('../server/middleware/auth.js');
const password = 'Template-QA-only-20260907';
const admin = userDb.createUser('template-qa-admin', await bcrypt.hash(password, 4), { isSystemAdmin: true });
const member = userDb.createUser('template-qa-member', await bcrypt.hash(password, 4));
const tenant = multitenancyDb.tenants.createTenant({ code: 'template-qa', name: 'Agent 模板测试' });
const otherTenant = multitenancyDb.tenants.createTenant({ code: 'template-other', name: '隔离租户' });
for (const user of [admin, member]) {
  for (const item of [tenant, otherTenant]) multitenancyDb.memberships.upsertMembership({ tenantId: item.id, userId: user.id, role: user === admin ? 'admin' : 'member', permission: 'edit', status: 'active' });
}
const adminToken = generateToken(admin);
const memberToken = generateToken(member);
await import('../server/index.js');
const base = `http://127.0.0.1:${port}`;
async function request(route, { method = 'GET', body, token = adminToken, status = 200 } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(payload)}`);
  return payload;
}
for (let attempt = 0; attempt < 100; attempt += 1) {
  try { await request('/auth/status'); break; } catch (error) {
    if (attempt === 99) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const results = [];
async function check(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); console.log(`E2E PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: error.stack }); console.error(`E2E FAIL ${name}: ${error.stack}`); }
}
const tenantBody = { tenantId: tenant.id };
const query = `?tenantId=${tenant.id}`;
let skill, mcp, hook, template, workspace;
await check('管理员 Skill 全量目录与第 137 项导入、校验、发布', async () => {
  const catalog = await request(`/admin/skill-presets/market${query}&complete=true`);
  assert.equal(catalog.skills.length, 137);
  skill = (await request('/admin/skill-presets', { method: 'POST', status: 201, body: { ...tenantBody, sourceRef: 'mock-skill-137', displayName: 'QA Skill 137' } })).preset;
  const validation = await request(`/admin/skill-presets/${skill.id}/validate`, { method: 'POST', body: tenantBody });
  assert.equal(validation.validation.status, 'healthy');
  skill = (await request(`/admin/skill-presets/${skill.id}/publish`, { method: 'POST', body: tenantBody })).preset;
  assert.equal(skill.status, 'published');
});
await check('管理员 MCP 配置、真实握手、tools/list 与发布', async () => {
  mcp = (await request('/admin/mcp-presets', { method: 'POST', status: 201, body: {
    ...tenantBody, name: 'qa__echo', displayName: 'QA 参数回显 MCP', description: 'Two local tools', config: { type: 'http', url: `${fixtureUrl}/mcp` },
  } })).preset;
  const probe = await request(`/admin/mcp-presets/${mcp.id}/test`, { method: 'POST', body: tenantBody });
  assert.equal(probe.preset.toolCount, 2);
  mcp = (await request(`/admin/mcp-presets/${mcp.id}/publish`, { method: 'POST', body: tenantBody })).preset;
  assert.equal(mcp.status, 'published');
});
const hookInput = {
  name: 'QA 项目完成 Hook', description: 'Write a real Hook execution record', eventName: 'Stop', matcher: {},
  extensionLogic: { language: 'javascript', code: 'export async function run(event, ccui) { await ccui.records.write("template-e2e", { marker: "HOOK_E2E_EXECUTED" }); return { output: { marker: "HOOK_E2E_EXECUTED" } }; }', outputs: [{ name: 'marker', type: 'string' }] },
  postActions: [], claudeResponse: { bindings: {} },
};
await check('Hook 配置、脚本与发布版本', async () => {
  hook = (await request('/admin/hooks', { method: 'POST', status: 201, body: hookInput })).hook;
  hook = (await request(`/admin/hooks/${hook.id}/publish`, { method: 'POST' })).hook;
  assert.equal(hook.status, 'published');
});
const settings = {
  allowedToolNames: ['echo_settings'],
  tools: { echo_settings: { params: {
    topic: { mode: 'default', value: 'template-topic' },
    limit: { mode: 'force', value: 7 },
    include_metadata: { mode: 'force', value: false },
    filters: { mode: 'default', value: ['published'] },
    region: { mode: 'force', value: 'cn' },
  } } },
};
function templateInput(name, toolSettings = settings) {
  return { name, category: '端到端测试', summary: 'Skill / MCP / tools / Hook', tenantIds: [tenant.id],
    claudeMarkdown: '# TEMPLATE_E2E_MEMORY\nUse the configured Skill and MCP tools.', guideText: 'TEMPLATE_E2E_GUIDE',
    skillPresetRefs: [{ tenantId: tenant.id, presetId: skill.id }],
    mcpPresetRefs: [{ tenantId: tenant.id, presetId: mcp.id, ...(toolSettings == null ? {} : { toolSettings }) }],
    hookRefs: [{ hookId: hook.id, version: hook.version, defaultEnabled: true, showInChat: false, allowUserDisable: true, order: 10 }],
  };
}
async function createTemplate(name, toolSettings) {
  const draft = (await request('/admin/agent-templates', { method: 'POST', status: 201, body: templateInput(name, toolSettings) })).template;
  return (await request(`/admin/agent-templates/${draft.id}/publish`, { method: 'POST' })).template;
}
async function createWorkspace(selected, name) {
  const result = await request(`/projects/create-workspace${query}`, { method: 'POST', token: memberToken, body: { workspaceType: 'new', path: name, templateId: selected.id } });
  assert.equal(result.agentTemplate?.warnings?.length || 0, 0, JSON.stringify(result.agentTemplate));
  return result.project;
}
await check('模板配置、重新编辑保存、发布及租户可见性', async () => {
  template = await createTemplate('QA 完整能力模板', settings);
  const listed = await request('/admin/agent-templates');
  assert.deepEqual(listed.templates.find((item) => item.id === template.id).mcpPresetRefs[0].toolSettings, settings);
  assert.equal((await request(`/agent-templates${query}`, { token: memberToken })).templates.length, 1);
  assert.equal((await request(`/agent-templates?tenantId=${otherTenant.id}`, { token: memberToken })).templates.length, 0);
  await request('/admin/agent-templates', { method: 'POST', token: memberToken, body: templateInput('无权限'), status: 403 });
  template = (await request(`/admin/agent-templates/${template.id}`, { method: 'PUT', body: { ...templateInput(template.name), summary: '已编辑并保存' } })).template;
  template = (await request(`/admin/agent-templates/${template.id}/publish`, { method: 'POST' })).template;
});
await check('模板拒绝非法参数类型、未知 tools 和未知参数', async () => {
  for (const patch of [
    { allowedToolNames: ['missing'], tools: {} },
    { allowedToolNames: [], tools: { echo_settings: { params: { missing: { mode: 'force', value: 1 } } } } },
    { allowedToolNames: [], tools: { echo_settings: { params: { filters: { mode: 'force', value: {} } } } } },
    { allowedToolNames: [], tools: { echo_settings: { params: { include_metadata: { mode: 'force', value: 'false' } } } } },
  ]) await request('/admin/agent-templates', { method: 'POST', status: 400, body: templateInput('拒绝非法配置', patch) });
});
await check('从模板创建项目，验证 CLAUDE.md、Skill 文件、MCP 与 Hook 安装', async () => {
  workspace = await createWorkspace(template, 'qa-complete');
  assert.match(await fs.readFile(path.join(workspace.path, 'CLAUDE.md'), 'utf8'), /TEMPLATE_E2E_MEMORY/);
  assert.match(await fs.readFile(path.join(workspace.path, '.claude/skills/test-skill-137/SKILL.md'), 'utf8'), /SKILL_E2E_EXECUTED/);
  assert.equal(await fs.readFile(path.join(workspace.path, '.claude/skills/test-skill-137/references/check.txt'), 'utf8'), 'SKILL_RESOURCE_E2E\n');
  const config = await readWorkspaceMcpConfig(workspace.path);
  assert.equal(config.mcpServers[mcp.name].url, `${fixtureUrl}/mcp`);
  assert.deepEqual((await readMcpToolOverridesConfig(workspace.path)).mcpServers[mcp.name].tools, settings.tools);
  const hooks = (await request(`/workspaces/${workspace.workspaceId}/hooks${query}`, { token: memberToken })).hooks;
  assert.equal(hooks[0].enabled, true);
  assert.equal(hooks[0].showInChat, false);
});
await check('模板 MCP 默认值和强制值到真实 tools/call，包括双下划线服务器名', async () => {
  const config = await readMcpToolOverridesConfig(workspace.path);
  const servers = (await readWorkspaceMcpConfig(workspace.path)).mcpServers;
  for (const [input, expected] of [
    [{}, { topic: 'template-topic', limit: 7, include_metadata: false, filters: ['published'], region: 'cn' }],
    [{ topic: '', limit: 99, include_metadata: true, filters: [], region: 'us' }, { topic: '', limit: 7, include_metadata: false, filters: [], region: 'cn' }],
  ]) {
    const toolName = `mcp__${mcp.name}__echo_settings`;
    const overridden = applyMcpToolOverrides({ toolName, input, config });
    const result = await callHookMcpTool({ qualifiedToolName: toolName, input: overridden.input, mcpServers: servers, cwd: workspace.path });
    assert.deepEqual(result.receivedArguments, expected);
  }
});
await check('tools 部分选择、全选、全不选及每用户修改隔离', async () => {
  const access = (project, userId = member.id) => resolveUserWorkspaceMcpToolAccess({ tenantId: tenant.id, workspaceId: project.workspaceId, userId });
  assert.equal(access(workspace).isAllowed(`mcp__${mcp.name}__echo_settings`), true);
  assert.equal(access(workspace).isAllowed(`mcp__${mcp.name}__read_status`), false);
  for (const names of [[], ['echo_settings', 'read_status']]) {
    const variant = await createTemplate(`QA tools ${names.length}`, { allowedToolNames: names, tools: {} });
    const project = await createWorkspace(variant, `qa-tools-${names.length}`);
    for (const tool of toolDefinitions) assert.equal(access(project).isAllowed(`mcp__${mcp.name}__${tool.name}`), names.includes(tool.name));
    const catalog = await request(`/workspaces/${project.workspaceId}/mcp-tools${query}`, { token: memberToken });
    assert.deepEqual(catalog.presets[0].allowedToolNames, names);
  }
  await request(`/workspaces/${workspace.workspaceId}/mcp-tools/${mcp.id}/tool-preference${query}`, { method: 'PUT', token: memberToken, body: { allowedToolNames: [] } });
  assert.equal(access(workspace).isAllowed(`mcp__${mcp.name}__echo_settings`), false);
  assert.equal(access(workspace, admin.id).isAllowed(`mcp__${mcp.name}__echo_settings`), true);
  await request(`/workspaces/${workspace.workspaceId}/mcp-tools/${mcp.id}/tool-preference${query}`, { method: 'PUT', token: memberToken, body: { allowedToolNames: ['echo_settings'] } });
});
await check('Hook 实际脚本执行、禁用、重新启用与对话可见性', async () => {
  const context = { tenantId: tenant.id, workspaceId: workspace.workspaceId, userId: member.id };
  const active = hookConfigService.listEffectiveHooksForContext(context);
  assert.equal(active.length, 1);
  const runtime = createHookRuntimeSession({ hooks: active, ...context, username: member.username, workspaceRoot: workspace.path, database: db });
  await runtime.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop', session_id: 'qa-hook-session', stop_hook_active: false }, 'qa-stop', { signal: new AbortController().signal });
  assert.equal(db.prepare("SELECT count(*) AS count FROM hook_data_records WHERE record_type = 'template-e2e'").get().count, 1);
  await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}${query}`, { method: 'PUT', token: memberToken, body: { enabled: false } });
  assert.equal(hookConfigService.listEffectiveHooksForContext(context).length, 0);
  await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}${query}`, { method: 'PUT', token: memberToken, body: { enabled: true } });
  await request(`/workspaces/${workspace.workspaceId}/hooks/${hook.id}/chat-visibility${query}`, { method: 'PUT', token: memberToken, body: { showInChat: true } });
  const listed = await request(`/workspaces/${workspace.workspaceId}/hooks${query}`, { token: memberToken });
  assert.equal(listed.hooks[0].showInChat, true);
  assert.equal(hookConfigService.listEffectiveHooksForContext(context).length, 1);
});
await check('Hook 版本锁定、新版发布不影响已有项目', async () => {
  await request(`/admin/hooks/${hook.id}`, { method: 'PUT', body: { ...hookInput, name: 'QA Hook 新版' } });
  const next = (await request(`/admin/hooks/${hook.id}/publish`, { method: 'POST' })).hook;
  assert.ok(next.version > hook.version);
  const active = hookConfigService.listEffectiveHooksForContext({ tenantId: tenant.id, workspaceId: workspace.workspaceId, userId: member.id });
  assert.equal(active[0].version, hook.version);
  assert.equal(active[0].name, hook.name);
});

await check('未设置 tools 时默认全部允许，未设置参数时保留 Agent 输入', async () => {
  const variant = await createTemplate('QA 无工具策略模板', null);
  const project = await createWorkspace(variant, 'qa-unconfigured');
  const access = resolveUserWorkspaceMcpToolAccess({ tenantId: tenant.id, workspaceId: project.workspaceId, userId: member.id });
  for (const tool of toolDefinitions) assert.equal(access.isAllowed(`mcp__${mcp.name}__${tool.name}`), true);
  const config = await readMcpToolOverridesConfig(project.path);
  const input = { topic: 'agent', limit: 99 };
  assert.deepEqual(applyMcpToolOverrides({ toolName: `mcp__${mcp.name}__echo_settings`, input, config }).input, input);
});
await check('Hook 默认关闭和禁止用户关闭，以及项目隔离', async () => {
  const invalid = templateInput('QA 非法强制 Hook');
  invalid.hookRefs[0] = { ...invalid.hookRefs[0], defaultEnabled: false, allowUserDisable: false };
  await request('/admin/agent-templates', { method: 'POST', status: 400, body: invalid });
  for (const defaultEnabled of [false, true]) {
    const input = templateInput(`QA Hook 默认${defaultEnabled}`);
    input.hookRefs[0] = { ...input.hookRefs[0], defaultEnabled, allowUserDisable: !defaultEnabled };
    const draft = (await request('/admin/agent-templates', { method: 'POST', status: 201, body: input })).template;
    const variant = (await request(`/admin/agent-templates/${draft.id}/publish`, { method: 'POST' })).template;
    const project = await createWorkspace(variant, `qa-hook-${defaultEnabled}`);
    const context = { userId: member.id, tenantId: tenant.id, workspaceId: project.workspaceId };
    assert.equal(hookConfigService.listEffectiveHooksForContext(context).length, defaultEnabled ? 1 : 0);
    if (defaultEnabled) await request(`/workspaces/${project.workspaceId}/hooks/${hook.id}${query}`, { method: 'PUT', token: memberToken, status: 409, body: { enabled: false } });
  }
  const plain = (await request(`/projects/create-workspace${query}`, { method: 'POST', token: memberToken, body: { workspaceType: 'new', path: 'qa-no-template' } })).project;
  assert.equal(hookConfigService.listEffectiveHooksForContext({ userId: member.id, tenantId: tenant.id, workspaceId: plain.workspaceId }).length, 0);
});

await check('真实 Claude SDK 会话：Skill 调用、MCP 参数覆盖、禁用工具与 Stop Hook', async () => {
  const { queryClaudeSDK, abortClaudeSDKSession } = await import('../server/claude-sdk.js');
  const messages = [];
  const beforeCalls = calls.length;
  const beforeRecords = db.prepare("SELECT count(*) AS count FROM hook_data_records WHERE record_type = 'template-e2e'").get().count;
  const writer = { userId: member.id, isConnected: () => true, send: (message) => messages.push(typeof message === 'string' ? JSON.parse(message) : message) };
  let timeout;
  try {
    await Promise.race([
      queryClaudeSDK('Run the test-skill-137 Skill, then the QA MCP tool.', {
        cwd: workspace.path, projectPath: workspace.path, tenantId: tenant.id, userId: member.id, workspaceId: workspace.workspaceId,
        model: 'claude-sonnet-4-6',
      }, writer),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SDK session exceeded 90 seconds')), 90_000); }),
    ]);
    assert.ok(messages.some((message) => message.kind === 'complete' && message.success), JSON.stringify(messages.slice(-5)));
    const sessionCalls = calls.slice(beforeCalls);
    assert.equal(sessionCalls.filter((call) => call.name === 'echo_settings').length, 1, JSON.stringify(sessionCalls));
    assert.deepEqual(sessionCalls.find((call) => call.name === 'echo_settings').input, { topic: 'template-topic', limit: 7, region: 'cn', include_metadata: false, filters: ['published'] });
    assert.equal(sessionCalls.some((call) => call.name === 'read_status'), false);
    assert.ok(modelRequests.some((request) => JSON.stringify(request).includes('SKILL_E2E_EXECUTED')));
    assert.ok(modelRequests.some((request) => JSON.stringify(request).includes('TEMPLATE_E2E_MEMORY')));
    assert.ok(db.prepare("SELECT count(*) AS count FROM hook_data_records WHERE record_type = 'template-e2e'").get().count > beforeRecords);
  } finally {
    clearTimeout(timeout);
    const sessionId = messages.find((message) => message.sessionId)?.sessionId;
    if (sessionId) await abortClaudeSDKSession(sessionId);
  }
});

const report = { root, base, results, calls, modelRequestCount: modelRequests.length, fixtureUrl, tenantId: tenant.id, workspace, template };
const reportPath = process.env.AGENT_TEMPLATE_E2E_REPORT || path.join(root, 'report.json');
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`E2E RESULT ${results.filter((item) => item.status === 'passed').length}/${results.length}; report=${reportPath}`);
if (serve) console.log(`E2E UI ${base}/admin ; login=template-qa-admin password=${password}`);
else process.exit(results.some((item) => item.status === 'failed') ? 1 : 0);
