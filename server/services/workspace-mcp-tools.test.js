import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';

import { readMcpDrafts, readMcpStatus, readWorkspaceMcpConfig, writeWorkspaceMcpConfig } from './workspace-tools.js';
import { createWorkspaceMcpToolsService } from './workspace-mcp-tools.js';

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

async function createWorkspacePath() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mcp-tools-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  return {
    workspacePath,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

function seedWorkspaceAndPresets(database) {
  const multitenancy = createMultitenancyDb(database);
  const adminId = seedUser(database, 'admin');
  const userId = seedUser(database, 'alice');
  const tenant = multitenancy.tenants.createTenant({ code: 'team', name: 'Team' });
  multitenancy.memberships.upsertMembership({ tenantId: tenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = multitenancy.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: userId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/placeholder',
  });
  const published = multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search internal docs',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headers: { Authorization: 'Bearer internal-secret' },
      headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
      helperEnv: { ROOT_SECRET: 'internal-root-key' },
    },
    status: 'published',
    createdByUserId: adminId,
  });
  multitenancy.mcpPresetHelperScripts.upsertScript({
    tenantId: tenant.id,
    presetId: published.id,
    fileName: 'auth.py',
    content: 'print("secret")\n',
    uploadedByUserId: adminId,
  });
  multitenancy.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: published.id,
    status: 'healthy',
    error: null,
    toolCount: 1,
    tools: [{ name: 'search_docs' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });
  multitenancy.mcpPresets.publishPreset({
    tenantId: tenant.id,
    presetId: published.id,
    updatedByUserId: adminId,
  });
  multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'draft-only',
    displayName: 'Draft Only MCP',
    description: 'Draft',
    config: { type: 'http', url: 'https://mcp.internal/draft' },
    status: 'draft',
    createdByUserId: adminId,
  });
  multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'legacy-published',
    displayName: 'Legacy Published MCP',
    description: 'Published without a persisted healthy tools/list result',
    config: { type: 'http', url: 'https://mcp.internal/legacy' },
    status: 'published',
    createdByUserId: adminId,
  });

  return { multitenancy, tenant, workspace, userId, published };
}

function okProbe(tools = [{ name: 'search_docs' }]) {
  return async () => ({
    status: 'healthy',
    phase: 'tools_list',
    error: '',
    latencyMs: 12,
    toolCount: tools.length,
    tools,
  });
}

test('workspace mcp tools catalog lists only published presets and redacts config', async () => {
  const database = createTestDb();
  const { multitenancy, tenant, workspace, published } = seedWorkspaceAndPresets(database);
  const service = createWorkspaceMcpToolsService({ multitenancy });

  const catalog = await service.listWorkspaceMcpPresetCatalog({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    accessRole: 'view',
  });

  assert.deepEqual(catalog.summary, { available: 1, installed: 0 });
  assert.deepEqual(catalog.presets.map((preset) => preset.id), [published.id]);
  assert.equal(catalog.presets[0].userSetupRequired, false);
  assert.equal(catalog.presets[0].containerPath, '/workspace/.mcp.json');
  assert.equal(Object.hasOwn(catalog.presets[0], 'config'), false);
});

