import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createAgentTemplateService } from './agent-templates.js';

function createFixture() {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);');
  database.exec(MULTITENANCY_SCHEMA_SQL);
  database.prepare('INSERT INTO users (id, username) VALUES (1, ?)').run('admin');
  const insertTenant = database.prepare('INSERT INTO tenants (code, name) VALUES (?, ?)');
  const dataAgentTenantId = Number(insertTenant.run('dataagent-admin', 'DataAgent管理').lastInsertRowid);
  const appTenantId = Number(insertTenant.run('app-market', '应用市场').lastInsertRowid);
  const otherTenantId = Number(insertTenant.run('other', '其他租户').lastInsertRowid);

  const skillId = Number(database.prepare(`
    INSERT INTO tenant_skill_presets (
      tenant_id, name, display_name, skill_id, remote_id, status,
      last_validation_status, created_by_user_id, updated_by_user_id
    ) VALUES (?, 'market-research', '市场研究', 'market-research', 'market-research',
      'published', 'success', 1, 1)
  `).run(dataAgentTenantId).lastInsertRowid);
  const mcpId = Number(database.prepare(`
    INSERT INTO mcp_server_presets (
      tenant_id, name, display_name, config_json, status, last_test_status,
      tool_count, created_by_user_id, updated_by_user_id
    ) VALUES (?, 'web-search', 'Web Search', '{"type":"http","url":"https://example.com"}',
      'published', 'healthy', 2, 1, 1)
  `).run(dataAgentTenantId).lastInsertRowid);

  return {
    database,
    service: createAgentTemplateService(database),
    dataAgentTenantId,
    appTenantId,
    otherTenantId,
    skillId,
    mcpId,
  };
}

test('DataAgent管理 templates become globally visible after publish', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '应用市场分析专家',
      category: '市场分析',
      summary: '分析应用市场',
      claudeMarkdown: '# 应用市场分析专家',
      guideText: '告诉我需要分析的应用。',
      tenantIds: [fixture.dataAgentTenantId],
      skillPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.skillId }],
      mcpPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.mcpId }],
    },
  });
  assert.equal(draft.globalVisible, true);
  assert.equal(draft.category, '市场分析');

  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const templates = fixture.service.listAvailableTemplates({ tenantId: fixture.otherTenantId });
  assert.equal(templates.length, 1);
  assert.equal(templates[0].name, '应用市场分析专家');
  assert.equal(templates[0].category, '市场分析');
  assert.deepEqual(templates[0].skills.map((skill) => skill.name), ['市场研究']);
  assert.deepEqual(templates[0].mcps.map((mcp) => mcp.name), ['Web Search']);
});

test('ordinary tenant templates stay isolated to selected tenants', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '应用分析模板',
      category: '应用分析',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
    },
  });
  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });

  assert.equal(fixture.service.listAvailableTemplates({ tenantId: fixture.appTenantId }).length, 1);
  assert.equal(fixture.service.listAvailableTemplates({ tenantId: fixture.otherTenantId }).length, 0);
  assert.deepEqual(
    fixture.service.listAdminTemplates({ tenantId: fixture.appTenantId }).map((template) => template.id),
    [draft.id],
  );
  assert.equal(fixture.service.listAdminTemplates({ tenantId: fixture.otherTenantId }).length, 0);
  assert.equal(draft.category, '应用分析');
});

test('template category is required', () => {
  const fixture = createFixture();
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '未分类模板',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
    },
  }), /category is required/);
});

test('template category is limited to 50 characters', () => {
  const fixture = createFixture();
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '分类过长模板',
      category: 'x'.repeat(51),
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
    },
  }), /category must not exceed 50 characters/);
});

test('workspace snapshot preserves template content and preset versions', () => {
  const fixture = createFixture();
  fixture.database.prepare(`
    INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
    VALUES (?, 1, 'member', 'edit', 'active')
  `).run(fixture.appTenantId);
  const workspaceId = Number(fixture.database.prepare(`
    INSERT INTO workspaces (tenant_id, owner_user_id, slug, display_name, path)
    VALUES (?, 1, 'test-agent', 'test-agent', '/tmp/test-agent-template-snapshot')
  `).run(fixture.appTenantId).lastInsertRowid);
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '快照模板',
      category: '通用助手',
      claudeMarkdown: '# v1',
      guideText: '告诉我你想完成的任务。',
      tenantIds: [fixture.dataAgentTenantId],
      skillPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.skillId }],
      mcpPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.mcpId }],
    },
  });
  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const snapshot = fixture.service.resolveTemplateSnapshot({
    templateId: draft.id,
    tenantId: fixture.appTenantId,
  });
  fixture.service.saveWorkspaceSnapshot({ workspaceId, userId: 1, snapshot });
  assert.deepEqual(fixture.service.getWorkspaceTemplateInfo({ workspaceId }), {
    id: draft.id,
    name: '快照模板',
    guideText: '告诉我你想完成的任务。',
  });
  fixture.database.prepare(`
    INSERT INTO workspace_mcp_preset_installs (workspace_id, preset_id, installed_by_user_id)
    VALUES (?, ?, 1)
  `).run(workspaceId, fixture.mcpId);
  fixture.service.markTemplateMcpInstall({
    workspaceId,
    presetId: fixture.mcpId,
    templateId: draft.id,
  });

  fixture.service.saveTemplate({
    templateId: draft.id,
    userId: 1,
    input: { ...draft, claudeMarkdown: '# v2' },
  });
  const stored = fixture.database.prepare(`
    SELECT agent_markdown, skill_presets_json, mcp_presets_json
    FROM workspace_agent_template_snapshots WHERE workspace_id = ?
  `).get(workspaceId);
  assert.equal(stored.agent_markdown, '# v1');
  assert.equal(JSON.parse(stored.skill_presets_json)[0].id, fixture.skillId);
  assert.equal(JSON.parse(stored.mcp_presets_json)[0].id, fixture.mcpId);
  assert.equal(createMultitenancyDb(fixture.database).mcpInstalls.listInstallsForPreset({
    tenantId: fixture.dataAgentTenantId,
    presetId: fixture.mcpId,
  }).length, 0, 'template MCP snapshots must not receive later preset syncs');
});
