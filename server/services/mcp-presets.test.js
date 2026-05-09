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
  });

  assert.deepEqual(normalized, {
    name: 'knowledge_retrieval',
    displayName: 'Knowledge Retrieval MCP',
    description: 'Search internal docs',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headers: {
        Authorization: 'Bearer internal-secret',
      },
      headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
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

test('admin preset publish requires a successful test result', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const service = createMcpPresetService({
    multitenancy,
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

test('admin preset publish rejects healthy servers with no discovered tools', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const service = createMcpPresetService({
    multitenancy,
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

test('admin preset test validates current form input and persists discovered tools', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  const probedUrls = [];
  const probedHelpers = [];
  const service = createMcpPresetService({
    multitenancy,
    probeHttpMcpServer: async (config) => {
      probedUrls.push(config.url);
      probedHelpers.push(config.headersHelper);
      return {
        status: config.url.includes('/broken') ? 'failed' : 'healthy',
        phase: 'tools_list',
        error: config.url.includes('/broken') ? 'Not found' : '',
        toolCount: config.url.includes('/broken') ? 0 : 2,
        tools: config.url.includes('/broken') ? [] : [{ name: 'search_docs' }, { name: 'read_doc' }],
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
