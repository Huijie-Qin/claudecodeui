import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import Database from 'better-sqlite3';

import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { HOOK_CONFIG_SCHEMA_SQL, migrateHookConfigurationModel } from '../database/hook-config-schema.js';
import { createHookConfigService } from '../services/hook-configs.js';
import { createAgentTemplateService } from '../services/agent-templates.js';
import { createAgentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';
import { createSkillPresetService } from '../services/skill-presets.js';

import { createTenantManagementRouter } from './tenant-management.js';

const hookInput = (name = '租户记录 Hook') => ({ name, description: '', eventName: 'Stop', matcher: {},
  extensionLogic: { language: 'javascript', code: 'export async function run() { return { output: { count: 1 } }; }', outputs: [{ name: 'count', type: 'number' }] },
  postActions: [], claudeResponse: { bindings: {} } });
const templateInput = (name = '租户 Agent', tenantId = 10) => ({ name, category: '业务助手', summary: '', claudeMarkdown: '# 租户助手', guideText: '', tenantIds: [tenantId], skillPresetRefs: [], mcpPresetRefs: [], hookRefs: [], claudeFolders: [] });

const MARKET_SKILL = {
  id: 'remote-code-reviewer', skillId: 'code-reviewer', name: 'code-reviewer',
  displayName: 'Code Reviewer', description: 'Review code changes.',
  nspPath: 'mock://skills/code-reviewer', createUserId: 'market-author', version: 7,
};

function createFakeMarketService() {
  const calls = [];
  return {
    calls,
    listSkillMarket: async (options) => {
      calls.push({ method: 'listSkillMarket', options });
      return { skills: [{ ...MARKET_SKILL }], pageInfo: { page: options.page, pageSize: options.pageSize, total: 1 } };
    },
    fetchRemoteSkillDetail: async (skillRef, requestContext) => {
      calls.push({ method: 'fetchRemoteSkillDetail', skillRef, requestContext });
      return { ...MARKET_SKILL };
    },
    downloadRemoteSkillFiles: async (skill, requestContext) => {
      calls.push({ method: 'downloadRemoteSkillFiles', skillRef: skill.id, requestContext });
      return { skillName: skill.name, files: {
        'SKILL.md': '---\nname: code-reviewer\ndescription: Review code changes.\n---\n',
        'references/checklist.md': 'Check behavior and tenant boundaries.\n',
      } };
    },
  };
}

async function fixture(t, { skills, marketService = createFakeMarketService() } = {}) {
  const database = new Database(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-management-test-'));
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_active INTEGER DEFAULT 1, is_system_admin INTEGER DEFAULT 0);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
    ${MULTITENANCY_SCHEMA_SQL} ${HOOK_CONFIG_SCHEMA_SQL}
    INSERT INTO users(id,username,is_system_admin) VALUES (1,'root',1),(2,'tenant-admin',0),(3,'member',0),(4,'other-admin',0);
    INSERT INTO tenants(id,code,prod_code,name) VALUES (10,'alpha','alpha-market','甲租户'),(20,'beta','beta-market','乙租户'),(30,'dataagent-admin','dataagent-market','DataAgent管理');
    INSERT INTO tenant_users(tenant_id,user_id,role,permission,status) VALUES
      (10,2,'tenant_admin','edit','active'),(20,2,'member','edit','active'),(10,3,'member','edit','active'),(20,4,'tenant_admin','edit','active'),(30,2,'tenant_admin','edit','active');
    INSERT INTO workspaces(id,tenant_id,owner_user_id,slug,display_name,path) VALUES (100,10,2,'alpha','甲工作区','/tmp/tenant-fixture-alpha'),(200,20,2,'beta','乙工作区','/tmp/tenant-fixture-beta');`);
  const values = new Map();
  const hooks = createHookConfigService({ database, configStore: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) }, hookMcpCatalog: { listServers: () => [], listToolResources: () => [] } });
  const templates = createAgentTemplateService(database, { folderAssets: createAgentTemplateFolderAssetStore({ rootPath: root }) });
  const multitenancy = createMultitenancyDb(database);
  const skillPresets = createSkillPresetService({ multitenancy, marketService });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: Number(req.get('x-test-user') || 2), username: 'forged-account', is_system_admin: 1 }; next(); }); // deliberately stale/forged JWT role and account
  app.use('/api/tenant-management', createTenantManagementRouter({ database, hooks, templates, skillPresets, skills: skills || { listConfigurationSkills: async () => ({ skills: [] }) } }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (resource, { method = 'GET', body, user = 2, tenant = 10 } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tenant-management/${tenant}${resource}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json();
    return { status: response.status, ...payload };
  };
  return { database, hooks, templates, multitenancy, skillPresets, marketService, request };
}

test('live roles: edit permission is not tenant administration; inactive/revoked access fails closed', async (t) => {
  const { request, database } = await fixture(t);
  assert.equal((await request('/capabilities')).status, 200);
  assert.equal((await request('/capabilities', { user: 3 })).status, 403);
  assert.equal((await request('/hooks', { tenant: 20 })).status, 403);
  assert.equal((await request('/capabilities', { tenant: 20, user: 1 })).status, 200);
  assert.equal((await request('/capabilities', { tenant: 'invalid' })).status, 400);
  database.prepare("UPDATE tenant_users SET role='member' WHERE tenant_id=10 AND user_id=2").run();
  assert.equal((await request('/hooks', { method: 'POST', body: hookInput() })).status, 403);
  database.prepare("UPDATE tenant_users SET role='tenant_admin',status='disabled' WHERE tenant_id=10 AND user_id=2").run();
  assert.equal((await request('/capabilities')).status, 403);
  database.prepare("UPDATE tenant_users SET status='active' WHERE tenant_id=10 AND user_id=2").run();
  database.prepare('UPDATE users SET is_active=0 WHERE id=2').run();
  assert.equal((await request('/capabilities')).status, 401);
  database.prepare('UPDATE users SET is_active=1 WHERE id=2').run();
  database.prepare("UPDATE tenants SET status='disabled' WHERE id=10").run();
  assert.equal((await request('/capabilities')).status, 403);
});

test('Hook CRUD, atomic tenant-only publishing, cross-tenant and platform ownership isolation', async (t) => {
  const { request, hooks, database } = await fixture(t);
  const foreign = hooks.createHook({ input: hookInput('乙 Hook'), userId: 4, ownerTenantId: 20 });
  const platform = hooks.createHook({ input: hookInput('平台 Hook'), userId: 1 });
  const result = await request('/hooks', { method: 'POST', body: { ...hookInput(), ownerTenantId: 20, activationScope: 'all_users' } });
  assert.equal(result.status, 200);
  const hook = result.hook;
  assert.equal(hook.ownerTenantId, 10);
  assert.equal(hook.bindingController, 'admin');
  assert.deepEqual((await request('/hooks')).hooks.map((item) => item.id), [hook.id]);
  for (const target of [foreign, platform]) {
    for (const method of ['PUT', 'DELETE']) assert.equal((await request(`/hooks/${target.id}`, { method, body: hookInput() })).status, 404);
    assert.equal((await request(`/hooks/${target.id}/publish`, { method: 'POST' })).status, 404);
  }
  assert.equal((await request(`/hooks/${hook.id}/publish`, { method: 'POST', body: { defaultEnabled: 'bad' } })).status, 400);
  assert.equal(hooks.getHook(hook.id).status, 'draft');
  assert.equal((await request(`/hooks/${hook.id}/publish`, { method: 'POST', body: { defaultEnabled: true } })).status, 200);
  assert.deepEqual(database.prepare('SELECT tenant_id FROM hook_tenant_bindings WHERE hook_id=?').all(hook.id), [{ tenant_id: 10 }]);
  assert.throws(() => hooks.replaceHookBindings({ hookId: hook.id, scope: 'all_users', boundBy: 1 }), { statusCode: 403 });
  assert.throws(() => hooks.assignWorkspaceHook({ workspaceId: 200, hookId: hook.id, createdBy: 2 }), { statusCode: 403 });
  assert.ok(hooks.listAvailableHooksForContext({ tenantId: 10, workspaceId: 100, userId: 2 }).some((item) => item.id === hook.id));
  assert.ok(!hooks.listAvailableHooksForContext({ tenantId: 20, workspaceId: 200, userId: 2 }).some((item) => item.id === hook.id));
  assert.ok(!hooks.listAvailableHooksForUser(2).some((item) => item.id === hook.id), 'tenant-owned Hooks require an explicit tenant/workspace context');
  assert.equal((await request(`/hooks/${hook.id}`, { method: 'PUT', body: { ...hookInput('重命名'), ownerTenantId: 20 } })).hook.ownerTenantId, 10);
  assert.equal((await request(`/hooks/${hook.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(hooks.getHook(hook.id), null);
});

test('Agent template lifecycle stays tenant-local, including DataAgent special tenant and dependencies', async (t) => {
  const { request, templates, hooks } = await fixture(t);
  const foreign = templates.saveTemplate({ input: templateInput('乙模板', 20), userId: 4, ownerTenantId: 20 });
  const platform = templates.saveTemplate({ input: templateInput('平台模板'), userId: 1 });
  const foreignHook = hooks.createHook({ input: hookInput(), userId: 4, ownerTenantId: 20 });
  hooks.publishHook({ hookId: foreignHook.id, userId: 4 });
  assert.ok(!(await request('/agent-templates/hook-catalog')).hooks.some((item) => item.id === foreignHook.id));
  for (const body of [{ ...templateInput(), tenantIds: [10, 20] }, { ...templateInput(), globalVisible: true }, { ...templateInput(), skillPresetRefs: [{ tenantId: 20, presetId: 1 }] }]) {
    assert.equal((await request('/agent-templates', { method: 'POST', body })).status, 403);
  }
  const crossHook = await request('/agent-templates', { method: 'POST', body: { ...templateInput(), hookRefs: [{ hookId: foreignHook.id, version: 1, defaultEnabled: true, showInChat: true, allowUserDisable: true, order: 0 }] } });
  assert.notEqual(crossHook.status, 200);
  const { template, status } = await request('/agent-templates', { method: 'POST', body: templateInput() });
  assert.equal(status, 200);
  assert.equal(template.ownerTenantId, 10);
  assert.deepEqual((await request('/agent-templates')).templates.map((item) => item.id), [template.id]);
  for (const target of [foreign, platform]) {
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await request(`/agent-templates/${target.id}`, { method, ...(method === 'PUT' ? { body: templateInput() } : {}) })).status, 404);
    for (const action of ['publish', 'disable']) assert.equal((await request(`/agent-templates/${target.id}/${action}`, { method: 'POST' })).status, 404);
  }
  assert.equal((await request(`/agent-templates/${template.id}/publish`, { method: 'POST' })).template.status, 'published');
  assert.ok(templates.listAvailableTemplates({ tenantId: 10 }).some((item) => item.id === template.id));
  assert.ok(!templates.listAvailableTemplates({ tenantId: 20 }).some((item) => item.id === template.id));
  assert.throws(() => templates.resolveTemplateSnapshot({ templateId: template.id, tenantId: 20 }), { statusCode: 403 });
  assert.equal((await request(`/agent-templates/${template.id}/disable`, { method: 'POST' })).template.status, 'disabled');
  assert.equal((await request(`/agent-templates/${template.id}`, { method: 'PUT', body: templateInput('已修改') })).template.ownerTenantId, 10);
  assert.equal((await request(`/agent-templates/${template.id}`, { method: 'DELETE' })).status, 409);
  await request(`/agent-templates/${template.id}/disable`, { method: 'POST' });
  assert.equal((await request(`/agent-templates/${template.id}`, { method: 'DELETE' })).status, 200);
  const special = await request('/agent-templates', { method: 'POST', tenant: 30, body: templateInput('DataAgent 租户私有', 30) });
  assert.equal(special.template.globalVisible, false);
  assert.equal((await request(`/agent-templates/${special.template.id}/publish`, { method: 'POST', tenant: 30 })).status, 200);
  assert.ok(!templates.listAvailableTemplates({ tenantId: 20 }).some((item) => item.id === special.template.id));
});

