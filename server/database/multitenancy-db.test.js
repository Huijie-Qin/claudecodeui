import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from './schema.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';
import { createMultitenancyDb, initializeMultitenancyTables } from './multitenancy-db.js';

function createTestDb() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function seedUser(database, username) {
  const result = database
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, `hash-${username}`);
  return Number(result.lastInsertRowid);
}

test('multitenancy initialization migrates tenant production code column', () => {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  initializeMultitenancyTables(database);

  const columns = database.prepare('PRAGMA table_info(tenants)').all().map((column) => column.name);
  assert.equal(columns.includes('prod_code'), true);
  assert.equal(columns.includes('tenant_id'), false);
  assert.equal(columns.includes('prod_tenant_id'), false);
});

test('multitenancy initialization copies legacy prod_tenant_id into prod_code', () => {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      prod_tenant_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO tenants (code, name, prod_tenant_id)
    VALUES ('legacy', 'Legacy', 'prod-legacy');
  `);

  initializeMultitenancyTables(database);

  const tenant = database.prepare('SELECT code, prod_code FROM tenants WHERE code = ?').get('legacy');
  assert.deepEqual(tenant, { code: 'legacy', prod_code: 'prod-legacy' });
});

test('tenant membership controls visible tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const otherUserId = seedUser(database, 'bob');
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  const hiddenTenant = mt.tenants.createTenant({ code: 'hidden', name: 'Hidden' });

  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  mt.memberships.upsertMembership({
    tenantId: hiddenTenant.id,
    userId: otherUserId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });

  assert.deepEqual(
    mt.tenants.listTenantsForUser(userId).map((row) => row.code),
    ['acme'],
  );
  assert.equal(mt.memberships.getActiveMembership(userId, tenant.id).permission, 'edit');
  assert.equal(mt.memberships.getActiveMembership(userId, hiddenTenant.id), null);
});

test('tenant codes can be created and updated', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);

  const tenant = mt.tenants.createTenant({
    code: 'external',
    name: 'External',
    prodCode: 'prod-code-001',
  });

  assert.equal(tenant.code, 'external');
  assert.equal(tenant.prod_code, 'prod-code-001');

  const updatedTenant = mt.tenants.updateTenantCodes({
    id: tenant.id,
    code: 'external-updated',
    prodCode: 'prod-code-002',
  });

  assert.equal(updatedTenant.code, 'external-updated');
  assert.equal(updatedTenant.prod_code, 'prod-code-002');
});

test('system admin access can be granted across active tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const activeTenant = mt.tenants.createTenant({ code: 'active', name: 'Active' });
  const disabledTenant = mt.tenants.createTenant({ code: 'disabled', name: 'Disabled', status: 'disabled' });

  const memberships = mt.memberships.grantSystemAdminAccessToAllTenants(adminId);

  assert.deepEqual(memberships.map((row) => row.tenant_id), [activeTenant.id]);
  assert.equal(mt.memberships.getActiveMembership(adminId, activeTenant.id).permission, 'edit');
  assert.equal(mt.memberships.getMembership(adminId, disabledTenant.id), null);
});

test('tenant memberships can be listed and deleted with workspace ACL cleanup', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'view', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'view' }],
  });

  const listed = mt.memberships.listMemberships({ tenantId: tenant.id });
  assert.deepEqual(listed.map((row) => row.username), ['editor', 'owner']);

  assert.equal(mt.memberships.deleteMembership({ tenantId: tenant.id, userId: editorId }), true);
  assert.equal(mt.memberships.getMembership(editorId, tenant.id), null);
  assert.deepEqual(mt.workspaceAcl.listAcl(workspace.id), []);
});

test('workspace ACL grants access only inside the same tenant', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const outsiderId = seedUser(database, 'outsider');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: otherTenant.id, userId: outsiderId, role: 'member', permission: 'edit', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });

  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: ownerId }).map((row) => row.accessRole), ['owner']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: editorId }).map((row) => row.accessRole), ['edit']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: outsiderId }), []);
});

test('skill market imports are stored per workspace in the database', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  const imports = mt.skillMarketImports.replaceForWorkspace({
    workspaceId: workspace.id,
    imports: {
      '中文技能': {
        name: '中文技能',
        skillId: 'cn-skill',
        id: 'remote-cn-skill',
        skillName: '中文技能',
        nspPath: 'mock://skills/cn-skill',
        createUserId: 'owner',
        version: 3,
        source: 'skill-market-api',
        importedAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T01:00:00.000Z',
      },
    },
  });

  assert.equal(imports.length, 1);
  assert.deepEqual(mt.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), [{
    name: '中文技能',
    skillId: 'cn-skill',
    id: 'remote-cn-skill',
    skillName: '中文技能',
    nspPath: 'mock://skills/cn-skill',
    createUserId: 'owner',
    version: 3,
    source: 'skill-market-api',
    importedAt: '2026-05-14T00:00:00.000Z',
    updatedAt: '2026-05-14T01:00:00.000Z',
  }]);

  assert.equal(mt.skillMarketImports.deleteForWorkspace({ workspaceId: workspace.id, skillName: '中文技能' }), true);
  assert.deepEqual(mt.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), []);
});

test('sql check configuration resolves tenant defaults and user overrides', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });
  const otherWorkspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'api',
    displayName: 'API',
    path: '/tmp/cloudcli/team/owner/api',
  });

  const tenantConfig = mt.sqlCheck.replaceTenantConfig({
    tenantId: tenant.id,
    ruleIds: ['require_where', 'limit_rows', 'require_where'],
  });
  assert.deepEqual(tenantConfig.ruleIds, ['require_where', 'limit_rows']);
  assert.deepEqual(mt.sqlCheck.getTenantConfig(tenant.id), {
    tenantId: tenant.id,
    ruleIds: ['require_where', 'limit_rows'],
  });

  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: false,
    customEnabled: false,
    userRuleIds: [],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  assert.deepEqual(mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['limit_rows'],
  }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).effectiveRuleIds, ['limit_rows']);
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: otherWorkspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: otherWorkspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: false,
    customEnabled: false,
    userRuleIds: [],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: false,
    ruleIds: ['limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: true,
    customEnabled: false,
    userRuleIds: ['limit_rows'],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'tenant',
  });

  mt.sqlCheck.setUserPreference({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    customEnabled: true,
    ruleIds: ['require_where', 'limit_rows'],
  });
  assert.deepEqual(mt.sqlCheck.resolveUserConfig({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }), {
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    tenantRuleIds: ['require_where', 'limit_rows'],
    hasUserPreference: true,
    customEnabled: true,
    userRuleIds: ['require_where', 'limit_rows'],
    effectiveRuleIds: ['require_where', 'limit_rows'],
    source: 'user',
  });
});

test('mcp presets are isolated per tenant and can be filtered to published presets', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  const draft = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'draft',
    createdByUserId: adminId,
  });
  const published = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'data-query',
    displayName: 'Data Query MCP',
    description: 'Run internal lookups',
    config: { type: 'http', url: 'https://mcp.internal/data' },
    preinstallScope: 'all_workspaces',
    status: 'published',
    createdByUserId: adminId,
  });
  mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'disabled-search',
    displayName: 'Disabled Search MCP',
    description: 'Disabled preset',
    config: { type: 'http', url: 'https://mcp.internal/disabled' },
    status: 'disabled',
    createdByUserId: adminId,
  });
  mt.mcpPresets.createPreset({
    tenantId: otherTenant.id,
    name: 'knowledge',
    displayName: 'Other Tenant Knowledge MCP',
    description: 'Same name in another tenant is allowed',
    config: { type: 'http', url: 'https://mcp.other/knowledge' },
    status: 'published',
    createdByUserId: adminId,
  });

  assert.throws(() => mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Duplicate Knowledge MCP',
    description: 'Duplicate preset',
    config: { type: 'http', url: 'https://mcp.internal/dupe' },
    status: 'draft',
    createdByUserId: adminId,
  }));

  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id }).map((row) => row.name),
    ['data-query', 'disabled-search', 'knowledge'],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, status: 'published' }).map((row) => row.id),
    [published.id],
  );
  assert.equal(published.preinstall_scope, 'all_workspaces');
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, preinstallScope: 'all_workspaces' }).map((row) => row.id),
    [published.id],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: tenant.id, includeDisabled: false }).map((row) => row.id),
    [published.id, draft.id],
  );
  assert.deepEqual(
    mt.mcpPresets.listPresets({ tenantId: otherTenant.id }).map((row) => row.display_name),
    ['Other Tenant Knowledge MCP'],
  );
});

test('updating an mcp preset clears stale validation metadata', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'draft',
    createdByUserId: adminId,
  });
  mt.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: preset.id,
    status: 'healthy',
    toolCount: 2,
    tools: [{ name: 'search_docs' }, { name: 'read_doc' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });

  const updated = mt.mcpPresets.updatePreset({
    tenantId: tenant.id,
    presetId: preset.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Updated docs',
    config: { type: 'http', url: 'https://mcp.internal/updated' },
    status: 'draft',
    updatedByUserId: adminId,
  });

  assert.equal(updated.last_test_status, null);
  assert.equal(updated.last_test_error, null);
  assert.equal(updated.last_tested_at, null);
  assert.equal(updated.tool_count, 0);
  assert.deepEqual(updated.tools, []);
  assert.equal(updated.docker_compatible, 0);
});

test('mcp preset helper scripts are stored outside preset runtime config', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headersHelper: 'python3 auth.py',
    },
    status: 'draft',
    createdByUserId: adminId,
  });

  const script = mt.mcpPresetHelperScripts.upsertScript({
    tenantId: tenant.id,
    presetId: preset.id,
    fileName: 'auth.py',
    content: 'print("secret")\n',
    uploadedByUserId: adminId,
  });
  const fetchedPreset = mt.mcpPresets.getPresetById({ tenantId: tenant.id, presetId: preset.id });
  const fetchedScript = mt.mcpPresetHelperScripts.getScript({ tenantId: tenant.id, presetId: preset.id });

  assert.equal(script.file_name, 'auth.py');
  assert.equal(script.size_bytes, Buffer.byteLength('print("secret")\n', 'utf8'));
  assert.equal(fetchedScript.content, 'print("secret")\n');
  assert.equal(Object.hasOwn(fetchedPreset.config, 'helperScript'), false);
  assert.equal(Object.hasOwn(fetchedPreset.config, 'scriptContent'), false);
});

test('mcp preset installs are idempotent per workspace and preset', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });
  const preset = mt.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: { type: 'http', url: 'https://mcp.internal/knowledge' },
    status: 'published',
    createdByUserId: adminId,
  });

  const first = mt.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: userId,
    probeStatus: 'ok',
    probeError: null,
    toolCount: 2,
    tools: [{ name: 'search_docs' }],
  });
  const second = mt.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: userId,
    probeStatus: 'ok',
    probeError: null,
    toolCount: 3,
    tools: [{ name: 'search_docs' }, { name: 'read_doc' }, { name: 'summarize_doc' }],
  });

  assert.equal(second.workspace_id, first.workspace_id);
  assert.equal(second.preset_id, first.preset_id);
  assert.equal(second.status, 'installed');
  assert.equal(second.tool_count, 3);
  assert.deepEqual(
    mt.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }).map((row) => row.preset_id),
    [preset.id],
  );

  const probed = mt.mcpInstalls.recordProbe({
    workspaceId: workspace.id,
    presetId: preset.id,
    probeStatus: 'probe_failed',
    probeError: 'connection refused',
    toolCount: 0,
    tools: [],
  });

  assert.equal(probed.last_probe_status, 'probe_failed');
  assert.equal(probed.last_probe_error, 'connection refused');
  assert.equal(probed.tool_count, 0);

  const removed = mt.mcpInstalls.removeInstall({ workspaceId: workspace.id, presetId: preset.id });

  assert.equal(removed.status, 'removed');
  assert.deepEqual(mt.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }), []);
});

test('session index keeps shared workspace sessions private per user', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'editor-session',
    summary: 'Editor session',
    status: 'active',
  });

  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).map((row) => row.provider_session_id), ['owner-session']);
  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: editorId }).map((row) => row.provider_session_id), ['editor-session']);
  assert.equal(mt.sessions.findOwnedSession({ tenantId: tenant.id, userId: editorId, provider: 'claude', providerSessionId: 'owner-session' }), null);
});

test('session favorites persist per user and sort favorited sessions first', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    summary: 'Older session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'newer-session',
    summary: 'Newer session',
    status: 'active',
  });

  mt.sessionFavorites.setFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    favorited: true,
  });

  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), true);
  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), false);
  assert.deepEqual(
    mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId })
      .map((row) => [row.provider_session_id, row.is_favorited]),
    [['older-session', 1], ['newer-session', 0]],
  );

  mt.sessionFavorites.setFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
    favorited: false,
  });

  assert.equal(mt.sessionFavorites.isFavorite({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'older-session',
  }), false);
});

test('agent session runtime binds provider session id for resume', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  const runtime = mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });
  assert.equal(runtime.status, 'pending');
  assert.equal(runtime.provider_session_id, null);

  const bound = mt.runtimes.bindProviderSession({
    runtimeId: 'runtime-1',
    providerSessionId: 'claude-session-1',
  });

  assert.equal(bound.provider_session_id, 'claude-session-1');
  assert.equal(bound.status, 'active');
  assert.equal(
    mt.runtimes.findByProviderSession({
      tenantId: tenant.id,
      userId,
      workspaceId: workspace.id,
      provider: 'claude',
      providerSessionId: 'claude-session-1',
    }).runtime_id,
    'runtime-1',
  );
});

test('agent session messages persist normalized history idempotently', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  const messages = [
    {
      id: 'msg-1',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'hello',
    },
    {
      id: 'msg-2',
      sessionId: 'claude-session-1',
      timestamp: '2026-04-26T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'hi<|assistant|>',
    },
  ];

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });
  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages,
  });

  const history = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: null,
    offset: 0,
  });

  assert.equal(history.total, 2);
  assert.equal(history.hasMore, false);
  assert.deepEqual(history.messages.map((message) => message.id), ['msg-1', 'msg-2']);
  assert.equal(history.messages[1].content, 'hi');
});

test('agent session message history hides Claude meta messages from durable history', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  const changed = mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages: [
      {
        id: 'skill-meta-new',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:00.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        isMeta: true,
        content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
      },
      {
        id: 'visible-1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-12T00:00:02.000Z',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'visible',
      },
    ],
  });

  assert.equal(changed, 1);

  database.prepare(`
    INSERT INTO agent_session_messages (
      tenant_id,
      workspace_id,
      user_id,
      runtime_id,
      provider,
      provider_session_id,
      message_id,
      kind,
      role,
      content_text,
      normalized_json,
      provider_timestamp,
      sequence
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenant.id,
    workspace.id,
    userId,
    'runtime-1',
    'claude',
    'claude-session-1',
    'skill-meta-legacy',
    'text',
    'user',
    'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
    JSON.stringify({
      id: 'skill-meta-legacy',
      sessionId: 'claude-session-1',
      timestamp: '2026-05-12T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
    }),
    '2026-05-12T00:00:01.000Z',
    2,
  );

  const history = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: null,
    offset: 0,
  });

  assert.equal(history.total, 1);
  assert.deepEqual(history.messages.map((message) => message.id), ['visible-1']);
});

