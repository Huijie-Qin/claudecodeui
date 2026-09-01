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
      helperEnv: {
        ROOT_SECRET: 'dynamic-root-key',
      },
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
  const cloudcliPath = path.join(runtimeHomePath, '.cloudcli');
  const helperRoot = path.join(cloudcliPath, 'mcp-helpers');
  const chmodCalls = [];
  const chownCalls = [];
  const fsImpl = {
    mkdir: fs.mkdir.bind(fs),
    writeFile: fs.writeFile.bind(fs),
    chown: async (targetPath, uid, gid) => {
      chownCalls.push([targetPath, uid, gid]);
    },
    chmod: async (targetPath, mode) => {
      chmodCalls.push([targetPath, mode]);
      return fs.chmod(targetPath, mode);
    },
  };
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(helperRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(cloudcliPath, 0o700);
  await fs.chmod(helperRoot, 0o700);

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
      runtimeOwner: { uid: 1000, gid: 1000 },
      multitenancy,
      fsImpl,
    });

    const scriptPath = path.join(runtimeHomePath, '.cloudcli', 'mcp-helpers', 'knowledge', 'auth.py');
    const envPath = path.join(runtimeHomePath, '.cloudcli', 'mcp-helpers', 'knowledge', '.headers-helper.env.sh');
    const helperDirectory = path.dirname(scriptPath);
    assert.equal(await fs.readFile(scriptPath, 'utf8'), 'import json\nprint(json.dumps({"Authorization": "Bearer dynamic"}))\n');
    assert.equal(await fs.readFile(envPath, 'utf8'), "export ROOT_SECRET='dynamic-root-key'\n");
    assert.equal(
      resolved.knowledge.headersHelper,
      "cd '/home/cloudcli/.cloudcli/mcp-helpers/knowledge' && set -a && . './.headers-helper.env.sh' && set +a && python3 auth.py",
    );
    assert.equal(Object.hasOwn(resolved.knowledge, 'helperEnv'), false);
    assert.equal(resolved.knowledge.headersHelper.includes(workspacePath), false);
    assert.equal(chmodCalls.some(([targetPath, mode]) => targetPath === cloudcliPath && mode === 0o755), true);
    assert.equal(chmodCalls.some(([targetPath, mode]) => targetPath === helperRoot && mode === 0o755), true);
    assert.equal(chmodCalls.some(([targetPath, mode]) => targetPath === helperDirectory && mode === 0o755), true);
    assert.equal(chmodCalls.some(([targetPath, mode]) => targetPath === scriptPath && mode === 0o755), true);
    assert.equal(chmodCalls.some(([targetPath, mode]) => targetPath === envPath && mode === 0o644), true);
    for (const targetPath of [cloudcliPath, helperRoot, helperDirectory, scriptPath, envPath]) {
      assert.equal(
        chownCalls.some(([chownedPath, uid, gid]) => (
          chownedPath === targetPath && uid === 1000 && gid === 1000
        )),
        true,
        `${targetPath} should be owned by the Docker runtime user`,
      );
    }

    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(cloudcliPath)).mode & 0o777, 0o755);
      assert.equal((await fs.stat(helperRoot)).mode & 0o777, 0o755);
      assert.equal((await fs.stat(helperDirectory)).mode & 0o777, 0o755);
      assert.equal((await fs.stat(scriptPath)).mode & 0o777, 0o755);
      assert.equal((await fs.stat(envPath)).mode & 0o777, 0o644);
    }
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
    const envPath = path.join(helperRoot, `tenant-${tenant.id}`, `preset-${preset.id}`, '.headers-helper.env.sh');
    assert.match(resolved.headersHelper, /^cd '.+' && set -a && \. '\.\/\.headers-helper\.env\.sh' && set \+a && python3 auth\.py$/);
    assert.equal(await fs.readFile(scriptPath, 'utf8'), 'import json\nprint(json.dumps({"Authorization": "Bearer dynamic"}))\n');
    assert.equal(await fs.readFile(envPath, 'utf8'), "export ROOT_SECRET='dynamic-root-key'\n");
    assert.equal(Object.hasOwn(resolved, 'helperEnv'), false);
  } finally {
    await fs.rm(helperRoot, { recursive: true, force: true });
  }
});

test('workspace MCP config restores preset headersHelper after a same-name custom config omits it', async () => {
  const database = createTestDb();
  const { multitenancy, tenant, workspace } = seedWorkspaceWithPreset(database);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-helper-custom-'));
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');

  try {
    const resolved = await applyWorkspaceMcpHelperScripts({
      knowledge: {
        type: 'http',
        url: 'https://custom.example.com/mcp',
        headers: { 'X-Custom': 'custom' },
      },
    }, {
      tenantId: tenant.id,
      workspaceId: workspace.id,
      runtimeMode: 'docker',
      runtimeHomePath,
      multitenancy,
    });

    assert.equal(resolved.knowledge.url, 'https://custom.example.com/mcp');
    assert.deepEqual(resolved.knowledge.headers, { 'X-Custom': 'custom' });
    assert.equal(
      resolved.knowledge.headersHelper,
      "cd '/home/cloudcli/.cloudcli/mcp-helpers/knowledge' && set -a && . './.headers-helper.env.sh' && set +a && python3 auth.py",
    );
    assert.equal(Object.hasOwn(resolved.knowledge, 'helperEnv'), false);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('workspace MCP config respects an explicitly cleared headersHelper', async () => {
  const database = createTestDb();
  const { multitenancy, tenant, workspace } = seedWorkspaceWithPreset(database);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-helper-cleared-'));
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');

  try {
    const resolved = await applyWorkspaceMcpHelperScripts({
      knowledge: {
        type: 'http',
        url: 'https://custom.example.com/mcp',
        headersHelper: '',
      },
    }, {
      tenantId: tenant.id,
      workspaceId: workspace.id,
      runtimeMode: 'docker',
      runtimeHomePath,
      multitenancy,
    });

    assert.equal(resolved.knowledge.headersHelper, '');
    await assert.rejects(
      fs.access(path.join(runtimeHomePath, '.cloudcli', 'mcp-helpers', 'knowledge', 'auth.py')),
      { code: 'ENOENT' },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