test('tenant administrators can inspect owned Hook executions with immutable tenant and Hook boundaries', async (t) => {
  const { database, hooks, request } = await fixture(t);
  const own = hooks.createHook({ input: hookInput('本租户'), userId: 2, ownerTenantId: 10 });
  const peer = hooks.createHook({ input: hookInput('同租户另一管理员'), userId: 4, ownerTenantId: 10 });
  const platform = hooks.createHook({ input: hookInput('平台下发'), userId: 1 });
  const foreign = hooks.createHook({ input: hookInput('其他租户'), userId: 4, ownerTenantId: 20 });
  const add = database.prepare(`INSERT INTO hook_executions(id,hook_id,user_id,tenant_id,workspace_id,event_name,status,
    started_at_ms,completed_at_ms,duration_ms,input_json,script_output_json,logs_json)
    VALUES(?,?,3,?,100,'Stop',?,1000,1250,250,'{"task":"tenant detail"}','{"count":5}','["done"]')`);
  add.run('own-success', own.id, 10, 'succeeded');
  add.run('own-failed', own.id, 10, 'failed');
  add.run('own-cross-tenant', own.id, 20, 'succeeded');
  add.run('own-unknown-tenant', own.id, null, 'succeeded');
  add.run('peer', peer.id, 10, 'succeeded');
  add.run('platform', platform.id, 10, 'succeeded');
  add.run('foreign', foreign.id, 20, 'succeeded');
  const base = `/hooks/${own.id}/executions`;
  const list = await request(`${base}?tenantId=20&hookId=${platform.id}&limit=1`);
  assert.equal(list.status, 200);
  assert.equal(list.total, 2); assert.equal(list.executionTotal, 2);
  assert.equal(list.executions.length, 1);
  assert.equal(list.executions[0].tenantId, 10);
  assert.equal(list.executions[0].hookId, own.id);
  assert.equal(list.executions[0].input, null, 'list contains lightweight summaries');
  const next = await request(`${base}?limit=1&offset=1`);
  assert.notEqual(next.executions[0].id, list.executions[0].id);
  assert.deepEqual((await request(`${base}?status=failed`)).executions.map(row => row.id), ['own-failed']);
  assert.equal((await request(`${base}?q=not-found`)).total, 0);
  const detail = await request(`${base}/own-success`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.execution.scriptOutput, { count: 5 });
  assert.deepEqual(detail.execution.logs, ['done']);
  assert.equal((await request(`/hooks/${peer.id}/executions`)).total, 1);
  for (const id of ['own-cross-tenant', 'own-unknown-tenant', 'platform', 'foreign', 'peer', 'missing']) {
    assert.equal((await request(`${base}/${id}?tenantId=20`)).status, 404, id);
  }
  for (const hook of [platform, foreign]) {
    assert.equal((await request(`/hooks/${hook.id}/executions`)).status, 404);
    assert.equal((await request(`/hooks/${hook.id}/executions/platform`)).status, 404);
  }
  assert.equal((await request(base, { user: 3 })).status, 403);
  assert.equal((await request(base, { tenant: 20 })).status, 403);
  database.exec("UPDATE tenant_users SET role='member' WHERE tenant_id=10 AND user_id=2");
  assert.equal((await request(base)).status, 403);
  assert.equal((await request(`${base}/own-success`)).status, 403);
});

