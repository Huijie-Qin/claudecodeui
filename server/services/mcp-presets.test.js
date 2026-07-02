import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';

import {
  createMcpPresetService,
  normalizePresetInput,
  toWorkspacePreset,
} from './mcp-presets.js';

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

function createTestUsers(database, envByUserId = new Map()) {
  return {
    getUserById: (userId) => database
      .prepare('SELECT id, username FROM users WHERE id = ?')
      .get(userId),
    getEnvForUser: (userId) => envByUserId.get(Number(userId)) || {},
  };
}

test('normalizes admin preset input while workspace serialization redacts connection secrets', () => {
  const normalized = normalizePresetInput({
    name: 'knowledge_retrieval',
    displayName: 'Knowledge Retrieval MCP',
    description: 'Search internal docs',
    type: 'http',
    url: 'https://mcp.internal/knowledge',
    headers: {
      Authorization: 'Bearer internal-secret',
    },
    headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
    helperEnv: {
      ROOT_SECRET: 'internal-root-key',
    },
  });

  assert.deepEqual(normalized, {
    name: 'knowledge_retrieval',
    displayName: 'Knowledge Retrieval MCP',
    description: 'Search internal docs',
    preinstallScope: 'none',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headers: {
        Authorization: 'Bearer internal-secret',
      },
      headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
      helperEnv: {
        ROOT_SECRET: 'internal-root-key',
      },
    },
  });

  const workspacePreset = toWorkspacePreset({
    id: 1,
    name: normalized.name,
    display_name: normalized.displayName,
    description: normalized.description,
    transport: 'http',
    status: 'published',
    docker_compatible: 1,
    tool_count: 2,
    tools: [{ name: 'search_docs' }],
    config: normalized.config,
  });

  assert.equal(workspacePreset.displayName, 'Knowledge Retrieval MCP');
  assert.equal(workspacePreset.userSetupRequired, false);
  assert.equal(workspacePreset.containerPath, '/workspace/.mcp.json');
  assert.equal(Object.hasOwn(workspacePreset, 'config'), false);
  assert.equal(Object.hasOwn(workspacePreset, 'url'), false);
  assert.equal(Object.hasOwn(workspacePreset, 'headers'), false);
});

test('workspace mcp server config redacts helper environment secrets', () => {
  const normalized = normalizePresetInput({
    name: 'knowledge_retrieval',
    displayName: 'Knowledge Retrieval MCP',
    type: 'http',
    url: 'https://mcp.internal/knowledge',
    headersHelper: 'python3 auth.py',
    helperEnv: {
      ROOT_SECRET: 'internal-root-key',
    },
  });

  assert.deepEqual(normalized.config.helperEnv, {
    ROOT_SECRET: 'internal-root-key',
  });
});

test('admin preset publish requires a successful test result', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const service = createMcpPresetService({
    multitenancy,
    users: createTestUsers(database),
    probeHttpMcpServer: async () => ({
      status: 'healthy',
      phase: 'tools_list',
      toolCount: 2,
      tools: [{ name: 'search_docs' }, { name: 'read_doc' }],
    }),
  });

  const preset = service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      description: 'Search internal docs',
      status: 'published',
      type: 'http',
      url: 'https://mcp.internal/knowledge',
    },
  });

  assert.equal(preset.status, 'draft');
  assert.throws(
    () => service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId }),
    /successful test/,
  );

  const tested = await service.testPreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
  });
  const published = service.publishPreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
  });

  assert.equal(tested.lastTestStatus, 'healthy');
  assert.equal(tested.toolCount, 2);
  assert.equal(published.status, 'published');
});

