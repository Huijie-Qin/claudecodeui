import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';

import {
  applyWorkspaceMcpHelperScripts,
  buildMcpHelperScriptMetadata,
  resolvePresetProbeConfig,
} from './mcp-helper-scripts.js';

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

function seedWorkspaceWithPreset(database) {
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
    path: '/tmp/placeholder',
  });
  const preset = multitenancy.mcpPresets.createPreset({
    tenantId: tenant.id,
    name: 'knowledge',
    displayName: 'Knowledge MCP',
    description: 'Search docs',
    config: {
      type: 'http',
      url: 'https://mcp.internal/knowledge',
      headersHelper: 'python3 auth.py',
    },
    status: 'published',
    createdByUserId: adminId,
  });
  multitenancy.mcpPresetHelperScripts.upsertScript({
    tenantId: tenant.id,
    presetId: preset.id,
    fileName: 'auth.py',
    content: 'import json\nprint(json.dumps({"Authorization": "Bearer dynamic"}))\n',
    uploadedByUserId: adminId,
  });
  multitenancy.mcpPresets.recordPresetTest({
    tenantId: tenant.id,
    presetId: preset.id,
    status: 'healthy',
    toolCount: 1,
    tools: [{ name: 'search_docs' }],
    dockerCompatible: true,
    updatedByUserId: adminId,
  });
  multitenancy.mcpInstalls.upsertInstall({
    workspaceId: workspace.id,
    presetId: preset.id,
    installedByUserId: userId,
    toolCount: 1,
    tools: [{ name: 'search_docs' }],
  });

  return { multitenancy, tenant, workspace, preset };
}

test('helper script metadata redacts script content', () => {
  const metadata = buildMcpHelperScriptMetadata({
    file_name: 'auth.py',
    content: 'print("secret")',
    size_bytes: 15,
    sha256: 'abc123',
    updated_at: '2026-05-09T00:00:00.000Z',
  });

  assert.deepEqual(metadata, {
    fileName: 'auth.py',
    sizeBytes: 15,
    sha256: 'abc123',
    updatedAt: '2026-05-09T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(metadata, 'content'), false);
});

test('workspace MCP config resolves uploaded helper script into private docker runtime home', async () => {
  const database = createTestDb();
  const { multitenancy, tenant, workspace } = seedWorkspaceWithPreset(database);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-helper-docker-'));
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  try {
    const mcpServers = {
      knowledge: {
        type: 'http',
        url: 'https://mcp.internal/knowledge',
        headersHelper: 'python3 auth.py',
      },
    };

    const resolved = await applyWorkspaceMcpHelperScripts(mcpServers, {
      tenantId: tenant.id,
      workspaceId: workspace.id,
      runtimeMode: 'docker',
      runtimeHomePath,
      multitenancy,
    });

    const scriptPath = path.join(runtimeHomePath, '.cloudcli', 'mcp-helpers', 'knowledge', 'auth.py');
    assert.equal(await fs.readFile(scriptPath, 'utf8'), 'import json\nprint(json.dumps({"Authorization": "Bearer dynamic"}))\n');
    assert.equal(
      resolved.knowledge.headersHelper,
      "cd '/home/cloudcli/.cloudcli/mcp-helpers/knowledge' && python3 auth.py",
    );
    assert.equal(resolved.knowledge.headersHelper.includes(workspacePath), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('preset probe resolves uploaded helper script into private host directory', async () => {
  const database = createTestDb();
  const { multitenancy, tenant, preset } = seedWorkspaceWithPreset(database);
  const helperRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-helper-probe-'));

  try {
    const resolved = await resolvePresetProbeConfig({
      tenantId: tenant.id,
      presetId: preset.id,
      presetName: preset.name,
      config: preset.config,
      helperRoot,
      multitenancy,
    });

    const scriptPath = path.join(helperRoot, `tenant-${tenant.id}`, `preset-${preset.id}`, 'auth.py');
    assert.match(resolved.headersHelper, /^cd '.+' && python3 auth\.py$/);
    assert.equal(await fs.readFile(scriptPath, 'utf8'), 'import json\nprint(json.dumps({"Authorization": "Bearer dynamic"}))\n');
  } finally {
    await fs.rm(helperRoot, { recursive: true, force: true });
  }
});
