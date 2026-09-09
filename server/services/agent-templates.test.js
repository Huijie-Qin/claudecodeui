import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import Database from 'better-sqlite3';

import { migrateAgentTemplateSnapshotsToHistoricalReferences } from '../database/db.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { HOOK_CONFIG_SCHEMA_SQL } from '../database/hook-config-schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';

import { createAgentTemplateService } from './agent-templates.js';
import { createAgentTemplateFolderAssetStore } from './agent-template-folder-assets.js';

const folderAssetTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-template-service-assets-'));
after(() => fs.rmSync(folderAssetTestRoot, { recursive: true, force: true }));

function createFixture() {
  const database = new Database(':memory:');
  const folderAssetPath = fs.mkdtempSync(path.join(folderAssetTestRoot, 'fixture-'));
  const folderAssets = createAgentTemplateFolderAssetStore({ rootPath: folderAssetPath });
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
    folderAssets,
    folderAssetPath,
    service: createAgentTemplateService(database, { folderAssets }),
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

test('template catalog and saves cannot reuse tenant-preinstall records directly', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  assert.equal(fixture.service.listPresetCatalog({ tenantId: fixture.dataAgentTenantId }).skills.length, 1);
  fixture.database.prepare("UPDATE tenant_skill_presets SET preinstall_scope = 'all_workspaces' WHERE id = ?").run(fixture.skillId);
  assert.deepEqual(fixture.service.listPresetCatalog({ tenantId: fixture.dataAgentTenantId }).skills, []);
  assert.throws(() => fixture.service.saveTemplate({ userId: 1, input: {
    name: '独立技能模板', category: '测试', tenantIds: [fixture.dataAgentTenantId],
    skillPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.skillId }],
  } }), /不能直接引用租户 Skill 预置/);
});