test('agent session message pagination returns recent messages in chronological order', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/alice/repo',
  });

  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    containerName: 'cloudcli-claude-t1-u1-w1-r1',
    image: 'cloudcli/test:claude',
    workspaceHostPath: workspace.path,
    runtimeHomePath: '/tmp/cloudcli/runtimes/runtime-1/home',
  });

  mt.sessionMessages.upsertMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    runtimeId: 'runtime-1',
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    messages: ['1', '2', '3', '4'].map((id) => ({
      id: `msg-${id}`,
      sessionId: 'claude-session-1',
      timestamp: `2026-04-26T00:00:0${id}.000Z`,
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: `message ${id}`,
    })),
  });

  const page = mt.sessionMessages.listMessages({
    tenantId: tenant.id,
    userId,
    workspaceId: workspace.id,
    provider: 'claude',
    providerSessionId: 'claude-session-1',
    limit: 2,
    offset: 1,
  });

  assert.equal(page.total, 4);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.messages.map((message) => message.id), ['msg-2', 'msg-3']);
});

test('runtime monitor lists runtimes with tenant user and workspace context', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'default', name: 'Default' });
  const user = { id: 1 };
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'admin', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: user.id,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: user.id,
    slug: 'demo',
    displayName: 'Demo Workspace',
    path: '/tmp/demo',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-1',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: user.id,
    provider: 'claude',
    providerSessionId: 'session-1',
    containerName: 'cloudcli-claude-demo',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/demo',
    runtimeHomePath: '/tmp/runtime/home',
    status: 'idle',
  });
  database.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(workspace.id);

  const result = mt.runtimes.listForMonitor({ limit: 20, offset: 0 });
  const row = mt.runtimes.getMonitorRowByRuntimeId('runtime-1');

  assert.equal(result.total, 1);
  assert.equal(result.rows[0].runtime_id, 'runtime-1');
  assert.equal(result.rows[0].tenant_code, 'default');
  assert.equal(result.rows[0].username, 'admin');
  assert.equal(result.rows[0].workspace_display_name, 'Demo Workspace');
  assert.equal(row.runtime_id, 'runtime-1');
  assert.equal(row.workspace_display_name, 'Demo Workspace');
});

