import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';

import { createSkillPresetService } from './skill-presets.js';
import { readSkillsMetadata } from './workspace-skills.js';

const REMOTE_SKILL = {
  id: 'remote-code-reviewer',
  skillId: 'code-reviewer',
  name: 'code-reviewer',
  displayName: 'Code Reviewer',
  description: 'Review code changes.',
  nspPath: 'mock://skills/code-reviewer',
  createUserId: 'skill-author',
  version: 7,
};

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

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-skill-presets-'));
}

function createFakeMarketService({ remoteSkill = REMOTE_SKILL, files = null, skillName = 'code-reviewer' } = {}) {
  const calls = [];
  return {
    calls,
    listSkillMarket: async () => ({ skills: [remoteSkill], pageInfo: { page: 1, pageSize: 20, total: 1 } }),
    fetchRemoteSkillDetail: async (skillRef, requestContext) => {
      calls.push({ method: 'fetchRemoteSkillDetail', skillRef, requestContext });
      return { ...remoteSkill };
    },
    downloadRemoteSkillFiles: async (skill, requestContext) => {
      calls.push({ method: 'downloadRemoteSkillFiles', skillRef: skill.id || skill.skillId, requestContext });
      return {
        skillName,
        files: files || {
          'SKILL.md': [
            '---',
            'name: code-reviewer',
            'description: Review code changes.',
            '---',
          ].join('\n'),
          'references/checklist.md': 'Look for regressions and missing tests.\n',
        },
      };
    },
  };
}

function seedTenantWorkspace({ database, multitenancy, workspacePath }) {
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
    path: workspacePath,
  });
  return { adminId, userId, tenant, workspace };
}

test('admin skill presets validate, publish, and install managed Skill files into a workspace', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const workspacePath = await makeWorkspace();
  const { adminId, userId, tenant, workspace } = seedTenantWorkspace({ database, multitenancy, workspacePath });
  const marketService = createFakeMarketService();
  const service = createSkillPresetService({ multitenancy, marketService });

  const preset = await service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      sourceRef: 'remote-code-reviewer',
      preinstall: true,
    },
    tenantCode: tenant.code,
    accountId: 'admin',
  });

  assert.equal(preset.status, 'draft');
  assert.equal(preset.name, 'code-reviewer');
  assert.equal(preset.displayName, 'Code Reviewer');
  assert.equal(preset.preinstallScope, 'all_workspaces');
  assert.equal(preset.remoteId, 'remote-code-reviewer');
  assert.throws(
    () => service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId }),
    /successful validation/,
  );

  const validated = await service.validatePreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    tenantCode: tenant.code,
    accountId: 'admin',
  });
  const published = service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId });

  assert.equal(validated.validation.status, 'healthy');
  assert.equal(published.status, 'published');

  const installed = await service.installWorkspaceSkillPreset({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    workspacePath,
    presetId: preset.id,
    userId,
    tenantCode: tenant.code,
    accountId: 'alice',
    now: () => new Date('2026-05-15T00:00:00.000Z'),
  });

  assert.equal(installed.installed.skillName, 'code-reviewer');
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.cloudcli', 'skills', 'sources', 'code-reviewer', 'references', 'checklist.md'), 'utf8'),
    'Look for regressions and missing tests.\n',
  );
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'code-reviewer', 'SKILL.md'), 'utf8'),
    ['---', 'name: code-reviewer', 'description: Review code changes.', '---'].join('\n'),
  );

  const metadata = await readSkillsMetadata(workspacePath);
  assert.deepEqual(metadata.skills['code-reviewer'], {
    name: 'code-reviewer',
    description: 'Review code changes.',
    enabled: true,
    sourceType: 'skill-market-api',
    skillId: 'code-reviewer',
    remoteId: 'remote-code-reviewer',
    nspPath: 'mock://skills/code-reviewer',
    version: 7,
    installedAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
    managedBy: 'admin-skill-preset',
    adminPresetId: String(preset.id),
  });

  assert.deepEqual(multitenancy.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), [{
    name: 'code-reviewer',
    skillId: 'code-reviewer',
    id: 'remote-code-reviewer',
    skillName: 'Code Reviewer',
    nspPath: 'mock://skills/code-reviewer',
    createUserId: 'skill-author',
    version: 7,
    source: 'skill-market-api',
    importedAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
  }]);
  assert.deepEqual(
    multitenancy.skillPresetInstalls.listInstallsForWorkspace({ workspaceId: workspace.id }).map((row) => ({
      workspaceId: row.workspace_id,
      presetId: row.preset_id,
      skillName: row.skill_name,
      status: row.status,
      version: row.installed_version,
    })),
    [{
      workspaceId: workspace.id,
      presetId: preset.id,
      skillName: 'code-reviewer',
      status: 'installed',
      version: 7,
    }],
  );
});