test('template folders retain binary contents and empty directories through save and partial updates', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const folders = [{
    name: 'resources',
    directories: ['empty', 'nested'],
    files: [{ path: 'nested/data.bin', contentBase64: Buffer.from([0, 255, 128, 10]).toString('base64') }],
  }, { name: 'commands', directories: [], files: [] }];
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: { name: '文件夹模板', category: '通用助手', tenantIds: [fixture.appTenantId], claudeFolders: folders },
  });
  const metadata = draft.claudeFolders;
  assert.deepEqual(metadata.map(({ name, directories }) => ({ name, directories })),
    folders.map(({ name, directories }) => ({ name, directories })));
  assert.equal(metadata[0].files[0].size, 4);
  assert.match(metadata[0].files[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(metadata.every((folder) => !Object.hasOwn(folder, 'version')));
  assert.deepEqual(fixture.folderAssets.readFile(metadata[0].files[0]), Buffer.from([0, 255, 128, 10]));
  assert.deepEqual(fixture.service.getTemplate(draft.id).claudeFolders, metadata);
  assert.deepEqual(fixture.service.listAdminTemplates()[0].claudeFolders, [], 'admin lists omit folder manifests');
  const storedJson = fixture.database.prepare(
    'SELECT claude_folders_json FROM agent_templates WHERE id = ?',
  ).get(draft.id).claude_folders_json;
  assert.equal(storedJson.includes('contentBase64'), false);
  assert.deepEqual(JSON.parse(storedJson), metadata);
  assert.equal(metadata[0].files[0].storagePath,
    `templates/${draft.id}/folders/resources/nested/data.bin`);
  const templateRoot = path.join(fixture.folderAssetPath, 'templates', String(draft.id));
  const manifest = JSON.parse(fs.readFileSync(path.join(templateRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.templateId, draft.id);
  assert.equal(manifest.templateName, draft.name);
  const withoutStorage = (value) => value.map(({ name, directories, files }) => ({
    name, directories, files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
  }));

  const updated = fixture.service.saveTemplate({
    templateId: draft.id, userId: 1, input: { summary: '只编辑简介' },
  });
  assert.deepEqual(withoutStorage(updated.claudeFolders), withoutStorage(metadata), 'older clients must not discard uploaded folders');
  const reused = fixture.service.saveTemplate({
    templateId: draft.id, userId: 1, input: { claudeFolders: updated.claudeFolders },
  });
  assert.deepEqual(withoutStorage(reused.claudeFolders), withoutStorage(metadata));
  assert.equal(fs.existsSync(path.join(templateRoot, 'versions')), false);
  assert.deepEqual(fs.readdirSync(path.dirname(templateRoot)), [String(draft.id)], 'saves leave only the current directory');
  for (const versionedFolders of [metadata, updated.claudeFolders, reused.claudeFolders]) {
    assert.deepEqual(fixture.folderAssets.readFile(versionedFolders[0].files[0]), Buffer.from([0, 255, 128, 10]));
  }
  fixture.service.publishTemplate({ templateId: draft.id, userId: 1 });
  const [listed] = fixture.service.listAvailableTemplates({ tenantId: fixture.appTenantId });
  assert.equal(Object.hasOwn(listed, 'claudeFolders'), false, 'the picker must not transfer file contents');
  assert.deepEqual(fixture.service.resolveTemplateSnapshot({
    templateId: draft.id, tenantId: fixture.appTenantId,
  }).template.claudeFolders, reused.claudeFolders);

  const cleared = fixture.service.saveTemplate({
    templateId: draft.id, userId: 1, input: { claudeFolders: [] },
  });
  assert.deepEqual(cleared.claudeFolders, []);
  assert.deepEqual(fixture.service.getTemplate(draft.id).claudeFolders, []);
  assert.equal(fs.existsSync(path.join(templateRoot, 'folders', 'resources')), false);
  assert.equal(fs.existsSync(path.join(templateRoot, 'folders', 'commands')), false);
});

test('invalid folder updates fail without replacing stored template content', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const folders = [{ name: 'resources', directories: [], files: [] }];
  const draft = fixture.service.saveTemplate({
    userId: 1,
    input: { name: '保留文件夹', category: '通用助手', tenantIds: [fixture.appTenantId], claudeFolders: folders },
  });
  for (const claudeFolders of [null, [{ name: '../escape', files: [] }]]) {
    assert.throws(() => fixture.service.saveTemplate({
      templateId: draft.id, userId: 1, input: { name: '非法更新', claudeFolders },
    }), (error) => error.statusCode === 400);
    assert.equal(fixture.service.getTemplate(draft.id).name, draft.name);
    assert.deepEqual(fixture.service.getTemplate(draft.id).claudeFolders, draft.claudeFolders);
  }
});

test('new template requests cannot reference another template stored files', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const baseInput = { category: '通用助手', tenantIds: [fixture.appTenantId] };
  const source = fixture.service.saveTemplate({ userId: 1, input: {
    ...baseInput, name: '原资源模板',
    claudeFolders: [{ name: 'commands', files: [{ path: 'review.md', contentBase64: Buffer.from('private command').toString('base64') }] }],
  } });
  const recipient = fixture.service.saveTemplate({ userId: 1, input: { ...baseInput, name: '另一个模板' } });
  assert.throws(() => fixture.service.saveTemplate({ userId: 1, input: {
    ...baseInput, name: '伪造资源模板', claudeFolders: source.claudeFolders,
  } }), (error) => error.statusCode === 400);
  assert.throws(() => fixture.service.saveTemplate({ templateId: recipient.id, userId: 1, input: {
    claudeFolders: source.claudeFolders,
  } }), (error) => error.statusCode === 400);
  assert.throws(() => fixture.service.saveTemplate({ templateId: source.id, userId: 1, input: {
    claudeFolders: source.claudeFolders.map((folder) => ({ ...folder, name: 'renamed' })),
  } }), (error) => error.statusCode === 400);
  assert.deepEqual(fixture.service.getTemplate(recipient.id).claudeFolders, []);
  assert.equal(fixture.service.listAdminTemplates().length, 2);
});