test('runtime monitor filters by status and query text', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'alice', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'alpha',
    displayName: 'Alpha',
    path: '/tmp/alpha',
  });
  mt.runtimes.createRuntime({
    runtimeId: 'runtime-active',
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: 1,
    provider: 'claude',
    providerSessionId: 'session-alpha',
    containerName: 'container-alpha',
    image: 'cloudcli/test:claude',
    workspaceHostPath: '/tmp/alpha',
    runtimeHomePath: '/tmp/runtime/alpha',
    status: 'active',
  });

  const active = mt.runtimes.listForMonitor({ status: 'active', q: 'alpha' });
  const idle = mt.runtimes.listForMonitor({ status: 'idle', q: 'alpha' });

  assert.equal(active.total, 1);
  assert.equal(active.rows[0].runtime_id, 'runtime-active');
  assert.equal(idle.total, 0);
});

test('runtime monitor accepts query-shaped pagination filters', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'query', name: 'Query' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'pager', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'pages',
    displayName: 'Pages',
    path: '/tmp/pages',
  });
  for (const runtimeId of ['runtime-first', 'runtime-second']) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/pages',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status: 'idle',
    });
  }

  const result = mt.runtimes.listForMonitor({ limit: '1', offset: '1' });

  assert.equal(result.total, 2);
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 1);
  assert.deepEqual(result.rows.map((row) => row.runtime_id), ['runtime-first']);
});