test('admin preset test temporarily injects user env into host process', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const originalUserKey = process.env.USER_KEY;
  const hadOriginalUserKey = Object.hasOwn(process.env, 'USER_KEY');
  const originalW3Name = process.env.W3_NAME;
  const hadOriginalW3Name = Object.hasOwn(process.env, 'W3_NAME');
  let observedEnv = null;

  try {
    process.env.USER_KEY = 'outer-user-key';
    delete process.env.W3_NAME;

    const service = createMcpPresetService({
      multitenancy,
      users: createTestUsers(database, new Map([[adminId, { USER_KEY: 'security:admin-user-key' }]])),
      probeHttpMcpServer: async () => {
        assert.equal(process.env.W3_NAME, 'admin');
        observedEnv = {
          USER_KEY: process.env.USER_KEY,
          W3_NAME: process.env.W3_NAME,
        };
        return {
          status: 'healthy',
          phase: 'tools_list',
          toolCount: 1,
          tools: [{ name: 'lookup' }],
        };
      },
    });

    const preset = service.createPreset({
      tenantId: tenant.id,
      userId: adminId,
      input: {
        name: 'env_test',
        displayName: 'Env Test MCP',
        type: 'http',
        url: 'https://mcp.internal/env',
      },
    });

    await service.testPreset({
      tenantId: tenant.id,
      presetId: preset.id,
      userId: adminId,
    });

    assert.deepEqual(observedEnv, {
      USER_KEY: 'security:admin-user-key',
      W3_NAME: 'admin',
    });
    assert.equal(process.env.USER_KEY, 'outer-user-key');
    assert.equal(Object.hasOwn(process.env, 'W3_NAME'), false);
  } finally {
    if (hadOriginalUserKey) {
      process.env.USER_KEY = originalUserKey;
    } else {
      delete process.env.USER_KEY;
    }
    if (hadOriginalW3Name) {
      process.env.W3_NAME = originalW3Name;
    } else {
      delete process.env.W3_NAME;
    }
  }
});

test('admin preset publish rejects healthy servers with no discovered tools', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const service = createMcpPresetService({
    multitenancy,
    users: createTestUsers(database),
    probeHttpMcpServer: async () => ({
      status: 'healthy',
      phase: 'tools_list',
      toolCount: 0,
      tools: [],
    }),
  });

  const preset = service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      name: 'empty',
      displayName: 'Empty MCP',
      type: 'http',
      url: 'https://mcp.internal/empty',
    },
  });

  const tested = await service.testPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId });

  assert.equal(tested.lastTestStatus, 'healthy');
  assert.equal(tested.toolCount, 0);
  assert.throws(
    () => service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId }),
    /at least one tool/,
  );
});

test('admin preset helper script can be deleted and clears stale validation state', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const service = createMcpPresetService({ multitenancy });

  const preset = service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      name: 'with_helper',
      displayName: 'With Helper MCP',
      type: 'http',
      url: 'https://mcp.internal/helper',
      headersHelper: 'python3 auth.py',
    },
  });
  const uploaded = service.uploadHelperScript({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    originalName: 'auth.py',
    content: 'print("{}")\n',
  });
  multitenancy.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: preset.id,
    status: 'healthy',
    toolCount: 1,
    tools: [{ name: 'lookup' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });
  multitenancy.mcpPresets.publishPreset({
    tenantId: tenant.id,
    presetId: preset.id,
    updatedByUserId: adminId,
  });

  const deleted = service.deleteHelperScript({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
  });

  assert.equal(uploaded.helperScript.fileName, 'auth.py');
  assert.equal(deleted.helperScript, null);
  assert.equal(deleted.status, 'draft');
  assert.equal(deleted.lastTestStatus, null);
  assert.equal(deleted.toolCount, 0);
  assert.equal(multitenancy.mcpPresetHelperScripts.getScript({ tenantId: tenant.id, presetId: preset.id }), null);
});