test('template validation runs before uploaded assets are persisted', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  let persistCalls = 0;
  const service = createAgentTemplateService(fixture.database, { folderAssets: {
    beginUpdate() { persistCalls += 1; throw new Error('should not write assets'); },
  } });
  const input = { name: '无效模板', category: '', tenantIds: [fixture.appTenantId],
    claudeFolders: [{ name: 'commands', files: [{ path: 'review.md', contentBase64: 'YQ==' }] }],
  };
  assert.throws(() => service.saveTemplate({ userId: 1, input }), /category is required/);
  fixture.service.saveTemplate({ userId: 1, input: { ...input, category: '通用助手', claudeFolders: [] } });
  assert.throws(() => service.saveTemplate({ userId: 1, input: { ...input, category: '通用助手' } }),
    (error) => error.statusCode === 409);
  assert.equal(persistCalls, 0);
});

test('new templates allocate their id without storing inline content and roll back failed file writes', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  let allocatedId;
  const service = createAgentTemplateService(fixture.database, { folderAssets: {
    beginUpdate(folders, { templateId, templateName }) {
      allocatedId = templateId;
      assert.equal(templateName, '落盘失败模板');
      assert.equal(folders[0].files[0].contentBase64, 'YQ==');
      const row = fixture.database.prepare('SELECT * FROM agent_templates WHERE id = ?').get(templateId);
      assert.equal(row.claude_folders_json, '[]');
      throw new Error('simulated disk failure');
    },
  } });
  assert.throws(() => service.saveTemplate({ userId: 1, input: {
    name: '落盘失败模板', category: '通用助手', tenantIds: [fixture.appTenantId],
    claudeFolders: [{ name: 'commands', files: [{ path: 'readme.txt', contentBase64: 'YQ==' }] }],
  } }), /simulated disk failure/);
  assert.ok(Number.isSafeInteger(allocatedId));
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_templates').get().count, 0);
});

test('SQL save failures restore the original current files and roll back new templates', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const draft = fixture.service.saveTemplate({ userId: 1, input: {
    name: '当前模板', category: '通用助手', tenantIds: [fixture.appTenantId],
    claudeFolders: [{ name: 'commands', files: [{ path: 'readme.txt', contentBase64: 'b2xk' }] }],
  } });
  const stored = fixture.database.prepare('SELECT * FROM agent_templates WHERE id = ?').get(draft.id);
  fixture.database.exec(`CREATE TRIGGER reject_folder_save BEFORE UPDATE OF claude_folders_json ON agent_templates
    WHEN NEW.summary = 'reject' BEGIN SELECT RAISE(ABORT, 'simulated SQL failure'); END;`);
  assert.throws(() => fixture.service.saveTemplate({ templateId: draft.id, userId: 1, input: {
    summary: 'reject', category: '应当回滚分类',
    claudeFolders: [{ name: 'commands', files: [{ path: 'new.txt', contentBase64: 'bmV3' }] }],
  } }), /simulated SQL failure/);
  assert.deepEqual(fixture.database.prepare('SELECT * FROM agent_templates WHERE id = ?').get(draft.id), stored);
  assert.equal(fixture.folderAssets.readFile(draft.claudeFolders[0].files[0]).toString(), 'old');
  assert.equal(fs.existsSync(path.join(fixture.folderAssetPath, 'templates', String(draft.id), 'folders', 'commands', 'new.txt')), false);
  assert.equal(fixture.service.listCategories().some((category) => category.name === '应当回滚分类'), false);
  assert.throws(() => fixture.service.saveTemplate({ userId: 1, input: {
    name: '回滚新模板', summary: 'reject', category: '通用助手', tenantIds: [fixture.appTenantId],
    claudeFolders: [{ name: 'commands', files: [{ path: 'readme.txt', contentBase64: 'bmV3' }] }],
  } }), /simulated SQL failure/);
  assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_templates').get().count, 1);
  assert.deepEqual(fs.readdirSync(path.join(fixture.folderAssetPath, 'templates')), [String(draft.id)]);
});