test('Admin-distributed Hooks and templates remain usable but never become tenant-editable', async (t) => {
  const { request, hooks, templates } = await fixture(t);
  const platformHook = hooks.createHook({ input: hookInput('Admin 下发 Hook'), userId: 1 });
  hooks.publishHook({ hookId: platformHook.id, userId: 1 });
  hooks.replaceHookBindings({ hookId: platformHook.id, scope: 'tenants', tenantIds: [10], defaultEnabled: true, boundBy: 1 });
  const platformTemplate = templates.saveTemplate({ input: templateInput('Admin 下发模板'), userId: 1 });
  templates.publishTemplate({ templateId: platformTemplate.id, userId: 1 });

  const hookBefore = hooks.getHook(platformHook.id);
  const templateBefore = templates.getTemplate(platformTemplate.id);
  assert.equal(hookBefore.ownerTenantId, null);
  assert.equal(templateBefore.ownerTenantId, null);
  assert.ok((await request('/agent-templates/hook-catalog')).hooks.some((item) => item.id === platformHook.id));
  assert.ok(templates.listAvailableTemplates({ tenantId: 10 }).some((item) => item.id === platformTemplate.id));
  assert.deepEqual((await request('/hooks')).hooks, []);
  assert.deepEqual((await request('/agent-templates')).templates, []);

  // Forged ownership/creator fields and a valid tenant admin role cannot turn
  // distribution rights into permission to edit the original platform config.
  const forgedOwner = { ownerTenantId: 10, owner_tenant_id: 10, createdBy: 2, created_by_user_id: 2 };
  for (const operation of [
    { path: `/hooks/${platformHook.id}`, method: 'PUT', body: { ...hookInput('不应覆盖'), ...forgedOwner } },
    { path: `/hooks/${platformHook.id}/publish`, method: 'POST', body: { defaultEnabled: false, ...forgedOwner } },
    { path: `/hooks/${platformHook.id}`, method: 'DELETE' },
    { path: `/agent-templates/${platformTemplate.id}`, method: 'PUT', body: { ...templateInput('不应覆盖'), ...forgedOwner } },
    { path: `/agent-templates/${platformTemplate.id}/publish`, method: 'POST' },
    { path: `/agent-templates/${platformTemplate.id}/disable`, method: 'POST' },
    { path: `/agent-templates/${platformTemplate.id}`, method: 'DELETE' },
  ]) assert.equal((await request(operation.path, operation)).status, 404, `${operation.method} ${operation.path}`);

  const ownTemplate = await request('/agent-templates', { method: 'POST', body: {
    ...templateInput('引用平台 Hook 的租户模板'),
    hookRefs: [{ hookId: platformHook.id, version: 1, defaultEnabled: true, showInChat: true, allowUserDisable: true, order: 0 }],
  } });
  assert.equal(ownTemplate.status, 200);
  assert.equal(ownTemplate.template.ownerTenantId, 10);
  assert.equal(ownTemplate.template.hookRefs[0].hookId, platformHook.id);
  assert.deepEqual(hooks.getHook(platformHook.id), hookBefore);
  assert.deepEqual(templates.getTemplate(platformTemplate.id), templateBefore);
});

