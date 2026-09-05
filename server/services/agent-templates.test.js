import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createAgentTemplateService } from './agent-templates.js';

function createFixture() {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);');
  database.exec(MULTITENANCY_SCHEMA_SQL);
  database.exec(HOOK_CONFIG_SCHEMA_SQL);
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
      tool_count, tools_json, created_by_user_id, updated_by_user_id
    ) VALUES (?, 'web-search', 'Web Search', '{"type":"http","url":"https://example.com"}',
      'published', 'healthy', 2, ?, 1, 1)
  `).run(dataAgentTenantId, JSON.stringify([
    {
      name: 'search_web',
      description: 'Search the web',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', default: 5 },
        },
        required: ['query'],
      },
    },
    {
      name: 'read_page',
      description: 'Read a page',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    },
  ])).lastInsertRowid);
  const insertHook = database.prepare(`
    INSERT INTO hooks (
      id, name, description, status, event_name, matcher_json,
      extension_logic_json, post_actions_json, claude_response_json,
      version, binding_controller, created_by, updated_by, published_at
    ) VALUES (?, ?, ?, ?, ?, '{}', 'null', ?, '{"bindings":{}}', ?, ?, 1, 1, CURRENT_TIMESTAMP)
  `);
  insertHook.run(
    'hook-template-ready',
    '项目完成记录',
    '记录任务完成结果',
    'published',
    'TaskCompleted',
    JSON.stringify([{ id: 'record', type: 'write_record', position: 0, config: { recordType: 'task' } }]),
    2,
    'admin',
  );
  database.prepare(`
    INSERT INTO hook_published_versions (
      hook_id, version, config_json, resource_refs_json, published_by, published_at
    ) VALUES (?, 2, ?, '{"skills":[],"mcpServers":[],"mcpTools":[]}', 1, CURRENT_TIMESTAMP)
  `).run('hook-template-ready', JSON.stringify({
    name: '项目完成记录',
    description: '记录任务完成结果',
    eventName: 'TaskCompleted',
    matcher: {},
    extensionLogic: null,
    postActions: [{ id: 'record', type: 'write_record', position: 0, config: { recordType: 'task' } }],
    claudeResponse: { bindings: {} },
    bindingController: 'admin',
  }));
  insertHook.run(
    'hook-template-sql-check',
    'SQL Check',
    '',
    'published',
    'PreToolUse',
    '[]',
    1,
    'sql_check',
  );
  insertHook.run(
    'hook-template-draft',
    '未发布 Hook',
    '',
    'draft',
    'Stop',
    '[]',
    0,
    'admin',
  );

  return {
    database,
    service: createAgentTemplateService(database),
    dataAgentTenantId,
    appTenantId,
    otherTenantId,
    skillId,
    mcpId,
    hookId: 'hook-template-ready',
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

test('published templates remain visible and skip MCPs that go offline later', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '可降级模板',
      category: '应用分析',
      tenantIds: [fixture.dataAgentTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.mcpId }],
    },
  });
  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  fixture.database.prepare(`
    UPDATE mcp_server_presets SET status = 'disabled' WHERE id = ?
  `).run(fixture.mcpId);

  const [listed] = fixture.service.listAvailableTemplates({ tenantId: fixture.appTenantId });
  assert.equal(listed.id, draft.id);
  assert.deepEqual(listed.mcps, [], 'end users only see capabilities that can currently be applied');

  const [adminTemplate] = fixture.service.listAdminTemplates();
  assert.deepEqual(adminTemplate.unavailableCapabilities, [{
    type: 'mcp',
    id: fixture.mcpId,
    name: 'Web Search',
    available: false,
    unavailableReason: '已下线',
  }]);

  const snapshot = fixture.service.resolveTemplateSnapshot({
    templateId: draft.id,
    tenantId: fixture.appTenantId,
  });
  assert.deepEqual(snapshot.mcps, []);
  assert.deepEqual(snapshot.unavailableCapabilities, [{
    type: 'mcp',
    id: fixture.mcpId,
    name: 'Web Search',
    available: false,
    unavailableReason: '已下线',
  }]);
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

test('empty Agent template categories can be managed and deleted', () => {
  const fixture = createFixture();
  const category = fixture.service.createCategory({ name: '研发效能', userId: 1 });

  assert.deepEqual(fixture.service.listCategories().map((item) => ({
    name: item.name,
    templateCount: item.templateCount,
  })), [{ name: '研发效能', templateCount: 0 }]);
  assert.deepEqual(fixture.service.deleteCategory({ categoryId: category.id }), {
    id: category.id,
    name: '研发效能',
  });
  assert.deepEqual(fixture.service.listCategories(), []);
});

test('duplicate Agent template category names are rejected clearly', () => {
  const fixture = createFixture();
  fixture.service.createCategory({ name: '研发效能', userId: 1 });

  assert.throws(
    () => fixture.service.createCategory({ name: '  研发效能  ', userId: 1 }),
    /Agent 模板分类“研发效能”已存在，请使用其他名称/,
  );
});

test('Agent template names are unique without blocking the current template update', () => {
  const fixture = createFixture();
  const first = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '应用分析助手',
      category: '应用分析',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
    },
  });

  assert.throws(
    () => fixture.service.saveTemplate({
      userId: 1,
      input: {
        name: '  应用分析助手  ',
        category: '其他分类',
        tenantIds: [fixture.otherTenantId],
        skillPresetRefs: [],
        mcpPresetRefs: [],
      },
    }),
    /Agent 模板“应用分析助手”已存在，请使用其他名称/,
  );
  assert.equal(fixture.service.listCategories().some((category) => category.name === '其他分类'), false);
  assert.equal(fixture.service.saveTemplate({
    templateId: first.id,
    userId: 1,
    input: { ...first, summary: '更新描述' },
  }).summary, '更新描述');
});

test('categories used by templates cannot be deleted', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '研发助手',
      category: '研发效能',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
    },
  });
  const [category] = fixture.service.listCategories();

  assert.equal(category.templateCount, 1);
  assert.throws(
    () => fixture.service.deleteCategory({ categoryId: category.id }),
    /still used by templates/,
  );
  assert.throws(
    () => fixture.service.deleteTemplate({ templateId: draft.id }),
    /must be disabled before deletion/,
  );
  fixture.service.disableTemplate({ templateId: draft.id, userId: 1 });
  assert.deepEqual(fixture.service.deleteTemplate({ templateId: draft.id }), {
    id: draft.id,
    name: '研发助手',
  });
  assert.equal(fixture.service.listCategories()[0].templateCount, 0);
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
  assert.throws(
    () => fixture.service.deleteTemplate({ templateId: draft.id }),
    /must be disabled before deletion/,
  );
  fixture.service.disableTemplate({ templateId: draft.id, userId: 1 });
  assert.deepEqual(fixture.service.deleteTemplate({ templateId: draft.id }), {
    id: draft.id,
    name: '快照模板',
  });
  assert.deepEqual(fixture.service.getWorkspaceTemplateInfo({ workspaceId }), {
    id: draft.id,
    name: '快照模板',
    guideText: '告诉我你想完成的任务。',
  }, 'deleting the management template must preserve the project snapshot');
  assert.equal(Number(fixture.database.prepare(`
    SELECT COUNT(*) AS count FROM workspace_agent_template_mcp_installs
    WHERE workspace_id = ? AND template_id = ?
  `).get(workspaceId, draft.id).count), 1, 'template MCP install markers must remain historical records');
});

test('MCP tool settings are validated and preserved in template snapshots', () => {
  const fixture = createFixture();
  const toolSettings = {
    allowedToolNames: ['search_web'],
    tools: {
      search_web: {
        params: {
          limit: { mode: 'force', value: 10 },
          query: { mode: 'default', value: '应用市场' },
        },
      },
    },
  };
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '带 MCP 配置的模板',
      category: '市场分析',
      tenantIds: [fixture.dataAgentTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [{
        tenantId: fixture.dataAgentTenantId,
        presetId: fixture.mcpId,
        toolSettings,
      }],
    },
  });
  assert.deepEqual(draft.mcpPresetRefs[0].toolSettings, toolSettings);

  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const snapshot = fixture.service.resolveTemplateSnapshot({
    templateId: draft.id,
    tenantId: fixture.appTenantId,
  });
  assert.equal(snapshot.mcps[0].serverName, 'web-search');
  assert.deepEqual(snapshot.mcps[0].toolSettings, toolSettings);
});

test('MCP tool settings reject unknown tools and parameters', () => {
  const fixture = createFixture();
  const baseInput = {
    name: '非法 MCP 配置模板',
    category: '市场分析',
    tenantIds: [fixture.dataAgentTenantId],
    skillPresetRefs: [],
  };
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      ...baseInput,
      mcpPresetRefs: [{
        tenantId: fixture.dataAgentTenantId,
        presetId: fixture.mcpId,
        toolSettings: { allowedToolNames: ['missing_tool'], tools: {} },
      }],
    },
  }), /Unknown MCP tools/);
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      ...baseInput,
      mcpPresetRefs: [{
        tenantId: fixture.dataAgentTenantId,
        presetId: fixture.mcpId,
        toolSettings: {
          allowedToolNames: ['search_web'],
          tools: { search_web: { params: { missing: { mode: 'force', value: true } } } },
        },
      }],
    },
  }), /Unknown MCP parameter/);
});

test('Agent templates persist only current published admin Hooks', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '带 Hook 的模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{
        hookId: fixture.hookId,
        version: 2,
        defaultEnabled: true,
        showInChat: false,
        allowUserDisable: true,
        order: 20,
      }],
    },
  });

  assert.deepEqual(draft.hookRefs, [{
    hookId: fixture.hookId,
    version: 2,
    defaultEnabled: true,
    showInChat: false,
    allowUserDisable: true,
    order: 20,
  }]);
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: 'SQL Check 模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: 'hook-template-sql-check', version: 1 }],
    },
  }), /SQL Check/);
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '未发布 Hook 模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: 'hook-template-draft', version: 1 }],
    },
  }), /未发布/);
  assert.throws(() => fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '配置矛盾 Hook 模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{
        hookId: fixture.hookId,
        version: 2,
        defaultEnabled: false,
        allowUserDisable: false,
      }],
    },
  }), /mandatory Hook/);
});

test('Agent templates stay pinned to an immutable published Hook version', () => {
  const fixture = createFixture();
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '锁定 Hook 版本模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: fixture.hookId, version: 2 }],
    },
  });
  fixture.database.prepare(`
    UPDATE hooks SET version = 3, name = '新版 Hook 草稿', status = 'draft' WHERE id = ?
  `).run(fixture.hookId);
  fixture.database.prepare(`
    INSERT INTO hook_published_versions (
      hook_id, version, config_json, resource_refs_json, published_by, published_at
    ) VALUES (?, 3, ?, '{}', 1, CURRENT_TIMESTAMP)
  `).run(fixture.hookId, JSON.stringify({
    name: '新版 Hook',
    description: '',
    eventName: 'Stop',
    matcher: {},
    extensionLogic: { language: 'javascript', code: 'export async function run() { return {}; }', outputs: [] },
    postActions: [],
    claudeResponse: { bindings: {} },
    bindingController: 'admin',
  }));

  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const snapshot = fixture.service.resolveTemplateSnapshot({
    templateId: draft.id,
    tenantId: fixture.appTenantId,
  });
  assert.equal(snapshot.hooks[0].version, 2);
  assert.equal(snapshot.hooks[0].name, '项目完成记录');
});

test('Hook catalog excludes SQL Check and respects tenant bindings', () => {
  const fixture = createFixture();
  assert.deepEqual(
    fixture.service.listHookCatalog({ tenantId: fixture.otherTenantId }).map((hook) => hook.id),
    [fixture.hookId],
  );

  fixture.database.prepare(`
    INSERT INTO hook_tenant_bindings (hook_id, tenant_id, bound_by)
    VALUES (?, ?, 1)
  `).run(fixture.hookId, fixture.appTenantId);
  assert.deepEqual(
    fixture.service.listHookCatalog({ tenantId: fixture.appTenantId }).map((hook) => hook.id),
    [fixture.hookId],
  );
  assert.deepEqual(fixture.service.listHookCatalog({ tenantId: fixture.otherTenantId }), []);
});

test('Hook dependency failures block template publish and appear in the admin catalog', () => {
  const fixture = createFixture();
  fixture.database.prepare(`
    UPDATE hooks
    SET post_actions_json = ?
    WHERE id = ?
  `).run(JSON.stringify([{
    id: 'notify',
    type: 'invoke_skill',
    position: 0,
    config: { skillId: 'builtin:missing', skillName: 'missing' },
  }]), fixture.hookId);
  const publishedConfig = JSON.parse(fixture.database.prepare(`
    SELECT config_json FROM hook_published_versions WHERE hook_id = ? AND version = 2
  `).get(fixture.hookId).config_json);
  publishedConfig.postActions = [{
    id: 'notify',
    type: 'invoke_skill',
    position: 0,
    config: { skillId: 'builtin:missing', skillName: 'missing' },
  }];
  fixture.database.prepare(`
    UPDATE hook_published_versions SET config_json = ? WHERE hook_id = ? AND version = 2
  `).run(JSON.stringify(publishedConfig), fixture.hookId);
  const resourceCatalog = { skills: [], mcpTools: [] };
  const [catalogHook] = fixture.service.listHookCatalog({
    tenantId: fixture.appTenantId,
    resourceCatalog,
  });
  assert.equal(catalogHook.available, false);
  assert.equal(catalogHook.dependencySummary.unavailableCount, 1);

  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '依赖失效 Hook 模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: fixture.hookId, version: 2 }],
    },
  });
  assert.throws(
    () => fixture.service.publishTemplate({
      templateId: draft.id,
      userId: 1,
      hookResourceCatalog: resourceCatalog,
    }),
    /依赖能力不可用/,
  );
});

test('Agent template Hook checks compare pinned Skill and MCP content hashes', () => {
  const fixture = createFixture();
  const published = fixture.database.prepare(`
    SELECT config_json FROM hook_published_versions WHERE hook_id = ? AND version = 2
  `).get(fixture.hookId);
  const config = JSON.parse(published.config_json);
  config.postActions = [
    {
      id: 'notify',
      type: 'invoke_skill',
      position: 0,
      config: { skillId: 'builtin:notify', skillName: 'notify' },
    },
    {
      id: 'send',
      type: 'call_mcp_tool',
      position: 1,
      config: { toolName: 'mcp__notify__send', mcpServerId: 'server-1' },
    },
  ];
  fixture.database.prepare(`
    UPDATE hook_published_versions
    SET config_json = ?, resource_refs_json = ?
    WHERE hook_id = ? AND version = 2
  `).run(JSON.stringify(config), JSON.stringify({
    skills: [{
      skillId: 'builtin:notify',
      skillName: 'notify',
      version: 3,
      contentHash: 'skill-hash-v1',
    }],
    mcpServers: [{ id: 'server-1', contentHash: 'server-hash-v1' }],
    mcpTools: [{ mcpServerId: 'server-1', toolName: 'mcp__notify__send' }],
  }), fixture.hookId);
  const matchingCatalog = {
    skills: [{
      skillId: 'builtin:notify',
      name: 'notify',
      version: 3,
      contentHash: 'skill-hash-v1',
    }],
    mcpTools: [{
      name: 'mcp__notify__send',
      mcpServerId: 'server-1',
      mcpServerContentHash: 'server-hash-v1',
    }],
  };
  assert.equal(fixture.service.listHookCatalog({
    tenantId: fixture.appTenantId,
    resourceCatalog: matchingCatalog,
  })[0].available, true);

  const changedSkillCatalog = {
    ...matchingCatalog,
    skills: [{
      ...matchingCatalog.skills[0],
      contentHash: 'skill-hash-v2',
    }],
  };
  assert.equal(fixture.service.listHookCatalog({
    tenantId: fixture.appTenantId,
    resourceCatalog: changedSkillCatalog,
  })[0].available, false);

  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: '固定 Hook 依赖模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: fixture.hookId, version: 2 }],
    },
  });
  assert.throws(
    () => fixture.service.publishTemplate({
      templateId: draft.id,
      userId: 1,
      hookResourceCatalog: changedSkillCatalog,
    }),
    /依赖能力不可用/,
  );

  const changedMcpCatalog = {
    ...matchingCatalog,
    mcpTools: [{
      ...matchingCatalog.mcpTools[0],
      mcpServerContentHash: 'server-hash-v2',
    }],
  };
  assert.throws(
    () => fixture.service.publishTemplate({
      templateId: draft.id,
      userId: 1,
      hookResourceCatalog: changedMcpCatalog,
    }),
    /依赖能力不可用/,
  );
});

test('workspace Agent template snapshot stores non-secret Hook audit metadata', () => {
  const fixture = createFixture();
  fixture.database.prepare(`
    INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
    VALUES (?, 1, 'member', 'edit', 'active')
  `).run(fixture.appTenantId);
  const workspaceId = Number(fixture.database.prepare(`
    INSERT INTO workspaces (tenant_id, owner_user_id, slug, display_name, path)
    VALUES (?, 1, 'hook-agent', 'hook-agent', '/tmp/hook-agent-template-snapshot')
  `).run(fixture.appTenantId).lastInsertRowid);
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: {
      name: 'Hook 快照模板',
      category: '通用助手',
      tenantIds: [fixture.appTenantId],
      skillPresetRefs: [],
      mcpPresetRefs: [],
      hookRefs: [{ hookId: fixture.hookId, version: 2 }],
    },
  });
  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const snapshot = fixture.service.resolveTemplateSnapshot({
    templateId: draft.id,
    tenantId: fixture.appTenantId,
  });
  fixture.service.saveWorkspaceSnapshot({ workspaceId, userId: 1, snapshot });

  const stored = JSON.parse(fixture.database.prepare(`
    SELECT hooks_json FROM workspace_agent_template_snapshots WHERE workspace_id = ?
  `).get(workspaceId).hooks_json);
  assert.equal(stored[0].id, fixture.hookId);
  assert.equal(stored[0].version, 2);
  assert.equal(Object.hasOwn(stored[0], 'extensionLogic'), false);
  assert.equal(Object.hasOwn(stored[0], 'postActions'), false);
});