test('admin preset copy creates and updates target tenant presets with helper scripts', () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const sourceTenant = multitenancy.tenants.createTenant({ code: 'source', name: 'Source' });
  const newTargetTenant = multitenancy.tenants.createTenant({ code: 'new-target', name: 'New Target' });
  const existingTargetTenant = multitenancy.tenants.createTenant({ code: 'existing-target', name: 'Existing Target' });
  const service = createMcpPresetService({ multitenancy });

  const sourcePreset = service.createPreset({
    tenantId: sourceTenant.id,
    userId: adminId,
    input: {
      name: 'shared_knowledge',
      displayName: 'Shared Knowledge MCP',
      description: 'Search shared docs',
      type: 'http',
      url: 'https://mcp.internal/shared',
      headersHelper: 'python3 auth.py',
      helperEnv: {
        ROOT_SECRET: 'root-key',
      },
      preinstall: true,
    },
  });
  service.uploadHelperScript({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    userId: adminId,
    originalName: 'auth.py',
    content: 'print("source")\n',
  });
  const existingPreset = service.createPreset({
    tenantId: existingTargetTenant.id,
    userId: adminId,
    input: {
      name: 'shared_knowledge',
      displayName: 'Old Knowledge MCP',
      description: 'Old docs',
      type: 'http',
      url: 'https://mcp.internal/old',
    },
  });
  service.uploadHelperScript({
    tenantId: existingTargetTenant.id,
    presetId: existingPreset.id,
    userId: adminId,
    originalName: 'old.py',
    content: 'print("old")\n',
  });

  const copied = service.copyPresetToTenants({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    targetTenantIds: [newTargetTenant.id, existingTargetTenant.id, sourceTenant.id, 99999],
    userId: adminId,
  });
  const createdResult = copied.results.find((result) => result.tenantId === newTargetTenant.id);
  const updatedResult = copied.results.find((result) => result.tenantId === existingTargetTenant.id);
  const createdScript = multitenancy.mcpPresetHelperScripts.getScript({
    tenantId: newTargetTenant.id,
    presetId: createdResult.preset.id,
  });
  const updatedScript = multitenancy.mcpPresetHelperScripts.getScript({
    tenantId: existingTargetTenant.id,
    presetId: existingPreset.id,
  });

  assert.deepEqual(copied.summary, {
    total: 4,
    created: 1,
    updated: 1,
    skipped: 2,
    failed: 0,
  });
  assert.equal(createdResult.action, 'created');
  assert.equal(createdResult.preset.name, 'shared_knowledge');
  assert.equal(createdResult.preset.config.url, 'https://mcp.internal/shared');
  assert.equal(createdResult.preset.preinstallScope, 'all_workspaces');
  assert.equal(createdResult.preset.helperScript.fileName, 'auth.py');
  assert.equal(createdScript.content, 'print("source")\n');
  assert.equal(updatedResult.action, 'updated');
  assert.equal(updatedResult.preset.id, existingPreset.id);
  assert.equal(updatedResult.preset.displayName, 'Shared Knowledge MCP');
  assert.equal(updatedResult.preset.config.helperEnv.ROOT_SECRET, 'root-key');
  assert.equal(updatedResult.preset.helperScript.fileName, 'auth.py');
  assert.equal(updatedScript.content, 'print("source")\n');
  assert.deepEqual(
    copied.results
      .filter((result) => result.action === 'skipped')
      .map((result) => result.reason)
      .sort(),
    ['source_tenant', 'tenant_not_found'],
  );
});

