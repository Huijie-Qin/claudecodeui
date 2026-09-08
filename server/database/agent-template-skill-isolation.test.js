import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAgentTemplateSkillIsolation } from './agent-template-skill-isolation.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';

test('split shared template records without changing tenant presets, workspace snapshots or installs', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (1, \'admin\');');
  database.exec(MULTITENANCY_SCHEMA_SQL);
  database.exec("INSERT INTO tenants (id, code, name) VALUES (1, 'team', 'Team');");
  const createPreset = database.prepare(`INSERT INTO tenant_skill_presets
    (tenant_id, name, display_name, skill_id, remote_id, preinstall_scope, status, last_validation_status, created_by_user_id, updated_by_user_id)
    VALUES (1, ?, '审查', 'remote-review', 'remote-review', ?, 'published', 'healthy', 1, 1)`);
  const tenantId = Number(createPreset.run('review', 'all_workspaces').lastInsertRowid);
  const standaloneId = Number(createPreset.run('review-template', 'none').lastInsertRowid);
  const refs = [{ tenantId: 1, presetId: tenantId }, { tenantId: 1, presetId: standaloneId }];
  database.prepare(`INSERT INTO agent_templates
    (id, name, skill_preset_refs_json, created_by_user_id, updated_by_user_id) VALUES (1, 'First', ?, 1, 1), (2, 'Second', ?, 1, 1)`)
    .run(JSON.stringify(refs), JSON.stringify([refs[0]]));
  database.exec("INSERT INTO workspaces (id, tenant_id, owner_user_id, slug, display_name, path) VALUES (1,1,1,'existing','Existing','/tmp/existing-project');");
  database.prepare(`INSERT INTO workspace_agent_template_snapshots
    (workspace_id, template_id, template_name, skill_presets_json, created_by_user_id) VALUES (1,1,'First',?,1)`)
    .run(JSON.stringify([{ id: tenantId, name: 'review' }]));
  database.prepare(`INSERT INTO workspace_skill_preset_installs
    (workspace_id,preset_id,skill_name,installed_by_user_id,status) VALUES (1,?,'review',1,'installed')`).run(tenantId);
  const original = database.prepare('SELECT * FROM tenant_skill_presets WHERE id = ?').get(tenantId);
  const snapshot = database.prepare('SELECT * FROM workspace_agent_template_snapshots').get();
  const install = database.prepare('SELECT * FROM workspace_skill_preset_installs').get();

  assert.deepEqual(migrateAgentTemplateSkillIsolation(database), { presetsCreated: 1, templatesUpdated: 2 });
  const migrated = database.prepare('SELECT skill_preset_refs_json FROM agent_templates ORDER BY id').all()
    .map((row) => JSON.parse(row.skill_preset_refs_json));
  assert.notEqual(migrated[0][0].presetId, tenantId);
  assert.equal(migrated[0][0].presetId, migrated[1][0].presetId);
  assert.equal(migrated[0][1].presetId, standaloneId);
  const copy = database.prepare('SELECT * FROM tenant_skill_presets WHERE id = ?').get(migrated[0][0].presetId);
  assert.deepEqual({ ...copy, id: original.id, name: original.name, preinstall_scope: original.preinstall_scope }, original);
  assert.equal(copy.preinstall_scope, 'none');
  assert.deepEqual(database.prepare('SELECT * FROM tenant_skill_presets WHERE id = ?').get(tenantId), original);
  assert.deepEqual(database.prepare('SELECT * FROM workspace_agent_template_snapshots').get(), snapshot);
  assert.deepEqual(database.prepare('SELECT * FROM workspace_skill_preset_installs').get(), install);
  assert.deepEqual(migrateAgentTemplateSkillIsolation(database), { presetsCreated: 0, templatesUpdated: 0 });

  database.prepare('DELETE FROM tenant_skill_presets WHERE id = ?').run(tenantId);
  assert.ok(database.prepare('SELECT id FROM tenant_skill_presets WHERE id = ?').get(copy.id));
});
