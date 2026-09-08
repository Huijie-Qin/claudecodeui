import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { createSkillPresetService } from '../services/skill-presets.js';

import { applyAgentTemplateSkillsToWorkspace } from './projects.js';

async function setup(t) {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  const multitenancy = createMultitenancyDb(database);
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'template-skill-install-'));
  t.after(async () => { database.close(); await fs.rm(workspacePath, { recursive: true, force: true }); });
  const userId = Number(database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('alice', 'test-hash').lastInsertRowid);
  const sourceTenant = multitenancy.tenants.createTenant({ code: 'skill-market-team', name: 'Source' });
  database.prepare('UPDATE tenants SET prod_code = ? WHERE id = ?').run('agent-api-product', sourceTenant.id);
  const targetTenant = multitenancy.tenants.createTenant({ code: 'workspace-team', name: 'Target' });
  multitenancy.memberships.upsertMembership({ tenantId: targetTenant.id, userId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = multitenancy.workspaces.createWorkspace({
    tenantId: targetTenant.id, ownerUserId: userId, slug: 'test-agent', displayName: 'Test Agent', path: workspacePath,
  });
  const calls = [];
  const manifest = '---\nname: market-research\ndescription: Research the market.\n---\nUse the attached checklist.\n';
  const remoteSkill = { id: 'remote-research', skillId: 'remote-research', name: 'market-research', version: 1 };
  const checkContext = (operation, context) => {
    calls.push({ operation, ...context });
    // Reproduce a market that scopes its inventory by tenant.code, not prod_code.
    if (context.tenantCode !== sourceTenant.code) throw new Error('该技能不存在');
  };
  const marketService = {
    fetchRemoteSkillDetail: async (ref, context) => {
      checkContext('lookup', context);
      assert.equal(ref, remoteSkill.id);
      return remoteSkill;
    },
    downloadRemoteSkillFiles: async (skill, context) => {
      checkContext('download', context);
      return { skillName: 'market-research', files: { 'SKILL.md': manifest, 'references/checklist.md': 'Check sources.\n' } };
    },
  };
  const skillPresets = createSkillPresetService({ multitenancy, marketService });
  const created = await skillPresets.createPreset({ tenantId: sourceTenant.id, userId, input: { sourceRef: remoteSkill.id }, tenantCode: sourceTenant.code, accountId: 'admin' });
  const validated = await skillPresets.validatePreset({ tenantId: sourceTenant.id, presetId: created.id, userId, tenantCode: sourceTenant.code, accountId: 'admin' });
  assert.equal(validated.validation.status, 'healthy');
  const published = skillPresets.publishPreset({ tenantId: sourceTenant.id, presetId: created.id, userId });
  const options = {
    skills: [published], workspace, user: { id: userId, username: 'alice' }, multitenancy, skillPresets,
  };
  calls.length = 0;
  return { database, options, sourceTenant, manifest, calls, marketService, remoteSkill };
}

test('template skills use the same source tenant as validation and are materialized in the target workspace', async (t) => {
  const { options, sourceTenant, manifest, calls, marketService, remoteSkill } = await setup(t);
  await assert.rejects(marketService.fetchRemoteSkillDetail(remoteSkill.id, { tenantCode: 'agent-api-product', accountId: 'alice' }), /该技能不存在/);
  calls.length = 0;

  const result = await applyAgentTemplateSkillsToWorkspace(options);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.appliedSkills.length, 1);
  assert.deepEqual(calls, [
    { operation: 'lookup', tenantCode: sourceTenant.code, accountId: 'alice', exactId: true },
    { operation: 'download', tenantCode: sourceTenant.code, accountId: 'alice' },
  ]);
  const runtimePath = path.join(options.workspace.path, '.claude', 'skills', 'market-research');
  assert.equal(await fs.readFile(path.join(runtimePath, 'SKILL.md'), 'utf8'), manifest);
  assert.equal(await fs.readFile(path.join(runtimePath, 'references', 'checklist.md'), 'utf8'), 'Check sources.\n');
  const installs = options.multitenancy.skillPresetInstalls.listInstallsForWorkspace({ workspaceId: options.workspace.id });
  assert.equal(installs[0].status, 'installed');
  assert.equal(installs[0].tenant_id, sourceTenant.id);
  assert.equal(options.multitenancy.skillMarketImports.listForWorkspace({ workspaceId: options.workspace.id })[0].id, remoteSkill.id);

  calls.length = 0;
  const reapplied = await applyAgentTemplateSkillsToWorkspace(options);
  assert.equal(reapplied.appliedSkills.length, 1);
  assert.deepEqual(calls, []);
});

test('failed template downloads are recorded and omitted from applied skills, then can be retried', async (t) => {
  const { options, marketService } = await setup(t);
  const download = marketService.downloadRemoteSkillFiles;
  marketService.downloadRemoteSkillFiles = async () => { throw new Error('Skill download unavailable'); };
  const result = await applyAgentTemplateSkillsToWorkspace(options);
  assert.deepEqual(result.appliedSkills, []);
  assert.equal(result.warnings[0].unavailableReason, 'Skill download unavailable');
  const failed = options.multitenancy.skillPresetInstalls.listInstallsForWorkspace({ workspaceId: options.workspace.id, includeRemoved: true });
  assert.equal(failed[0].status, 'failed');
  assert.equal(failed[0].last_error, 'Skill download unavailable');
  await assert.rejects(fs.access(path.join(options.workspace.path, '.claude', 'skills', 'market-research', 'SKILL.md')), { code: 'ENOENT' });

  marketService.downloadRemoteSkillFiles = download;
  const retried = await applyAgentTemplateSkillsToWorkspace(options);
  assert.deepEqual(retried.warnings, []);
  assert.equal(retried.appliedSkills.length, 1);
});