test('authorization is rechecked after asynchronous resource loading before publication', async (t) => {
  let revoke = () => {};
  const f = await fixture(t, { skills: { listConfigurationSkills: async () => { revoke(); return { skills: [] }; } } });
  const template = f.templates.saveTemplate({ input: templateInput(), userId: 2, ownerTenantId: 10 });
  revoke = () => f.database.prepare("UPDATE tenant_users SET role='member' WHERE user_id=2 AND tenant_id=10").run();
  assert.equal((await f.request(`/agent-templates/${template.id}/publish`, { method: 'POST' })).status, 403);
  assert.equal(f.templates.getTemplate(template.id).status, 'draft');
});

test('tenant Skill market uses live tenant/account context and market pagination even without presets', async (t) => {
  const { request, database, marketService } = await fixture(t);
  assert.deepEqual((await request('/skill-presets')).presets, []);
  assert.deepEqual((await request('/agent-templates/preset-catalog')).skills, []);
  const market = await request('/skill-presets/market?searchContent=review&page=2&pageSize=5&complete=true&tenantId=20&tenantCode=beta&accountId=root');
  assert.equal(market.status, 200);
  assert.equal(market.skills[0].id, MARKET_SKILL.id);
  assert.deepEqual(market.pageInfo, { page: 2, pageSize: 5, total: 1 });
  assert.deepEqual(marketService.calls[0], { method: 'listSkillMarket', options: {
    searchContent: 'review', page: 2, pageSize: 5, completeInventory: true,
    tenantCode: 'alpha-market', accountId: 'tenant-admin', includePageInfo: true,
  } });
  database.prepare('UPDATE users SET username=? WHERE id=2').run('renamed-tenant-admin');
  database.prepare('UPDATE tenants SET prod_code=? WHERE id=10').run('  alpha-market-renamed  ');
  assert.equal((await request('/skill-presets/market?q=check&complete=false')).status, 200);
  assert.deepEqual(marketService.calls[1].options, {
    searchContent: 'check', page: 1, pageSize: 20, completeInventory: false,
    tenantCode: 'alpha-market-renamed', accountId: 'renamed-tenant-admin', includePageInfo: true,
  });
  for (const query of ['page=0', 'page=bad', 'pageSize=-1', 'pageSize=1.5']) {
    assert.equal((await request(`/skill-presets/market?${query}`)).status, 400, query);
  }
  assert.equal(marketService.calls.length, 2, 'invalid pagination must not reach the market');
});