test('failed edits of legacy versioned templates restore their original readable files', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const draft = fixture.service.saveTemplate({ userId: 1, input: {
    name: '旧版本模板', category: '通用助手', tenantIds: [fixture.appTenantId],
    claudeFolders: [{ name: 'commands', files: [{ path: 'readme.txt', contentBase64: 'b2xk' }] }],
  } });
  const legacyPath = `templates/${draft.id}/versions/legacy-v1/folders/commands/readme.txt`;
  fs.mkdirSync(path.dirname(path.join(fixture.folderAssetPath, legacyPath)), { recursive: true });
  fs.writeFileSync(path.join(fixture.folderAssetPath, legacyPath), 'old');
  const legacy = [{ ...draft.claudeFolders[0], version: 'legacy-v1',
    files: [{ ...draft.claudeFolders[0].files[0], storagePath: legacyPath }],
  }];
  const legacyJson = JSON.stringify(legacy);
  fixture.database.prepare('UPDATE agent_templates SET claude_folders_json = ? WHERE id = ?').run(legacyJson, draft.id);
  fixture.database.exec(`CREATE TRIGGER reject_legacy_edit BEFORE UPDATE OF claude_folders_json ON agent_templates
    WHEN NEW.summary = 'reject' BEGIN SELECT RAISE(ABORT, 'legacy SQL failure'); END;`);
  assert.throws(() => fixture.service.saveTemplate({ templateId: draft.id, userId: 1, input: { summary: 'reject' } }), /legacy SQL failure/);
  assert.equal(fixture.database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = ?').get(draft.id).claude_folders_json, legacyJson);
  assert.equal(fixture.folderAssets.readFile(legacy[0].files[0]).toString(), 'old');
  const restored = fixture.service.getTemplate(draft.id);
  assert.equal(fixture.folderAssets.readFile(restored.claudeFolders[0].files[0]).toString(), 'old');
  assert.equal(restored.claudeFolders[0].files[0].storagePath, `templates/${draft.id}/folders/commands/readme.txt`);
});

test('legacy template details migrate inline files without changing the template timestamp', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const draft = fixture.service.saveTemplate({ userId: 1, input: {
    name: '历史文件模板', category: '通用助手', tenantIds: [fixture.appTenantId],
  } });
  const legacyJson = JSON.stringify([{ name: 'commands', directories: ['empty'],
    files: [{ path: 'review.md', contentBase64: Buffer.from('legacy content').toString('base64') }],
  }]);
  fixture.database.prepare('UPDATE agent_templates SET claude_folders_json = ?, updated_at = ? WHERE id = ?')
    .run(legacyJson, '2024-01-02 03:04:05', draft.id);
  const migrated = fixture.service.getTemplate(draft.id);
  assert.equal(migrated.updatedAt, '2024-01-02 03:04:05');
  assert.equal(fixture.folderAssets.readFile(migrated.claudeFolders[0].files[0]).toString(), 'legacy content');
  assert.equal(JSON.stringify(migrated).includes('contentBase64'), false);
  assert.deepEqual(fixture.service.getTemplate(draft.id), migrated);

  fixture.database.prepare('UPDATE agent_templates SET claude_folders_json = ? WHERE id = ?').run(legacyJson, draft.id);
  const failingService = createAgentTemplateService(fixture.database, { folderAssets: {
    beginUpdate() { throw new Error('asset disk unavailable'); },
  } });
  assert.throws(() => failingService.getTemplate(draft.id), /asset disk unavailable/);
  assert.equal(fixture.database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = ?')
    .get(draft.id).claude_folders_json, legacyJson);
});

