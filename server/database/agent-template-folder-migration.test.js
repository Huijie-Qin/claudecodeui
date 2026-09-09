import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createAgentTemplateFolderAssetStore } from '../services/agent-template-folder-assets.js';

import { migrateAgentTemplateFolderStorage } from './agent-template-folder-migration.js';

function fixture(t) {
  const database = new Database(':memory:');
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-template-folder-migration-'));
  const folderAssets = createAgentTemplateFolderAssetStore({ rootPath });
  t.after(() => {
    database.close();
    fs.rmSync(rootPath, { recursive: true, force: true });
  });
  database.exec(`
    CREATE TABLE agent_templates (id INTEGER PRIMARY KEY, claude_folders_json TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE workspace_agent_template_snapshots (workspace_id INTEGER PRIMARY KEY, claude_folders_json TEXT NOT NULL, created_at TEXT);
  `);
  return { database, rootPath, folderAssets };
}

const bytes = Buffer.from([0, 255, 128, 10]);
const legacyJson = JSON.stringify([{ name: 'resources', directories: ['empty', 'nested'],
  files: [{ path: 'nested/data.bin', contentBase64: bytes.toString('base64') }],
}]);

test('folder migration replaces both legacy tables with shared immutable metadata and is idempotent', (t) => {
  const { database, rootPath, folderAssets } = fixture(t);
  database.prepare('INSERT INTO agent_templates VALUES (1, ?, ?)').run(legacyJson, '2024-01-01');
  database.prepare('INSERT INTO workspace_agent_template_snapshots VALUES (9, ?, ?)').run(legacyJson, '2024-02-02');
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 1, snapshots: 1 });
  const template = database.prepare('SELECT * FROM agent_templates').get();
  const snapshot = database.prepare('SELECT * FROM workspace_agent_template_snapshots').get();
  assert.equal(template.updated_at, '2024-01-01');
  assert.equal(snapshot.created_at, '2024-02-02');
  assert.equal(template.claude_folders_json, snapshot.claude_folders_json);
  assert.equal(template.claude_folders_json.includes('contentBase64'), false);
  const [folder] = JSON.parse(template.claude_folders_json);
  assert.deepEqual(folder.directories, ['empty', 'nested']);
  assert.equal(folder.files[0].size, bytes.length);
  assert.ok(folder.version);
  assert.deepEqual(folderAssets.readFile(folder.files[0]), bytes);
  const filesBefore = fs.readdirSync(rootPath, { recursive: true });
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 0, snapshots: 0 });
  assert.deepEqual(fs.readdirSync(rootPath, { recursive: true }), filesBefore);
});

test('failed asset persistence preserves the original inline row and can resume safely', (t) => {
  const { database, folderAssets } = fixture(t);
  database.prepare('INSERT INTO agent_templates VALUES (1, ?, ?)').run(legacyJson, '2024-01-01');
  database.prepare('INSERT INTO workspace_agent_template_snapshots VALUES (9, ?, ?)').run(legacyJson, '2024-02-02');
  let calls = 0;
  const failingAssets = { persistFolders(folders, options) {
    const metadata = folderAssets.persistFolders(folders, options);
    calls += 1;
    if (calls === 2) throw new Error('simulated write failure');
    return metadata;
  } };
  assert.throws(() => migrateAgentTemplateFolderStorage(database, { folderAssets: failingAssets }),
    /workspace_agent_template_snapshots \(9\).*simulated write failure/);
  assert.equal(database.prepare('SELECT claude_folders_json FROM workspace_agent_template_snapshots').get().claude_folders_json, legacyJson);
  assert.equal(database.prepare('SELECT created_at FROM workspace_agent_template_snapshots').get().created_at, '2024-02-02');
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, { folderAssets }), { templates: 0, snapshots: 1 });
});

test('invalid legacy contents are reported without erasing their database record', (t) => {
  const { database, folderAssets } = fixture(t);
  for (const invalidJson of [
    '{"broken":',
    JSON.stringify([{ name: 'commands', files: [{ path: '../escape', contentBase64: 'YQ==' }] }]),
    JSON.stringify([{ name: 'commands', files: [{ path: 'readme.md', contentBase64: '???' }] }]),
  ]) {
    database.prepare('INSERT OR REPLACE INTO agent_templates VALUES (1, ?, ?)').run(invalidJson, '2024-01-01');
    assert.throws(() => migrateAgentTemplateFolderStorage(database, { folderAssets }), /agent_templates \(1\)/);
    assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates').get().claude_folders_json, invalidJson);
  }
});

test('migration skips absent legacy tables and columns', (t) => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.exec('CREATE TABLE agent_templates (id INTEGER PRIMARY KEY)');
  assert.deepEqual(migrateAgentTemplateFolderStorage(database), { templates: 0, snapshots: 0 });
});

test('startup error reporting preserves a bad row and continues later rows and tables', (t) => {
  const { database, folderAssets } = fixture(t);
  const brokenJson = '{"broken":';
  database.prepare('INSERT INTO agent_templates VALUES (1, ?, ?)').run(brokenJson, '2024-01-01');
  database.prepare('INSERT INTO agent_templates VALUES (2, ?, ?)').run(legacyJson, '2024-01-02');
  database.prepare('INSERT INTO workspace_agent_template_snapshots VALUES (9, ?, ?)').run(legacyJson, '2024-02-02');
  const errors = [];
  assert.deepEqual(migrateAgentTemplateFolderStorage(database, {
    folderAssets, onError: (error) => errors.push(error),
  }), { templates: 1, snapshots: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /agent_templates \(1\)/);
  assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = 1').get().claude_folders_json, brokenJson);
  assert.equal(database.prepare('SELECT claude_folders_json FROM agent_templates WHERE id = 2').get().claude_folders_json.includes('contentBase64'), false);
  assert.equal(database.prepare('SELECT claude_folders_json FROM workspace_agent_template_snapshots').get().claude_folders_json.includes('contentBase64'), false);
});
