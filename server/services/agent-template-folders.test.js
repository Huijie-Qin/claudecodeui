import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_TEMPLATE_FOLDER_BYTES,
  MAX_TEMPLATE_FOLDER_ENTRIES,
  MAX_TEMPLATE_FOLDERS,
} from '../../shared/agentTemplateFolders.js';

import { normalizeTemplateFolders, writeWorkspaceTemplateFolders } from './agent-template-folders.js';
import { createAgentTemplateFolderAssetStore } from './agent-template-folder-assets.js';

const file = (filePath, content = 'hello') => ({
  path: filePath,
  contentBase64: Buffer.from(content).toString('base64'),
});
const folder = (name, files = [], directories = []) => ({ name, files, directories });

async function withWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-template-folders-'));
  try {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    await run(workspace, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('normalizes binary files, missing parent directories and empty folders without changing bytes', () => {
  const binary = Buffer.from([0, 255, 195, 40, 13, 10]);
  const input = [folder('资源', [file('nested/assets/binary.bin', binary), file('empty.txt', '')], ['empty']), folder('empty')];
  const normalized = normalizeTemplateFolders(input);
  assert.deepEqual(new Set(normalized[0].directories), new Set(['empty', 'nested', 'nested/assets']));
  assert.deepEqual(Buffer.from(normalized[0].files[0].contentBase64, 'base64'), binary);
  assert.deepEqual(normalizeTemplateFolders(normalized), normalized);
  assert.deepEqual(input[0].directories, ['empty']);
  assert.deepEqual(normalized[1], folder('empty'));
});

test('rejects traversal and paths that alias outside their folder on supported operating systems', () => {
  for (const unsafe of ['..', '.', '../escape', '/absolute', 'C:/escape', 'a\\b', 'a//b', 'a/../b', 'a/.', 'a\0b', 'a\nb', 'NUL', 'com1.txt', 'name.', 'name ', 'a:b', 'a/'.repeat(21) + 'b', '字'.repeat(86)]) {
    assert.throws(() => normalizeTemplateFolders([folder('safe', [file(unsafe)])]), { statusCode: 400 }, unsafe);
    assert.throws(() => normalizeTemplateFolders([folder('safe', [], [unsafe])]), { statusCode: 400 }, unsafe);
  }
  for (const unsafe of ['../escape', 'a/b', 'C:', '.', '', null]) {
    assert.throws(() => normalizeTemplateFolders([folder(unsafe)]), { statusCode: 400 });
  }
});

test('rejects duplicate names, case and unicode aliases, and file-directory collisions', () => {
  for (const input of [
    [folder('Rules'), folder('rules')],
    [folder('é'), folder('e\u0301')],
    [folder('safe', [file('a'), file('a')])],
    [folder('safe', [file('a'), file('a/child')])],
    [folder('safe', [file('a/child'), file('a')])],
    [folder('safe', [file('a')], ['a'])],
    [folder('safe', [file('A/child'), file('a/other')])],
    [folder('safe', [], ['a', 'a'])],
  ]) assert.throws(() => normalizeTemplateFolders(input), { statusCode: 400 });
});

test('rejects malformed content and enforces batch count, entry count, and decoded size limits', () => {
  for (const invalid of [null, {}, 'Zg', 'Zg===', 'Zh==', ' Zg==', '!!!!', '====']) {
    assert.throws(() => normalizeTemplateFolders([folder('safe', [{ path: 'file', contentBase64: invalid }])]), { statusCode: 400 });
  }
  assert.throws(() => normalizeTemplateFolders(null), { statusCode: 400 });
  assert.throws(() => normalizeTemplateFolders([{ name: 'safe', files: {} }]), { statusCode: 400 });
  assert.throws(() => normalizeTemplateFolders(Array.from({ length: MAX_TEMPLATE_FOLDERS + 1 }, (_, index) => folder(`folder-${index}`))), { statusCode: 400 });
  assert.throws(() => normalizeTemplateFolders([folder('safe', Array.from({ length: MAX_TEMPLATE_FOLDER_ENTRIES }, (_, index) => file(`parent/file-${index}`, '')))]), { statusCode: 400 });
  const chunk = Buffer.alloc(MAX_TEMPLATE_FOLDER_BYTES / 2 + 1);
  assert.throws(() => normalizeTemplateFolders([folder('one', [file('a', chunk)]), folder('two', [file('b', chunk)])]), { statusCode: 400 });
});

test('validates stored references and counts their size together with new uploads', () => {
  const reference = { path: 'nested/stored.bin', size: 12, sha256: 'a'.repeat(64),
    storagePath: 'templates/1/folders/assets/nested/stored.bin' };
  const normalized = normalizeTemplateFolders([folder('assets', [reference, file('new.txt', 'new')])]);
  assert.deepEqual(normalized[0].files, [reference, file('new.txt', 'new')]);
  assert.deepEqual(normalized[0].directories, ['nested']);
  for (const invalid of [
    { ...reference, size: -1 },
    { ...reference, size: 1.5 },
    { ...reference, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...reference, sha256: '../outside' },
    { ...reference, sha256: 'A'.repeat(64) },
    { ...reference, contentBase64: '' },
    { ...reference, storagePath: '/absolute/file' },
    { ...reference, storagePath: 'templates/1/versions/../folders/assets/nested/stored.bin' },
    { ...reference, storagePath: 'templates/1/folders/other/nested/stored.bin' },
    { ...reference, storagePath: 'templates/1/folders/assets/another.bin' },
    { ...reference, storagePath: 'templates/1/folders/assets/../nested/stored.bin' },
  ]) assert.throws(() => normalizeTemplateFolders([folder('assets', [invalid])]), { statusCode: 400 });
  const legacyReference = { ...reference,
    storagePath: 'templates/1/versions/legacy-version/folders/assets/nested/stored.bin' };
  const [legacy] = normalizeTemplateFolders([{ ...folder('assets', [legacyReference]), version: 'legacy-version' }]);
  assert.equal(Object.hasOwn(legacy, 'version'), false);
  assert.deepEqual(legacy.files, [legacyReference]);
  assert.throws(() => normalizeTemplateFolders([
    folder('assets', [{ ...reference, size: MAX_TEMPLATE_FOLDER_BYTES }]),
    folder('uploaded', [file('new.txt', 'a')]),
  ]), { statusCode: 400 });
});

test('materializes persisted template files and keeps workspace edits independent from templates', async () => {
  await withWorkspace(async (workspace, root) => {
    const folderAssets = createAgentTemplateFolderAssetStore({ rootPath: path.join(root, 'assets') });
    const binary = Buffer.from([0, 255, 128, 42]);
    const metadata = folderAssets.persistFolders(normalizeTemplateFolders([
      folder('resources', [file('nested/data.bin', binary), file('empty', '')], ['empty-dir']),
    ]), { templateId: 1, templateName: 'Workspace fixture' });
    assert.ok(!JSON.stringify(metadata).includes('contentBase64'));
    await writeWorkspaceTemplateFolders(workspace, metadata, { folderAssets });
    const materialized = path.join(workspace, '.claude/resources/nested/data.bin');
    assert.deepEqual(await fs.readFile(materialized), binary);
    assert.deepEqual(await fs.readdir(path.join(workspace, '.claude/resources/empty-dir')), []);
    await fs.writeFile(materialized, 'workspace change');
    assert.deepEqual(folderAssets.readFile(metadata[0].files.find((entry) => entry.path === 'nested/data.bin')), binary);
  });
});

test('missing or corrupted stored content fails before creating any workspace folders', async () => {
  for (const corrupt of [false, true]) {
    await withWorkspace(async (workspace, root) => {
      const assetsRoot = path.join(root, 'assets');
      const folderAssets = createAgentTemplateFolderAssetStore({ rootPath: assetsRoot });
      const metadata = folderAssets.persistFolders(normalizeTemplateFolders([
        folder('first', [file('good', 'good')]), folder('second', [file('bad', 'original')]),
      ]), { templateId: 1, templateName: 'Corruption fixture' });
      const filePath = path.join(assetsRoot, metadata[1].files[0].storagePath);
      if (corrupt) await fs.writeFile(filePath, 'tampered');
      else await fs.unlink(filePath);
      await assert.rejects(writeWorkspaceTemplateFolders(workspace, metadata, { folderAssets }));
      assert.deepEqual(await fs.readdir(workspace), []);
    });
  }
});

test('materializes several folders under .claude preserving nested, hidden, binary and empty contents', async () => {
  await withWorkspace(async (workspace) => {
    const binary = Buffer.from([0, 255, 128, 42]);
    await fs.mkdir(path.join(workspace, '.claude', 'rules'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.claude', 'rules', 'existing.md'), 'keep');
    const result = await writeWorkspaceTemplateFolders(workspace, [
      folder('rules', [file('nested/中文.md', '规则\r\n'), file('.hidden', '')], ['empty']),
      folder('assets', [file('sample.bin', binary)]),
      folder('empty'),
    ]);
    assert.deepEqual(result.map((item) => item.path), ['.claude/rules', '.claude/assets', '.claude/empty']);
    assert.equal(await fs.readFile(path.join(workspace, '.claude/rules/nested/中文.md'), 'utf8'), '规则\r\n');
    assert.equal(await fs.readFile(path.join(workspace, '.claude/rules/existing.md'), 'utf8'), 'keep');
    assert.equal((await fs.stat(path.join(workspace, '.claude/rules/.hidden'))).size, 0);
    assert.deepEqual(await fs.readFile(path.join(workspace, '.claude/assets/sample.bin')), binary);
    assert.deepEqual(await fs.readdir(path.join(workspace, '.claude/rules/empty')), []);
    assert.deepEqual(await fs.readdir(path.join(workspace, '.claude/empty')), []);
  });
});

test('preflights all folders and preserves existing content when a later file conflicts', async () => {
  await withWorkspace(async (workspace) => {
    await fs.mkdir(path.join(workspace, '.claude/second'), { recursive: true });
    await fs.writeFile(path.join(workspace, '.claude/second/existing'), 'keep');
    await assert.rejects(writeWorkspaceTemplateFolders(workspace, [
      folder('first', [file('new')]), folder('second', [file('existing', 'replace')]),
    ]), { statusCode: 409 });
    assert.deepEqual(await fs.readdir(path.join(workspace, '.claude')), ['second']);
    assert.equal(await fs.readFile(path.join(workspace, '.claude/second/existing'), 'utf8'), 'keep');
  });
});

test('rejects symbolic links at .claude, root folder, intermediate directory and destination file', async () => {
  for (const target of ['.claude', '.claude/rules', '.claude/rules/nested', '.claude/rules/nested/file']) {
    await withWorkspace(async (workspace, root) => {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
      const symlink = path.join(workspace, target);
      await fs.mkdir(path.dirname(symlink), { recursive: true });
      await fs.symlink(outside, symlink);
      await assert.rejects(writeWorkspaceTemplateFolders(workspace, [folder('rules', [file('nested/file')])]), { statusCode: 409 });
      assert.deepEqual(await fs.readdir(outside), ['sentinel']);
      assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'keep');
    });
  }
});

test('invalid batches and templates without folders make no filesystem changes', async () => {
  await withWorkspace(async (workspace) => {
    await assert.rejects(writeWorkspaceTemplateFolders(workspace, [folder('valid'), folder('../invalid')]), { statusCode: 400 });
    assert.deepEqual(await fs.readdir(workspace), []);
    assert.deepEqual(await writeWorkspaceTemplateFolders(workspace, []), []);
    assert.deepEqual(await fs.readdir(workspace), []);
  });
});