test('admin preset copy preserves published status and test metadata', () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const userId = seedUser(database, 'alice');
  const sourceTenant = multitenancy.tenants.createTenant({ code: 'source', name: 'Source' });
  const targetTenant = multitenancy.tenants.createTenant({ code: 'target', name: 'Target' });
  multitenancy.memberships.upsertMembership({
    tenantId: targetTenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = multitenancy.workspaces.createWorkspace({
    tenantId: targetTenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/repo',
  });
  const service = createMcpPresetService({ multitenancy });

  const sourcePreset = service.createPreset({
    tenantId: sourceTenant.id,
    userId: adminId,
    input: {
      name: 'published_knowledge',
      displayName: 'Published Knowledge MCP',
      description: 'Search published docs',
      type: 'http',
      url: 'https://mcp.internal/published',
      headersHelper: 'python3 auth.py',
      preinstall: true,
    },
  });
  service.uploadHelperScript({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    userId: adminId,
    originalName: 'auth.py',
    content: 'print("source")\n',
  });
  multitenancy.mcpPresets.recordPresetTest({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    status: 'healthy',
    toolCount: 2,
    tools: [{ name: 'search_docs' }, { name: 'read_doc' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });
  multitenancy.mcpPresets.publishPreset({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    updatedByUserId: adminId,
  });
  const staleTargetPreset = service.createPreset({
    tenantId: targetTenant.id,
    userId: adminId,
    input: {
      name: 'published_knowledge',
      displayName: 'Stale Knowledge MCP',
      type: 'http',
      url: 'https://mcp.internal/stale',
    },
  });

  const copied = service.copyPresetToTenants({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    targetTenantIds: [targetTenant.id],
    userId: adminId,
  });
  const updatedResult = copied.results[0];
  const workspacePresets = service.listWorkspacePresets({
    tenantId: targetTenant.id,
    workspaceId: workspace.id,
  });

  assert.equal(updatedResult.action, 'updated');
  assert.equal(updatedResult.preset.id, staleTargetPreset.id);
  assert.equal(updatedResult.preset.status, 'published');
  assert.equal(updatedResult.preset.preinstallScope, 'all_workspaces');
  assert.equal(updatedResult.preset.lastTestStatus, 'healthy');
  assert.equal(updatedResult.preset.toolCount, 2);
  assert.equal(updatedResult.preset.dockerCompatible, true);
  assert.equal(updatedResult.preset.helperScript.fileName, 'auth.py');
  assert.deepEqual(updatedResult.preset.tools.map((tool) => tool.name), ['search_docs', 'read_doc']);
  assert.deepEqual(workspacePresets.map((preset) => preset.name), ['published_knowledge']);
});

test('admin preset copy removes stale target helper scripts when the source has none', () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const sourceTenant = multitenancy.tenants.createTenant({ code: 'source', name: 'Source' });
  const targetTenant = multitenancy.tenants.createTenant({ code: 'target', name: 'Target' });
  const service = createMcpPresetService({ multitenancy });

  const sourcePreset = service.createPreset({
    tenantId: sourceTenant.id,
    userId: adminId,
    input: {
      name: 'plain',
      displayName: 'Plain MCP',
      type: 'http',
      url: 'https://mcp.internal/plain',
    },
  });
  const targetPreset = service.createPreset({
    tenantId: targetTenant.id,
    userId: adminId,
    input: {
      name: 'plain',
      displayName: 'Plain MCP',
      type: 'http',
      url: 'https://mcp.internal/old',
      headersHelper: 'python3 old.py',
    },
  });
  service.uploadHelperScript({
    tenantId: targetTenant.id,
    presetId: targetPreset.id,
    userId: adminId,
    originalName: 'old.py',
    content: 'print("old")\n',
  });

  const copied = service.copyPresetToTenants({
    tenantId: sourceTenant.id,
    presetId: sourcePreset.id,
    targetTenantIds: [targetTenant.id],
    userId: adminId,
  });

  assert.equal(copied.results[0].action, 'updated');
  assert.equal(copied.results[0].preset.helperScript, null);
  assert.equal(multitenancy.mcpPresetHelperScripts.getScript({
    tenantId: targetTenant.id,
    presetId: targetPreset.id,
  }), null);
});

test('admin preset test validates current form input and persists discovered tools', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const probedUrls = [];
  const probedHelpers = [];
  const service = createMcpPresetService({
    multitenancy,
    users: createTestUsers(database),
    probeHttpMcpServer: async (config) => {
      probedUrls.push(config.url);
      probedHelpers.push(config.headersHelper);
      return {
        status: config.url.includes('/broken') ? 'failed' : 'healthy',
        phase: 'tools_list',
        error: config.url.includes('/broken') ? 'Not found' : '',
        toolCount: config.url.includes('/broken') ? 0 : 2,
      tools: config.url.includes('/broken') ? [] : [
        {
          name: 'search_docs',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
          },
        },
        { name: 'read_doc' },
      ],
      };
    },
  });

  const preset = service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      description: 'Search internal docs',
      type: 'http',
      url: 'https://mcp.internal/knowledge',
    },
  });

  const tested = await service.testPreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    input: {
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      description: 'Search internal docs',
      type: 'http',
      url: 'https://mcp.internal/broken',
      headersHelper: '/opt/bin/get-form-headers.sh',
    },
  });
  const stored = multitenancy.mcpPresets.getPresetById({ tenantId: tenant.id, presetId: preset.id });

  assert.deepEqual(probedUrls, ['https://mcp.internal/broken']);
  assert.deepEqual(probedHelpers, ['/opt/bin/get-form-headers.sh']);
  assert.equal(tested.lastTestStatus, 'failed');
  assert.equal(tested.lastTestError, 'Not found');
  assert.equal(stored.config.url, 'https://mcp.internal/broken');
  assert.equal(stored.config.headersHelper, '/opt/bin/get-form-headers.sh');
  assert.equal(stored.last_test_status, 'failed');
  assert.equal(stored.tool_count, 0);

  const healthy = await service.testPreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    input: {
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      description: 'Search internal docs',
      type: 'http',
      url: 'https://mcp.internal/knowledge',
    },
  });
  assert.deepEqual(healthy.tools[0].inputSchema, {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
  });
});

test('workspace presets omit legacy published rows without healthy tools', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const userId = seedUser(database, 'alice');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  multitenancy.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  const workspace = multitenancy.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/repo',
  });
  const service = createMcpPresetService({ multitenancy });

  const visible = multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'visible',
    displayName: 'Visible MCP',
    config: { type: 'http', url: 'https://mcp.internal/visible' },
    status: 'published',
    createdByUserId: adminId,
  });
  multitenancy.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: visible.id,
    status: 'healthy',
    toolCount: 1,
    tools: [{ name: 'lookup' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });
  multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'legacy',
    displayName: 'Legacy MCP',
    config: { type: 'http', url: 'https://mcp.internal/legacy' },
    status: 'published',
    createdByUserId: adminId,
  });

  const presets = service.listWorkspacePresets({ tenantId: tenant.id, workspaceId: workspace.id });

  assert.deepEqual(presets.map((preset) => preset.name), ['visible']);
});