test('a new market Skill can be prepared and published into a tenant Agent template without platform preinstallation', async (t) => {
  const { request, database, marketService, templates } = await fixture(t);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tenant_skill_presets').get().count, 0);
  const created = await request('/skill-presets', { method: 'POST', body: {
    sourceRef: MARKET_SKILL.id, tenantId: 20, userId: 1, createdByUserId: 1,
    tenantCode: 'beta', accountId: 'root', preinstall: true, preinstallScope: 'all_workspaces', status: 'published',
    skill: { id: 'forged-id', name: 'forged-name', displayName: '伪造名称', nspPath: 'mock://untrusted' },
  } });
  assert.equal(created.status, 200);
  const { preset } = created;
  assert.equal(preset.tenantId, 10);
  assert.equal(preset.createdByUserId, 2);
  assert.equal(preset.name, MARKET_SKILL.name);
  assert.equal(preset.remoteId, MARKET_SKILL.id);
  assert.equal(preset.nspPath, MARKET_SKILL.nspPath);
  assert.equal(preset.status, 'draft');
  assert.equal(preset.preinstall, false);
  assert.equal(preset.preinstallScope, 'none');
  assert.equal((await request(`/skill-presets/${preset.id}/publish`, { method: 'POST' })).status, 400);
  const validated = await request(`/skill-presets/${preset.id}/validate`, { method: 'POST', body: { tenantId: 20, tenantCode: 'beta', accountId: 'root' } });
  assert.equal(validated.status, 200);
  assert.equal(validated.validation.status, 'healthy');
  const published = await request(`/skill-presets/${preset.id}/publish`, { method: 'POST' });
  assert.equal(published.status, 200);
  assert.equal(published.preset.status, 'published');
  assert.equal(published.preset.preinstall, false);
  for (const call of marketService.calls) {
    assert.deepEqual(call.requestContext, { tenantCode: 'alpha-market', accountId: 'tenant-admin', ...(call.method === 'fetchRemoteSkillDetail' ? { exactId: true } : {}) });
    assert.equal(call.skillRef, MARKET_SKILL.id);
  }
  const duplicate = await request('/skill-presets', { method: 'POST', body: { skill: { id: MARKET_SKILL.id } } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.preset.id, preset.id);
  assert.equal(duplicate.preset.status, 'published');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tenant_skill_presets').get().count, 1);
  assert.equal((await request('/agent-templates/preset-catalog')).skills[0].id, preset.id);
  const skillPresetRefs = [{ tenantId: 10, presetId: preset.id }];
  const saved = await request('/agent-templates', { method: 'POST', body: { ...templateInput('市场技能模板'), skillPresetRefs } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.template.skillPresetRefs, skillPresetRefs);
  const publishedTemplate = await request(`/agent-templates/${saved.template.id}/publish`, { method: 'POST' });
  assert.equal(publishedTemplate.status, 200);
  assert.equal(publishedTemplate.template.status, 'published');
  assert.ok(templates.listAvailableTemplates({ tenantId: 10 }).some((item) => item.id === saved.template.id));
  assert.ok(!templates.listAvailableTemplates({ tenantId: 20 }).some((item) => item.id === saved.template.id));
});

test('tenant Skill endpoints reject members and isolate preset IDs across tenants', async (t) => {
  const { request, skillPresets, database, marketService } = await fixture(t);
  const foreign = await skillPresets.createPreset({ tenantId: 20, userId: 4, input: { sourceRef: MARKET_SKILL.id }, tenantCode: 'beta', accountId: 'other-admin' });
  const own = (await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } })).preset;
  assert.deepEqual((await request('/skill-presets?tenantId=20')).presets.map((preset) => preset.id), [own.id]);
  assert.deepEqual((await request('/skill-presets', { tenant: 20, user: 4 })).presets.map((preset) => preset.id), [foreign.id]);
  const callsBefore = marketService.calls.length;
  const rowsBefore = database.prepare('SELECT * FROM tenant_skill_presets ORDER BY id').all();
  for (const action of ['validate', 'publish']) {
    assert.equal((await request(`/skill-presets/${foreign.id}/${action}`, { method: 'POST', body: { tenantId: 20 } })).status, 404);
    assert.equal((await request(`/skill-presets/${own.id}/${action}`, { method: 'POST', tenant: 20, user: 4 })).status, 404);
  }
  for (const operation of [
    { path: '/skill-presets/market' }, { path: '/skill-presets' },
    { path: '/skill-presets', method: 'POST', body: { sourceRef: MARKET_SKILL.id } },
    { path: `/skill-presets/${own.id}/validate`, method: 'POST' },
    { path: `/skill-presets/${own.id}/publish`, method: 'POST' },
  ]) {
    assert.equal((await request(operation.path, { ...operation, user: 3 })).status, 403);
    assert.equal((await request(operation.path, { ...operation, tenant: 20 })).status, 403);
  }
  assert.equal(marketService.calls.length, callsBefore);
  assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets ORDER BY id').all(), rowsBefore);
});