test('runtime monitor selects expired idle runtimes only', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const [runtimeId, status] of [['old-idle', 'idle'], ['old-active', 'active']]) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status,
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', '-45 minutes')
      WHERE runtime_id = ?
    `).run(runtimeId);
  }
  database.prepare("UPDATE workspaces SET status = 'deleted' WHERE id = ?").run(workspace.id);

  const expired = mt.runtimes.listExpiredIdleRuntimes({ olderThanMinutes: 30, limit: 10 });

  assert.deepEqual(expired.map((row) => row.runtime_id), ['old-idle']);
});

test('runtime monitor pages expired idle runtimes with a stable cursor', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const runtimeId of ['old-idle-1', 'old-idle-2', 'old-idle-3']) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status: 'idle',
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', '-45 minutes')
      WHERE runtime_id = ?
    `).run(runtimeId);
  }

  const firstPage = mt.runtimes.listExpiredIdleRuntimes({ olderThanMinutes: 30, limit: 2 });
  const secondPage = mt.runtimes.listExpiredIdleRuntimes({
    olderThanMinutes: 30,
    limit: 2,
    cursor: {
      lastUsedAt: firstPage[1].last_used_at,
      id: firstPage[1].id,
    },
  });

  assert.deepEqual(firstPage.map((row) => row.runtime_id), ['old-idle-1', 'old-idle-2']);
  assert.deepEqual(secondPage.map((row) => row.runtime_id), ['old-idle-3']);
});