test('workspace mcp tools catalog probes installed presets and records connection state', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const seen = [];
    const service = createWorkspaceMcpToolsService({
      multitenancy,
      probeHttpMcpServer: async (config) => {
        seen.push(config);
        return {
          status: 'healthy',
          phase: 'tools_list',
          error: '',
          latencyMs: 8,
          toolCount: 2,
          tools: [{ name: 'fresh_search' }, { name: 'fresh_read' }],
        };
      },
    });
    await writeWorkspaceMcpConfig(workspacePath, {
      mcpServers: {
        knowledge: {
          type: 'http',
          url: 'https://mcp.internal/knowledge',
          headers: { Authorization: 'Bearer workspace-secret' },
        },
      },
    });
    multitenancy.mcpInstalls.upsertInstall({
      workspaceId: workspace.id,
      presetId: published.id,
      installedByUserId: userId,
      probeStatus: 'healthy',
      probeError: null,
      toolCount: 1,
      tools: [{ name: 'search_docs' }],
    });

    const catalog = await service.listWorkspaceMcpPresetCatalog({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      accessRole: 'view',
      now: () => new Date('2026-05-14T10:00:00.000Z'),
    });
    const status = await readMcpStatus(workspacePath);
    const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id });

    assert.deepEqual(seen, [{
      type: 'http',
      name: 'knowledge',
      url: 'https://mcp.internal/knowledge',
      headers: { Authorization: 'Bearer workspace-secret' },
    }]);
    assert.equal(catalog.presets[0].installed, true);
    assert.equal(catalog.presets[0].connectionStatus, 'connected');
    assert.equal(catalog.presets[0].probeStatus, 'healthy');
    assert.equal(catalog.presets[0].lastProbedAt, '2026-05-14T10:00:00.000Z');
    assert.deepEqual(catalog.presets[0].tools.map((tool) => tool.name), ['fresh_search', 'fresh_read']);
    assert.equal(status.servers.knowledge.status, 'healthy');
    assert.equal(status.servers.knowledge.toolCount, 2);
    assert.equal(installs[0].last_probe_status, 'healthy');
    assert.equal(installs[0].tool_count, 2);
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools catalog rewrites docker host URLs for local probe state', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const seen = [];
    const service = createWorkspaceMcpToolsService({
      multitenancy,
      env: { CLOUDCLI_MCP_PROBE_RUNTIME: 'host' },
      probeHttpMcpServer: async (config) => {
        seen.push(config);
        return {
          status: 'healthy',
          phase: 'tools_list',
          error: '',
          latencyMs: 8,
          toolCount: 1,
          tools: [{ name: 'fresh_search' }],
        };
      },
    });
    await writeWorkspaceMcpConfig(
      workspacePath,
      {
        mcpServers: {
          knowledge: {
            type: 'http',
            url: 'http://127.0.0.1:39999/mcp',
          },
        },
      },
      { env: { CLAUDE_EXECUTION_MODE: 'docker' } },
    );
    multitenancy.mcpInstalls.upsertInstall({
      workspaceId: workspace.id,
      presetId: published.id,
      installedByUserId: userId,
      probeStatus: 'probe_failed',
      probeError: 'previous failure',
      toolCount: 0,
      tools: [],
    });

    const catalog = await service.listWorkspaceMcpPresetCatalog({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      accessRole: 'view',
    });

    assert.equal(seen[0].url, 'http://127.0.0.1:39999/mcp');
    assert.equal(catalog.presets[0].installed, true);
    assert.equal(catalog.presets[0].connectionStatus, 'connected');
    assert.equal(catalog.presets[0].probeStatus, 'healthy');
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools catalog resolves uploaded helper scripts before probing', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const seen = [];
    const service = createWorkspaceMcpToolsService({
      multitenancy,
      users: {
        getUserById: () => ({ id: userId, username: 'alice' }),
        getEnvForUser: () => ({ USER_KEY: 'security:test-user-key' }),
      },
      probeHttpMcpServer: async (config) => {
        seen.push({
          headersHelper: config.headersHelper,
          W3_NAME: process.env.W3_NAME,
          USER_KEY: process.env.USER_KEY,
          TENANT_ID: process.env.TENANT_ID,
        });
        return {
          status: 'healthy',
          phase: 'tools_list',
          error: '',
          latencyMs: 8,
          toolCount: 1,
          tools: [{ name: 'fresh_search' }],
        };
      },
    });
    await writeWorkspaceMcpConfig(workspacePath, {
      mcpServers: {
        knowledge: {
          type: 'http',
          url: 'https://mcp.internal/knowledge',
          headersHelper: 'python3 auth.py',
        },
      },
    });
    multitenancy.mcpInstalls.upsertInstall({
      workspaceId: workspace.id,
      presetId: published.id,
      installedByUserId: userId,
      probeStatus: 'healthy',
      probeError: null,
      toolCount: 1,
      tools: [{ name: 'search_docs' }],
    });

    const catalog = await service.listWorkspaceMcpPresetCatalog({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      accessRole: 'view',
    });

    assert.equal(catalog.presets[0].connectionStatus, 'connected');
    assert.match(seen[0].headersHelper, /cd '.+mcp-helper-scripts.+tenant-\d+.+preset-\d+'/);
    assert.match(seen[0].headersHelper, /python3 auth\.py/);
    assert.equal(seen[0].W3_NAME, 'alice');
    assert.equal(seen[0].USER_KEY, 'security:test-user-key');
    assert.equal(seen[0].TENANT_ID, String(tenant.id));
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools catalog reports installed presets with missing workspace config as disconnected', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const service = createWorkspaceMcpToolsService({
      multitenancy,
      probeHttpMcpServer: okProbe(),
    });
    multitenancy.mcpInstalls.upsertInstall({
      workspaceId: workspace.id,
      presetId: published.id,
      installedByUserId: userId,
      probeStatus: 'healthy',
      probeError: null,
      toolCount: 1,
      tools: [{ name: 'search_docs' }],
    });

    const catalog = await service.listWorkspaceMcpPresetCatalog({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      accessRole: 'view',
    });

    assert.equal(catalog.presets[0].installed, true);
    assert.equal(catalog.presets[0].connectionStatus, 'probe_failed');
    assert.equal(catalog.presets[0].probePhase, 'config');
    assert.match(catalog.presets[0].probeError, /missing from \.mcp\.json/);
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools install writes project mcp config without drafts', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const service = createWorkspaceMcpToolsService({ multitenancy, probeHttpMcpServer: okProbe() });

    const result = await service.installWorkspaceMcpPreset({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      presetId: published.id,
      userId,
      workspaceDisplayName: 'Repo',
    });
    const config = await readWorkspaceMcpConfig(workspacePath);
    const drafts = await readMcpDrafts(workspacePath);

    assert.deepEqual(config.mcpServers.knowledge, {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headers: { Authorization: 'Bearer internal-secret' },
      headersHelper: '/opt/bin/get-mcp-auth-headers.sh',
    });
    assert.equal(JSON.stringify(config).includes('print("secret")'), false);
    assert.equal(JSON.stringify(config).includes('internal-root-key'), false);
    assert.equal(Object.hasOwn(config.mcpServers.knowledge, 'helperEnv'), false);
    assert.deepEqual(drafts.drafts, {});
    assert.equal(result.installed.writeTarget, 'Repo/.mcp.json');
    assert.equal(result.installed.containerPath, '/workspace/.mcp.json');
    assert.equal(result.summary.installed, 1);
    assert.equal(result.presets[0].connectionStatus, 'connected');
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools preinstall uses the standard install flow', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    multitenancy.mcpPresets.updatePreset({
      tenantId: tenant.id,
      presetId: published.id,
      name: published.name,
      displayName: published.display_name,
      description: published.description,
      config: published.config,
      preinstallScope: 'all_workspaces',
      status: 'published',
      updatedByUserId: userId,
    });
    multitenancy.mcpPresets.recordPresetTest({
      tenantId: tenant.id,
      presetId: published.id,
      status: 'healthy',
      error: null,
      toolCount: 1,
      tools: [{ name: 'search_docs' }],
      dockerCompatible: true,
      updatedByUserId: userId,
    });
    const service = createWorkspaceMcpToolsService({ multitenancy, probeHttpMcpServer: okProbe() });

    const result = await service.installPreinstalledWorkspaceMcpPresets({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      workspaceDisplayName: 'Repo',
      userId,
    });
    const config = await readWorkspaceMcpConfig(workspacePath);
    const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.installed.map((install) => install.name), ['knowledge']);
    assert.deepEqual(Object.keys(config.mcpServers), ['knowledge']);
    assert.equal(installs.length, 1);
    assert.equal(installs[0].preset_id, published.id);
    assert.equal(installs[0].status, 'installed');
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools remove keeps unrelated unmanaged mcp servers', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const service = createWorkspaceMcpToolsService({ multitenancy, probeHttpMcpServer: okProbe() });
    await writeWorkspaceMcpConfig(workspacePath, {
      mcpServers: {
        unmanaged: { type: 'http', url: 'https://mcp.internal/unmanaged' },
      },
    });
    await service.installWorkspaceMcpPreset({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      presetId: published.id,
      userId,
      workspaceDisplayName: 'Repo',
    });

    await service.removeWorkspaceMcpPreset({
      tenantId: tenant.id,
      workspaceId: workspace.id,
      workspacePath,
      presetId: published.id,
    });
    const config = await readWorkspaceMcpConfig(workspacePath);

    assert.deepEqual(Object.keys(config.mcpServers), ['unmanaged']);
    assert.equal(multitenancy.mcpInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }).length, 0);
  } finally {
    await cleanup();
  }
});