test('tenant market preparation cannot mutate platform, disabled, or auto-preinstalled presets', async (t) => {
  const { request, multitenancy, database, marketService } = await fixture(t);
  const variants = [
    { name: 'platform-draft', createdByUserId: 1, status: 'draft', preinstallScope: 'none' },
    { name: 'platform-disabled', createdByUserId: 1, status: 'disabled', preinstallScope: 'none' },
    { name: 'own-disabled', createdByUserId: 2, status: 'disabled', preinstallScope: 'none' },
    { name: 'own-preinstalled', createdByUserId: 2, status: 'draft', preinstallScope: 'all_workspaces' },
    { name: 'platform-preinstalled-published', createdByUserId: 1, status: 'published', preinstallScope: 'all_workspaces' },
    { name: 'peer-draft', createdByUserId: 4, status: 'draft', preinstallScope: 'none' },
  ];
  for (const variant of variants) {
    const preset = multitenancy.skillPresets.createPreset({ tenantId: 10, displayName: variant.name,
      skillId: variant.name, remoteId: variant.name, ...variant });
    const before = database.prepare('SELECT * FROM tenant_skill_presets WHERE id=?').get(preset.id);
    for (const action of ['validate', 'publish']) {
      assert.equal((await request(`/skill-presets/${preset.id}/${action}`, { method: 'POST', body: { createdByUserId: 2, preinstall: false, status: 'draft' } })).status, variant.preinstallScope === 'all_workspaces' ? 404 : 409, `${variant.name}: ${action}`);
    }
    assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets WHERE id=?').get(preset.id), before);
  }
  assert.equal(marketService.calls.length, 0, 'protected presets never trigger market downloads');
  assert.ok((await request('/skill-presets?usage=tenant')).presets.every((preset) => preset.preinstallScope === 'none'),
    'template skill listings never expose tenant preinstallation records');

  const own = (await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } })).preset;
  await request(`/skill-presets/${own.id}/validate`, { method: 'POST' });
  await request(`/skill-presets/${own.id}/publish`, { method: 'POST' });
  const before = database.prepare('SELECT * FROM tenant_skill_presets WHERE id=?').get(own.id);
  const callCount = marketService.calls.length;
  for (const action of ['validate', 'publish']) {
    assert.equal((await request(`/skill-presets/${own.id}/${action}`, { method: 'POST' })).status, 200);
  }
  assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets WHERE id=?').get(own.id), before);
  assert.equal(marketService.calls.length, callCount, 'published presets are idempotent and do not revalidate');
});

