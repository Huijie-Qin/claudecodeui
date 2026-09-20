import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { HOOK_CONFIG_SCHEMA_SQL, migrateHookConfigurationModel } from '../database/hook-config-schema.js';
import { createHookConfigService } from '../services/hook-configs.js';
import { createAgentTemplateService } from '../services/agent-templates.js';
import { createAgentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';
import { createTenantManagementRouter } from './tenant-management.js';

const hookInput = (name = '租户记录 Hook') => ({ name, description: '', eventName: 'Stop', matcher: {},
  extensionLogic: { language: 'javascript', code: 'export async function run() { return { output: { count: 1 } }; }', outputs: [{ name: 'count', type: 'number' }] },
  postActions: [], claudeResponse: { bindings: {} } });
const templateInput = (name = '租户 Agent', tenantId = 10) => ({ name, category: '业务助手', summary: '', claudeMarkdown: '# 租户助手', guideText: '', tenantIds: [tenantId], skillPresetRefs: [], mcpPresetRefs: [], hookRefs: [], claudeFolders: [] });

async function fixture(t, { skills } = {}) {
  const database = new Database(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-management-test-'));
  database.pragma('foreign_keys = ON');
  database.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, is_active INTEGER DEFAULT 1, is_system_admin INTEGER DEFAULT 0);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT);
    ${MULTITENANCY_SCHEMA_SQL} ${HOOK_CONFIG_SCHEMA_SQL}
    INSERT INTO users(id,username,is_system_admin) VALUES (1,'root',1),(2,'tenant-admin',0),(3,'member',0),(4,'other-admin',0);
    INSERT INTO tenants(id,code,name) VALUES (10,'alpha','甲租户'),(20,'beta','乙租户'),(30,'dataagent-admin','DataAgent管理');
    INSERT INTO tenant_users(tenant_id,user_id,role,permission,status) VALUES
      (10,2,'tenant_admin','edit','active'),(20,2,'member','edit','active'),(10,3,'member','edit','active'),(20,4,'tenant_admin','edit','active'),(30,2,'tenant_admin','edit','active');
    INSERT INTO workspaces(id,tenant_id,owner_user_id,slug,display_name,path) VALUES (100,10,2,'alpha','甲工作区','/tmp/tenant-fixture-alpha'),(200,20,2,'beta','乙工作区','/tmp/tenant-fixture-beta');`);
  const values = new Map();
  const hooks = createHookConfigService({ database, configStore: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) }, hookMcpCatalog: { listServers: () => [], listToolResources: () => [] } });
  const templates = createAgentTemplateService(database, { folderAssets: createAgentTemplateFolderAssetStore({ rootPath: root }) });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: Number(req.get('x-test-user') || 2), is_system_admin: 1 }; next(); }); // deliberately stale/forged JWT role
  app.use('/api/tenant-management', createTenantManagementRouter({ database, hooks, templates, skills: skills || { listConfigurationSkills: async () => ({ skills: [] }) } }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = async (resource, { method = 'GET', body, user = 2, tenant = 10 } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tenant-management/${tenant}${resource}`, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await response.json();
    return { status: response.status, ...payload };
  };
  return { database, hooks, templates, request };
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

test('legacy Hook ownership migration is additive and idempotent', () => {
  const database = new Database(':memory:');
  try {
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    database.exec(HOOK_CONFIG_SCHEMA_SQL.replace('  owner_tenant_id INTEGER,', ''));
    migrateHookConfigurationModel(database); migrateHookConfigurationModel(database);
    assert.ok(database.prepare('PRAGMA table_info(hooks)').all().some((column) => column.name === 'owner_tenant_id'));
  } finally { database.close(); }
});