test('runtime monitor revalidates one expired idle runtime by id', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  database.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash')").run();
  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId: 1,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: 1,
    slug: 'work',
    displayName: 'Work',
    path: '/tmp/work',
  });
  for (const [runtimeId, status, age] of [
    ['old-idle', 'idle', '-45 minutes'],
    ['recent-idle', 'idle', '-5 minutes'],
    ['old-active', 'active', '-45 minutes'],
  ]) {
    mt.runtimes.createRuntime({
      runtimeId,
      tenantId: tenant.id,
      workspaceId: workspace.id,
      userId: 1,
      provider: 'claude',
      providerSessionId: `${runtimeId}-session`,
      containerName: `${runtimeId}-container`,
      image: 'cloudcli/test:claude',
      workspaceHostPath: '/tmp/work',
      runtimeHomePath: `/tmp/runtime/${runtimeId}`,
      status,
    });
    database.prepare(`
      UPDATE agent_session_runtime
      SET last_used_at = datetime('now', ?)
      WHERE runtime_id = ?
    `).run(age, runtimeId);
  }

  assert.equal(
    mt.runtimes.findExpiredIdleRuntimeById({
      runtimeId: 'old-idle',
      olderThanMinutes: 30,
    }).runtime_id,
    'old-idle',
  );
  assert.equal(mt.runtimes.findExpiredIdleRuntimeById({
    runtimeId: 'recent-idle',
    olderThanMinutes: 30,
  }), null);
  assert.equal(mt.runtimes.findExpiredIdleRuntimeById({
    runtimeId: 'old-active',
    olderThanMinutes: 30,
  }), null);
});