test('market failures do not create unusable presets or allow failed validation to publish', async (t) => {
  const { request, database, marketService } = await fixture(t);
  const originalDetail = marketService.fetchRemoteSkillDetail;
  const originalDownload = marketService.downloadRemoteSkillFiles;
  marketService.listSkillMarket = async () => { throw Object.assign(new Error('Market unavailable'), { statusCode: 503 }); };
  const search = await request('/skill-presets/market');
  assert.equal(search.status, 503);
  assert.equal(search.error, 'Market unavailable');
  for (const method of ['fetchRemoteSkillDetail', 'downloadRemoteSkillFiles']) {
    marketService[method] = async () => { throw Object.assign(new Error('Market download failed'), { statusCode: 502 }); };
    const result = await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } });
    assert.equal(result.status, 502, method);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tenant_skill_presets').get().count, 0);
    marketService.fetchRemoteSkillDetail = originalDetail;
    marketService.downloadRemoteSkillFiles = originalDownload;
  }
  const own = (await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } })).preset;
  marketService.downloadRemoteSkillFiles = async () => { throw new Error('Skill package is unreadable'); };
  const validation = await request(`/skill-presets/${own.id}/validate`, { method: 'POST' });
  assert.equal(validation.status, 200);
  assert.equal(validation.validation.status, 'failed');
  assert.equal(validation.preset.lastValidationError, 'Skill package is unreadable');
  assert.equal((await request(`/skill-presets/${own.id}/publish`, { method: 'POST' })).status, 400);
  assert.equal(database.prepare('SELECT status FROM tenant_skill_presets WHERE id=?').get(own.id).status, 'draft');
  assert.deepEqual((await request('/agent-templates/preset-catalog')).skills, []);
});

test('revoking access during remote Skill loading prevents creation and validation writes', async (t) => {
  for (const action of ['create', 'validate', 'failed-validation']) {
    await t.test(action, async (t) => {
      const { request, database, marketService } = await fixture(t);
      const preset = action === 'create' ? null
        : (await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } })).preset;
      const rowsBefore = database.prepare('SELECT * FROM tenant_skill_presets').all();
      const originalDownload = marketService.downloadRemoteSkillFiles;
      let started;
      let release;
      const loading = new Promise((resolve) => { started = resolve; });
      const released = new Promise((resolve) => { release = resolve; });
      marketService.downloadRemoteSkillFiles = async (...args) => {
        started();
        await released;
        if (action === 'failed-validation') throw new Error('Download failed after access revocation');
        return originalDownload(...args);
      };
      const pending = request(action === 'create' ? '/skill-presets' : `/skill-presets/${preset.id}/validate`, {
        method: 'POST', body: { sourceRef: MARKET_SKILL.id },
      });
      await loading;
      database.prepare("UPDATE tenant_users SET role='member' WHERE tenant_id=10 AND user_id=2").run();
      release();
      assert.equal((await pending).status, 403);
      assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets').all(), rowsBefore,
        'no preset, validation error, or audit timestamp may be written after access is revoked');
    });
  }
});

