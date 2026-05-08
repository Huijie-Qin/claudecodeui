import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';

import { readMcpDrafts, readWorkspaceMcpConfig, writeWorkspaceMcpConfig } from './workspace-tools.js';
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
    },
    status: 'published',
    createdByUserId: adminId,
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
  multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'draft-only',
    displayName: 'Draft Only MCP',
    description: 'Draft',
    config: { type: 'http', url: 'https://mcp.internal/draft' },
    status: 'draft',
    createdByUserId: adminId,
  });

  return { multitenancy, tenant, workspace, userId, published };
}

test('workspace mcp tools catalog lists only published presets and redacts config', () => {
  const database = createTestDb();
  const { multitenancy, tenant, workspace, published } = seedWorkspaceAndPresets(database);
  const service = createWorkspaceMcpToolsService({ multitenancy });

  const catalog = service.listWorkspaceMcpPresetCatalog({
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

test('workspace mcp tools install writes project mcp config without drafts', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const service = createWorkspaceMcpToolsService({ multitenancy });

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
    });
    assert.deepEqual(drafts.drafts, {});
    assert.equal(result.installed.writeTarget, 'Repo/.mcp.json');
    assert.equal(result.installed.containerPath, '/workspace/.mcp.json');
    assert.equal(result.summary.installed, 1);
  } finally {
    await cleanup();
  }
});

test('workspace mcp tools remove keeps unrelated unmanaged mcp servers', async () => {
  const database = createTestDb();
  const { workspacePath, cleanup } = await createWorkspacePath();
  try {
    const { multitenancy, tenant, workspace, userId, published } = seedWorkspaceAndPresets(database);
    const service = createWorkspaceMcpToolsService({ multitenancy });
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