test('lazy legacy migration does not overwrite a concurrent template save', (t) => {
  const fixture = createFixture();
  t.after(() => fixture.database.close());
  const draft = fixture.service.saveTemplate({ userId: 1, input: {
    name: '并发迁移模板', category: '通用助手', tenantIds: [fixture.appTenantId],
  } });
  const legacyFolders = [{ name: 'commands', directories: [],
    files: [{ path: 'review.md', contentBase64: Buffer.from('legacy content').toString('base64') }],
  }];
  fixture.database.prepare('UPDATE agent_templates SET claude_folders_json = ? WHERE id = ?')
    .run(JSON.stringify(legacyFolders), draft.id);
  const newFolders = fixture.folderAssets.persistFolders([{ name: 'commands', directories: [],
    files: [{ path: 'review.md', contentBase64: Buffer.from('new saved content').toString('base64') }],
  }], { templateId: draft.id, templateName: draft.name });
  const newJson = JSON.stringify(newFolders);
  let persistCalls = 0;
  const service = createAgentTemplateService(fixture.database, { folderAssets: {
    beginUpdate(folders, options) {
      persistCalls += 1;
      assert.equal(fixture.database.inTransaction, true);
      const change = fixture.folderAssets.beginUpdate(folders, options);
      fixture.database.prepare('UPDATE agent_templates SET name = ?, claude_folders_json = ?, updated_at = ? WHERE id = ?')
        .run('并发保存的新模板', newJson, '2025-01-02 03:04:05', draft.id);
      return change;
    },
  } });
  const resolved = service.getTemplate(draft.id);
  assert.equal(persistCalls, 1);
  assert.equal(resolved.name, '并发保存的新模板');
  assert.equal(resolved.updatedAt, '2025-01-02 03:04:05');
  assert.deepEqual(resolved.claudeFolders, newFolders);
  assert.equal(fixture.database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = ?')
    .get(draft.id).claude_folders_json, newJson);
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
      claudeFolders: [{
        name: 'commands',
        directories: ['empty'],
        files: [{ path: 'review.md', contentBase64: Buffer.from('Review v1').toString('base64') }],
      }],
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
  const savedFiles = fs.readdirSync(fixture.folderAssetPath, { recursive: true });
  fixture.service.saveWorkspaceSnapshot({ workspaceId, userId: 1, snapshot });
  assert.deepEqual(fs.readdirSync(fixture.folderAssetPath, { recursive: true }), savedFiles,
    'workspace snapshots store audit metadata without touching template files');
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

  const updatedTemplate = fixture.service.saveTemplate({
    templateId: draft.id,
    userId: 1,
    input: { ...draft, claudeMarkdown: '# v2', claudeFolders: [{
      name: 'commands', directories: ['empty'],
      files: [{ path: 'review.md', contentBase64: Buffer.from('Review v2').toString('base64') }],
    }] },
  });
  assert.notEqual(updatedTemplate.claudeFolders[0].files[0].sha256, draft.claudeFolders[0].files[0].sha256);
  assert.equal(fixture.folderAssets.readFile(updatedTemplate.claudeFolders[0].files[0]).toString(), 'Review v2');
  const stored = fixture.database.prepare(`
    SELECT agent_markdown, skill_presets_json, mcp_presets_json, claude_folders_json
    FROM workspace_agent_template_snapshots WHERE workspace_id = ?
  `).get(workspaceId);
  assert.equal(stored.agent_markdown, '# v1');
  assert.equal(JSON.parse(stored.skill_presets_json)[0].id, fixture.skillId);
  assert.equal(JSON.parse(stored.mcp_presets_json)[0].id, fixture.mcpId);
  const expectedAudit = draft.claudeFolders.map(({ name, directories, files }) => ({
    name, directories, files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })),
  }));
  assert.deepEqual(JSON.parse(stored.claude_folders_json), expectedAudit);
  assert.equal(stored.claude_folders_json.includes('contentBase64'), false);
  assert.equal(stored.claude_folders_json.includes('storagePath'), false);
  assert.equal(stored.claude_folders_json.includes('version'), false);
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
  assert.deepEqual(JSON.parse(fixture.database.prepare(
    'SELECT claude_folders_json FROM workspace_agent_template_snapshots WHERE workspace_id = ?',
  ).get(workspaceId).claude_folders_json), expectedAudit, 'folder audit snapshots survive template deletion');
  assert.equal(Number(fixture.database.prepare(`
    SELECT COUNT(*) AS count FROM workspace_agent_template_mcp_installs
    WHERE workspace_id = ? AND template_id = ?
  `).get(workspaceId, draft.id).count), 1, 'template MCP install markers must remain historical records');
});

