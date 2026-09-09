import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createAgentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';

import { migrateAgentTemplateFolderStorage, toTemplateFolderAudit } from './agent-template-folder-migration.js';

function fixture(t) {
  const database = new Database(':memory:');
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-template-folder-migration-'));
  const folderAssets = createAgentTemplateFolderAssetStore({ rootPath });
  t.after(() => {
    database.close();
    fs.rmSync(rootPath, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE agent_templates (id INTEGER PRIMARY KEY, claude_folders_json TEXT NOT NULL, updated_at TEXT,
      name TEXT NOT NULL DEFAULT '历史模板');
    CREATE TABLE workspace_agent_template_snapshots (workspace_id INTEGER PRIMARY KEY, claude_folders_json TEXT NOT NULL, created_at TEXT,
      template_id INTEGER NOT NULL DEFAULT 1, template_name TEXT NOT NULL DEFAULT '历史模板');
  `);
  const insertTemplate = (id, json) => database.prepare('INSERT INTO agent_templates (id, claude_folders_json, updated_at) VALUES (?, ?, ?)').run(id, json, '2024-01-01');
  const insertSnapshot = (id, json, templateId = 1) => database.prepare('INSERT INTO workspace_agent_template_snapshots (workspace_id, claude_folders_json, created_at, template_id) VALUES (?, ?, ?, ?)').run(id, json, '2024-02-02', templateId);
  return { database, rootPath, folderAssets, insertTemplate, insertSnapshot };
}

const bytes = Buffer.from([0, 255, 128, 10]);
const digest = createHash('sha256').update(bytes).digest('hex');
const legacyFolders = [{ name: 'resources', directories: ['empty', 'nested'],
  files: [{ path: 'nested/data.bin', contentBase64: bytes.toString('base64') }],
}];
const legacyJson = JSON.stringify(legacyFolders);
const audit = [{ name: 'resources', directories: ['empty', 'nested'],
  files: [{ path: 'nested/data.bin', size: bytes.length, sha256: digest }],
}];

test('migration stores only current template files and converts workspace history to independent audit metadata', (t) => {
  const { database, rootPath, folderAssets, insertTemplate, insertSnapshot } = fixture(t);
  insertTemplate(1, legacyJson);
  insertSnapshot(9, legacyJson);
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 1, snapshots: 1 });
  const template = database.prepare('SELECT * FROM agent_templates').get();
  const snapshot = database.prepare('SELECT * FROM workspace_agent_template_snapshots').get();
  assert.equal(template.updated_at, '2024-01-01');
  assert.equal(snapshot.created_at, '2024-02-02');
  const [folder] = JSON.parse(template.claude_folders_json);
  assert.equal(Object.hasOwn(folder, 'version'), false);
  assert.equal(folder.files[0].storagePath, 'templates/1/folders/resources/nested/data.bin');
  assert.deepEqual(folderAssets.readFile(folder.files[0]), bytes);
  assert.deepEqual(JSON.parse(snapshot.claude_folders_json), audit);
  assert.equal(fs.statSync(path.join(rootPath, 'templates/1/folders/resources/empty')).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(rootPath, 'templates/1/versions')), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(rootPath, 'templates/1/manifest.json'), 'utf8'));
  assert.equal(manifest.templateId, 1);
  assert.equal(manifest.templateName, '历史模板');
  assert.equal(Object.hasOwn(manifest, 'version'), false);
  const filesBefore = fs.readdirSync(rootPath, { recursive: true });
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 0, snapshots: 0 });
  assert.deepEqual(fs.readdirSync(rootPath, { recursive: true }), filesBefore);
});

test('snapshot conversion never reads assets, overwrites current content, or resurrects a deleted template', (t) => {
  const { database, rootPath, folderAssets, insertSnapshot } = fixture(t);
  const current = folderAssets.persistFolders([{ name: 'resources', directories: [],
    files: [{ path: 'data.txt', contentBase64: Buffer.from('current').toString('base64') }],
  }], { templateId: 1, templateName: '当前模板' });
  insertSnapshot(1, legacyJson, 1);
  insertSnapshot(2, JSON.stringify([{ ...audit[0], version: 'old-v1', files: [{
    ...audit[0].files[0], storagePath: 'templates/99/versions/old-v1/folders/resources/nested/data.bin',
  }] }]), 99);
  const filesBefore = fs.readdirSync(rootPath, { recursive: true });
  const forbiddenStore = new Proxy({}, { get() { throw new Error('snapshot migration must not access the asset store'); } });
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets: forbiddenStore }), { templates: 0, snapshots: 2 });
  assert.equal(folderAssets.readFile(current[0].files[0]).toString(), 'current');
  assert.deepEqual(fs.readdirSync(rootPath, { recursive: true }), filesBefore);
  assert.equal(fs.existsSync(path.join(rootPath, 'templates/99')), false);
  assert.deepEqual(database.prepare('SELECT claude_folders_json FROM workspace_agent_template_snapshots').all().map((row) => JSON.parse(row.claude_folders_json)), [audit, audit]);
});

test('legacy hash objects migrate into current storage while snapshot hashes require no old object', (t) => {
  const { database, rootPath, folderAssets, insertTemplate, insertSnapshot } = fixture(t);
  const objectPath = path.join(rootPath, 'objects', digest.slice(0, 2), digest);
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, bytes);
  const oldJson = JSON.stringify([{ ...audit[0], version: 'a'.repeat(64) }]);
  insertTemplate(3, oldJson);
  insertSnapshot(9, JSON.stringify([{ ...audit[0], files: [{ ...audit[0].files[0], sha256: 'd'.repeat(64) }] }]), 99);
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 1, snapshots: 0 });
  const [folder] = JSON.parse(database.prepare('SELECT claude_folders_json FROM agent_templates').get().claude_folders_json);
  assert.equal(folder.files[0].storagePath, 'templates/3/folders/resources/nested/data.bin');
  assert.deepEqual(folderAssets.readFile(folder.files[0]), bytes);
  assert.deepEqual(fs.readFileSync(objectPath), bytes);
  assert.equal(fs.existsSync(path.join(rootPath, 'templates/99')), false);
});

test('old version directories become current files and SQL failures restore their original references and bytes', (t) => {
  const { database, rootPath, folderAssets, insertTemplate } = fixture(t);
  const storagePath = 'templates/1/versions/old-v1/folders/resources/nested/data.bin';
  fs.mkdirSync(path.dirname(path.join(rootPath, storagePath)), { recursive: true });
  fs.writeFileSync(path.join(rootPath, storagePath), bytes);
  const oldJson = JSON.stringify([{ ...audit[0], version: 'old-v1', files: [{ ...audit[0].files[0], storagePath }] }]);
  insertTemplate(1, oldJson);
  database.exec(`CREATE TRIGGER fail_migration BEFORE UPDATE OF claude_folders_json ON agent_templates
    BEGIN SELECT RAISE(ABORT, 'simulated migration SQL failure'); END;`);
  assert.throws(() => migrateAgentTemplateFolderStorage(database, { folderAssets }), /simulated migration SQL failure/);
  assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates').get().claude_folders_json, oldJson);
  assert.deepEqual(fs.readFileSync(path.join(rootPath, storagePath)), bytes);
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
  database.exec('DROP TRIGGER fail_migration');
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 1, snapshots: 0 });
  assert.deepEqual(fs.readFileSync(path.join(rootPath, 'templates/1/folders/resources/nested/data.bin')), bytes);
  assert.equal(fs.existsSync(path.join(rootPath, 'templates/1/versions')), false);
});

test('legacy empty folders migrate once and missing old objects keep their database references', (t) => {
  const { database, rootPath, folderAssets, insertTemplate } = fixture(t);
  insertTemplate(1, JSON.stringify([{ name: 'empty', directories: ['nested'], files: [] }]));
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 1, snapshots: 0 });
  assert.equal(fs.statSync(path.join(rootPath, 'templates/1/folders/empty/nested')).isDirectory(), true);
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 0, snapshots: 0 });
  const missingJson = JSON.stringify([{ name: 'resources', directories: [],
    files: [{ path: 'missing.bin', size: 4, sha256: 'd'.repeat(64) }],
  }]);
  database.prepare('UPDATE agent_templates SET claude_folders_json = ? WHERE id = 1').run(missingJson);
  assert.throws(() => migrateAgentTemplateFolderStorage(database, { folderAssets }), /agent_templates/);
  assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates').get().claude_folders_json, missingJson);
  assert.equal(fs.statSync(path.join(rootPath, 'templates/1/folders/empty/nested')).isDirectory(), true);
});

test('invalid legacy contents are reported without erasing their database record', (t) => {
  const { database, folderAssets, insertTemplate } = fixture(t);
  insertTemplate(1, '[]');
  for (const invalidJson of [
    '{"broken":',
    JSON.stringify([{ name: 'commands', files: [{ path: '../escape', contentBase64: 'YQ==' }] }]),
    JSON.stringify([{ name: 'commands', files: [{ path: 'readme.md', contentBase64: '???' }] }]),
  ]) {
    database.prepare('UPDATE agent_templates SET claude_folders_json = ? WHERE id = 1').run(invalidJson);
    assert.throws(() => migrateAgentTemplateFolderStorage(database, { folderAssets }), /agent_templates/);
    assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates').get().claude_folders_json, invalidJson);
  }
});

test('startup error reporting preserves a bad row and continues later rows and snapshot audits', (t) => {
  const { database, folderAssets, insertTemplate, insertSnapshot } = fixture(t);
  const brokenJson = '{"broken":';
  insertTemplate(1, brokenJson);
  insertTemplate(2, legacyJson);
  insertSnapshot(9, legacyJson);
  const errors = [];
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, {
    folderAssets, onError: (error) => errors.push(error),
  }), { templates: 1, snapshots: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /agent_templates/);
  assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = 1').get().claude_folders_json, brokenJson);
  assert.deepEqual(JSON.parse(database.prepare('SELECT claude_folders_json FROM workspace_agent_template_snapshots').get().claude_folders_json), audit);
});

test('audit conversion retains only names, directory structure, sizes, and checksums', () => {
  assert.deepEqual(toTemplateFolderAudit(legacyFolders), audit);
  assert.deepEqual(toTemplateFolderAudit([{ ...audit[0], version: 'old-v1', files: [{
    ...audit[0].files[0], storagePath: 'templates/1/folders/resources/nested/data.bin',
  }] }]), audit);
});

test('migration skips absent legacy tables and columns', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE agent_templates (id INTEGER PRIMARY KEY)');
  assert.deepEqual(migrateAgentTemplateFolderStorage(database), { templates: 0, snapshots: 0 });
});
