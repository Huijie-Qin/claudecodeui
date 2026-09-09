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