test('applying a published preset to existing workspaces skips unmanaged Skill name conflicts', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const workspacePath = await makeWorkspace();
  const { adminId, userId, tenant, workspace } = seedTenantWorkspace({ database, multitenancy, workspacePath });
  const marketService = createFakeMarketService();
  const service = createSkillPresetService({
    multitenancy,
    users: {
      getUserByIdAnyStatus: (id) => database
        .prepare('SELECT id, username FROM users WHERE id = ?')
        .get(id),
    },
    marketService,
  });

  const preset = await service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      sourceRef: 'remote-code-reviewer',
    },
    tenantCode: tenant.code,
    accountId: 'admin',
  });
  await service.validatePreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    tenantCode: tenant.code,
    accountId: 'admin',
  });
  service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId });

  await fs.mkdir(path.join(workspacePath, '.claude', 'skills', 'code-reviewer'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, '.claude', 'skills', 'code-reviewer', 'SKILL.md'), '# Existing local skill\n', 'utf8');

  const applied = await service.applyPresetToExistingWorkspaces({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    tenantCode: tenant.code,
  });

  assert.deepEqual(applied.summary, {
    total: 1,
    installed: 0,
    updated: 0,
    skipped: 1,
    failed: 0,
  });
  assert.equal(applied.results[0].workspaceId, workspace.id);
  assert.equal(applied.results[0].action, 'skipped');
  assert.deepEqual(await readSkillsMetadata(workspacePath), { version: 1, skills: {} });
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'code-reviewer', 'SKILL.md'), 'utf8'),
    '# Existing local skill\n',
  );
  assert.deepEqual(multitenancy.skillPresetInstalls.listInstallsForWorkspace({
    workspaceId: workspace.id,
    includeRemoved: true,
  }).map((row) => ({
    status: row.status,
    lastError: row.last_error,
    installedByUserId: row.installed_by_user_id,
  })), [{
    status: 'failed',
    lastError: 'Skill "code-reviewer" already exists in the workspace',
    installedByUserId: userId,
  }]);
});

test('admin skill presets use the downloaded Skill package folder name like Skill Market import', async () => {
  const database = createTestDb();
  const multitenancy = createMultitenancyDb(database);
  const workspacePath = await makeWorkspace();
  const { adminId, userId, tenant, workspace } = seedTenantWorkspace({ database, multitenancy, workspacePath });
  const remoteSkill = {
    ...REMOTE_SKILL,
    id: 'remote-sql-helper',
    skillId: 'sql-helper-market-id',
    name: 'SQL Helper Display',
    displayName: 'SQL Helper',
    description: 'Generate SQL safely.',
    nspPath: 'mock://skills/sql-helper',
  };
  const marketService = createFakeMarketService({
    remoteSkill,
    skillName: 'sql-generator',
    files: {
      'SKILL.md': [
        '---',
        'name: SQL Generator',
        'description: Generate SQL safely.',
        '---',
      ].join('\n'),
    },
  });
  const service = createSkillPresetService({ multitenancy, marketService });

  const preset = await service.createPreset({
    tenantId: tenant.id,
    userId: adminId,
    input: {
      sourceRef: 'remote-sql-helper',
      preinstall: true,
    },
    tenantCode: tenant.code,
    accountId: 'admin',
  });

  assert.equal(preset.name, 'sql-generator');
  assert.equal(preset.displayName, 'SQL Helper');
  assert.equal(preset.description, 'Generate SQL safely.');

  await service.validatePreset({
    tenantId: tenant.id,
    presetId: preset.id,
    userId: adminId,
    tenantCode: tenant.code,
    accountId: 'admin',
  });
  service.publishPreset({ tenantId: tenant.id, presetId: preset.id, userId: adminId });

  const installed = await service.installWorkspaceSkillPreset({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    workspacePath,
    presetId: preset.id,
    userId,
    tenantCode: tenant.code,
    accountId: 'alice',
    now: () => new Date('2026-05-16T00:00:00.000Z'),
  });

  assert.equal(installed.installed.skillName, 'sql-generator');
  assert.equal(
    await fs.readFile(path.join(workspacePath, '.claude', 'skills', 'sql-generator', 'SKILL.md'), 'utf8'),
    ['---', 'name: SQL Generator', 'description: Generate SQL safely.', '---'].join('\n'),
  );
  assert.deepEqual(multitenancy.skillMarketImports.listForWorkspace({ workspaceId: workspace.id }), [{
    name: 'sql-generator',
    skillId: 'sql-helper-market-id',
    id: 'remote-sql-helper',
    skillName: 'SQL Helper',
    nspPath: 'mock://skills/sql-helper',
    createUserId: 'skill-author',
    version: 7,
    source: 'skill-market-api',
    importedAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  }]);
});