test('legacy Hook ownership migration is additive and idempotent', () => {
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    database.exec(HOOK_CONFIG_SCHEMA_SQL.replace('  owner_tenant_id INTEGER,', ''));
    migrateHookConfigurationModel(database); migrateHookConfigurationModel(database);
    assert.ok(database.prepare('PRAGMA table_info(hooks)').all().some((column) => column.name === 'owner_tenant_id'));
  } finally { database.close(); }
});


test('upstream market authentication errors do not masquerade as tenant access revocation', async (t) => {
  for (const upstreamStatus of [401, 403]) {
    for (const failingMethod of ['listSkillMarket', 'fetchRemoteSkillDetail', 'downloadRemoteSkillFiles']) {
      await t.test(`${failingMethod}: upstream ${upstreamStatus}`, async (t) => {
        const marketService = createFakeMarketService();
        let failedMarketCalls = 0;
        marketService[failingMethod] = async () => {
          failedMarketCalls += 1;
          // The real market HTTP client preserves the upstream HTTP status and
          // marks rejected JSON responses. It is not a local membership denial.
          throw Object.assign(new Error(`Skill market credentials rejected (${upstreamStatus})`), {
            statusCode: upstreamStatus, marketRejected: true,
          });
        };
        const { request, database } = await fixture(t, { marketService });
        const response = failingMethod === 'listSkillMarket'
          ? await request('/skill-presets/market?complete=true')
          : await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } });
        assert.equal(failedMarketCalls, 1);
        assert.equal((await request('/capabilities')).status, 200, 'the live tenant administrator retains access');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tenant_skill_presets').get().count, 0);
        assert.equal(response.error, `技能市场请求失败：Skill market credentials rejected (${upstreamStatus})`);
        assert.equal(response.status, 502,
          'upstream auth failures must not trigger the tenant API adapter onForbidden handler');
      });
    }
  }
});


test('tenant market requests require prod_code without falling back to the local tenant code', async (t) => {
  for (const prodCode of [null, '', '   ']) {
    await t.test(`prod_code=${JSON.stringify(prodCode)}`, async (t) => {
      const { request, database, marketService } = await fixture(t);
      const created = await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } });
      assert.equal(created.status, 200);
      database.prepare('UPDATE tenants SET prod_code=? WHERE id=10').run(prodCode);
      const rowsBefore = database.prepare('SELECT * FROM tenant_skill_presets').all();
      const callsBefore = marketService.calls.length;
      for (const operation of [
        { resource: '/skill-presets/market?complete=true' },
        { resource: '/skill-presets', method: 'POST', body: { sourceRef: MARKET_SKILL.id } },
        { resource: `/skill-presets/${created.preset.id}/validate`, method: 'POST' },
      ]) {
        const response = await request(operation.resource, operation);
        assert.equal(response.status, 400, operation.resource);
        assert.match(response.error, /prod_code/, 'explain the missing external tenant configuration');
      }
      assert.equal((await request('/capabilities')).status, 200);
      assert.equal(marketService.calls.length, callsBefore, 'no market call may use the local tenant code as fallback');
      assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets').all(), rowsBefore);
    });
  }
});

test('local access revocation takes precedence over simultaneous market authentication failures', async (t) => {
  for (const upstreamStatus of [401, 403]) {
    for (const action of ['list', 'create']) {
      for (const localState of ['revoked', 'inactive']) {
        await t.test(`${action}: upstream ${upstreamStatus}, user ${localState}`, async (t) => {
          const { request, database, marketService } = await fixture(t);
          const rowsBefore = database.prepare('SELECT * FROM tenant_skill_presets').all();
          const method = action === 'list' ? 'listSkillMarket' : 'downloadRemoteSkillFiles';
          marketService[method] = async () => {
            if (localState === 'revoked') {
              database.prepare("UPDATE tenant_users SET role='member' WHERE tenant_id=10 AND user_id=2").run();
            } else {
              database.prepare('UPDATE users SET is_active=0 WHERE id=2').run();
            }
            throw Object.assign(new Error('Market credentials rejected while access changed'), {
              statusCode: upstreamStatus, marketRejected: true,
            });
          };
          const response = action === 'list'
            ? await request('/skill-presets/market')
            : await request('/skill-presets', { method: 'POST', body: { sourceRef: MARKET_SKILL.id } });
          assert.equal(response.status, localState === 'revoked' ? 403 : 401);
          assert.doesNotMatch(response.error, /技能市场请求失败/);
          assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets').all(), rowsBefore);
        });
      }
    }
  }
});