for (const hasAdvancedColumns of [false, true]) {
  test(`legacy workspace snapshot migration preserves folders and hooks (columns present: ${hasAdvancedColumns})`, (t) => {
    const database = new Database(':memory:');
    t.after(() => database.close());
    database.pragma('foreign_keys = ON');
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY);
      CREATE TABLE agent_templates (id INTEGER PRIMARY KEY);
      INSERT INTO users VALUES (1);
      INSERT INTO workspaces VALUES (1);
      INSERT INTO agent_templates VALUES (1);
      CREATE TABLE workspace_agent_template_snapshots (
        workspace_id INTEGER PRIMARY KEY,
        template_id INTEGER NOT NULL,
        template_name TEXT NOT NULL,
        template_updated_at DATETIME,
        agent_markdown TEXT NOT NULL DEFAULT '',
        guide_text TEXT NOT NULL DEFAULT '',
        skill_presets_json TEXT NOT NULL DEFAULT '[]',
        mcp_presets_json TEXT NOT NULL DEFAULT '[]',
        ${hasAdvancedColumns ? "hooks_json TEXT NOT NULL DEFAULT '[]', claude_folders_json TEXT NOT NULL DEFAULT '[]'," : ''}
        created_by_user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (template_id) REFERENCES agent_templates(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO workspace_agent_template_snapshots (workspace_id, template_id, template_name, created_by_user_id)
      VALUES (1, 1, '历史模板', 1);
    `);
    const folders = [{ name: 'commands', directories: [], files: [] }];
    const hooks = [{ id: 'hook-history', version: 2 }];
    if (hasAdvancedColumns) {
      database.prepare(`
        UPDATE workspace_agent_template_snapshots SET hooks_json = ?, claude_folders_json = ?
      `).run(JSON.stringify(hooks), JSON.stringify(folders));
    }
    migrateAgentTemplateSnapshotsToHistoricalReferences(database);
    migrateAgentTemplateSnapshotsToHistoricalReferences(database);
    database.prepare('DELETE FROM agent_templates WHERE id = 1').run();
    const snapshot = database.prepare('SELECT * FROM workspace_agent_template_snapshots').get();
    assert.equal(snapshot.template_name, '历史模板');
    assert.deepEqual(JSON.parse(snapshot.hooks_json), hasAdvancedColumns ? hooks : []);
    assert.deepEqual(JSON.parse(snapshot.claude_folders_json), hasAdvancedColumns ? folders : []);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  });
}

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

test('MCP template parameter strategies reject invalid types and preserve falsy values', () => {
  const fixture = createFixture();
  try {
    fixture.database.prepare('UPDATE mcp_server_presets SET tools_json = ? WHERE id = ?').run(JSON.stringify([{
      name: 'echo', inputSchema: { type: 'object', properties: {
        limit: { type: 'integer' }, enabled: { type: 'boolean' },
        filters: { type: 'array', items: { type: 'string' } },
        options: { type: 'object' }, region: { type: 'string', enum: ['cn', 'us'] },
        topic: { type: 'string' },
      } },
    }]), fixture.mcpId);
    const save = (param, value) => fixture.service.saveTemplate({ userId: 1, input: {
      name: `类型检查 ${param}`, category: '测试', tenantIds: [fixture.dataAgentTenantId], skillPresetRefs: [],
      mcpPresetRefs: [{ tenantId: fixture.dataAgentTenantId, presetId: fixture.mcpId,
        toolSettings: { allowedToolNames: ['echo'], tools: { echo: { params: { [param]: { mode: 'force', value } } } } },
      }],
    } });
    for (const [param, value] of [['limit', '7'], ['limit', 1.5], ['enabled', 'false'], ['filters', {}], ['filters', [1]], ['options', []], ['region', ''], ['topic', null]]) {
      assert.throws(() => save(param, value), /Invalid MCP parameter value/, `${param}: ${JSON.stringify(value)}`);
    }
    for (const [param, value] of [['limit', 0], ['enabled', false], ['filters', []], ['options', {}], ['region', 'cn'], ['topic', '']]) {
      assert.deepEqual(save(param, value).mcpPresetRefs[0].toolSettings.tools.echo.params[param].value, value);
    }
  } finally {
    fixture.database.close();
  }
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
