import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import {
  createAgentTemplateFolderAssetStore,
  resolveAgentTemplateAssetsRoot,
} from './agent-template-folder-assets.js';

function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-template-assets-'));
  const rootPath = path.join(temporaryRoot, 'assets');
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return { temporaryRoot, rootPath, store: createAgentTemplateFolderAssetStore({ rootPath }) };
}

function uploadedFile(filePath, content) {
  return { path: filePath, contentBase64: Buffer.from(content).toString('base64') };
}

function uploadedFolder(name = 'skills', content = 'Example skill') {
  return { name, directories: ['empty'], files: [uploadedFile('SKILL.md', content)] };
}

function currentPath(rootPath, templateId = 1) {
  return path.join(rootPath, 'templates', String(templateId));
}

function save(store, folders, options = {}) {
  return store.persistFolders(folders, { templateId: 1, ...options });
}

function legacyFile(rootPath, { versioned = false, content = 'legacy content' } = {}) {
  const bytes = Buffer.from(content);
  const file = { path: 'old.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (versioned) file.storagePath = 'templates/1/versions/old-version/folders/old/old.txt';
  const target = file.storagePath
    ? path.join(rootPath, file.storagePath)
    : path.join(rootPath, 'objects', file.sha256.slice(0, 2), file.sha256);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { file, target, bytes };
}

test('asset root follows explicit override, data root, database directory, and application defaults', () => {
  assert.equal(resolveAgentTemplateAssetsRoot({
    CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: ' /srv/cloudcli/custom/../assets ',
    CLOUDCLI_DATA_ROOT: '/srv/cloudcli/data', DATABASE_PATH: '/srv/cloudcli/database/auth.db',
  }), '/srv/cloudcli/assets');
  assert.equal(resolveAgentTemplateAssetsRoot({
    CLOUDCLI_DATA_ROOT: '/srv/cloudcli/data', DATABASE_PATH: '/srv/cloudcli/database/auth.db',
  }), '/srv/cloudcli/data/agent-template-assets');
  assert.equal(resolveAgentTemplateAssetsRoot({ DATABASE_PATH: '/srv/cloudcli/database/auth.db' }),
    '/srv/cloudcli/database/agent-template-assets');
  const defaultRoot = path.join(findAppRoot(getModuleDir(import.meta.url)), 'data', 'agent-template-assets');
  assert.equal(resolveAgentTemplateAssetsRoot({}), defaultRoot);
  assert.equal(resolveAgentTemplateAssetsRoot({ CLOUDCLI_DATA_ROOT: './data', DATABASE_PATH: './auth.db' }), defaultRoot);
  for (const root of ['./assets', '/', '/somewhere/..', '/tmp/\0unsafe']) {
    assert.throws(() => resolveAgentTemplateAssetsRoot({ CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: root }),
      /must be an absolute path|must not be the filesystem root/);
    assert.throws(() => createAgentTemplateFolderAssetStore({ rootPath: root }),
      /must be an absolute path|must not be the filesystem root/);
  }
});

test('stores are lazy, all updates require a template ID, and empty directories are saved without versions', (t) => {
  const { rootPath, store } = fixture(t);
  const folders = [{ name: 'empty', directories: ['nested', 'nested/deeper'], files: [] }];
  assert.equal(store.isCurrentTemplate(folders, { templateId: 1 }), false);
  assert.equal(fs.existsSync(rootPath), false);
  for (const templateId of [undefined, 0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.beginUpdate(folders, { templateId }), /templateId 必须为正整数/);
    assert.throws(() => store.beginUpdate([], { templateId }), /templateId 必须为正整数/);
  }
  assert.equal(fs.existsSync(rootPath), false);
  const saved = save(store, folders, { templateName: '空文件夹模板' });
  assert.deepEqual(saved, folders);
  assert.ok(fs.statSync(path.join(currentPath(rootPath), 'folders/empty/nested/deeper')).isDirectory());
  assert.equal(store.isCurrentTemplate(saved, { templateId: 1 }), true);
  assert.equal(store.isCurrentTemplate(saved, { templateId: 2 }), false);
  fs.rmdirSync(path.join(currentPath(rootPath), 'folders/empty/nested/deeper'));
  assert.equal(store.isCurrentTemplate(saved, { templateId: 1 }), false);
});

test('binary files retain their names and are independent files across folders, templates, and saves', (t) => {
  const { rootPath, store } = fixture(t);
  const binary = Buffer.from([0, 255, 128, 1, 2, 10, 0, 127]);
  const saved = save(store, [
    { name: 'two', directories: ['empty'], files: [uploadedFile('asset.bin', binary)] },
    { name: 'one', directories: ['nested'], files: [uploadedFile('nested/copy.bin', binary)] },
  ], { templateName: '二进制测试' });
  assert.deepEqual(saved.map((folder) => folder.name), ['two', 'one']);
  const first = saved[0].files[0];
  assert.equal(first.storagePath, 'templates/1/folders/two/asset.bin');
  assert.equal(first.sha256, createHash('sha256').update(binary).digest('hex'));
  assert.equal(first.size, binary.length);
  assert.deepEqual(store.readFile(first), binary);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(currentPath(rootPath), 'manifest.json'), 'utf8')),
    { templateId: 1, templateName: '二进制测试', folders: saved });
  assert.equal(JSON.stringify(saved).includes('version'), false);
  assert.equal(JSON.stringify(saved).includes('contentBase64'), false);
  assert.equal(fs.existsSync(path.join(rootPath, 'objects')), false);
  const originalStats = saved.map((folder) => fs.statSync(path.join(rootPath, folder.files[0].storagePath)));
  assert.notEqual(originalStats[0].ino, originalStats[1].ino);
  assert.ok(originalStats.every((stat) => stat.isFile() && stat.nlink === 1));
  const other = save(store, saved, { templateId: 2, trusted: true });
  assert.notEqual(fs.statSync(path.join(rootPath, other[0].files[0].storagePath)).ino, originalStats[0].ino);
  const updated = save(store, saved, { existingFolders: saved });
  assert.deepEqual(updated, saved);
  assert.notEqual(fs.statSync(path.join(rootPath, first.storagePath)).ino, originalStats[0].ino);
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')).sort(), ['1', '2']);
  assert.deepEqual(fs.readdirSync(currentPath(rootPath)).sort(), ['folders', 'manifest.json']);
});

test('replacing and clearing a template remove obsolete files and empty directories without touching other templates', (t) => {
  const { rootPath, store } = fixture(t);
  save(store, [uploadedFolder('old'), { name: 'empty-old', directories: ['nested'], files: [] }]);
  const other = save(store, [uploadedFolder('keep')], { templateId: 2 });
  save(store, [uploadedFolder('new', 'updated')]);
  assert.deepEqual(fs.readdirSync(path.join(currentPath(rootPath), 'folders')), ['new']);
  assert.deepEqual(save(store, []), []);
  assert.deepEqual(fs.readdirSync(path.join(currentPath(rootPath), 'folders')), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(currentPath(rootPath), 'manifest.json'), 'utf8')),
    { templateId: 1, templateName: '', folders: [] });
  assert.equal(store.isCurrentTemplate([], { templateId: 1 }), true);
  assert.equal(store.readFile(other[0].files[0]).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')).sort(), ['1', '2']);
});

test('a database failure can roll back a complete directory replacement and restore the original metadata and bytes', (t) => {
  const { rootPath, store } = fixture(t);
  const saved = save(store, [uploadedFolder()]);
  const before = fs.readdirSync(currentPath(rootPath), { recursive: true }).sort();
  const oldManifest = fs.readFileSync(path.join(currentPath(rootPath), 'manifest.json'));
  const update = store.beginUpdate([uploadedFolder('new', 'new content')], { templateId: 1 });
  assert.equal(store.readFile(update.folders[0].files[0]).toString(), 'new content');
  assert.equal(fs.readdirSync(path.join(rootPath, 'templates')).filter((name) => name.startsWith('.backup-')).length, 1);
  update.rollback();
  update.rollback();
  assert.deepEqual(fs.readdirSync(currentPath(rootPath), { recursive: true }).sort(), before);
  assert.deepEqual(fs.readFileSync(path.join(currentPath(rootPath), 'manifest.json')), oldManifest);
  assert.equal(store.readFile(saved[0].files[0]).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
  const fresh = store.beginUpdate([uploadedFolder('fresh')], { templateId: 2 });
  fresh.rollback();
  assert.equal(fs.existsSync(currentPath(rootPath, 2)), false);
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});

test('commit removes the transaction backup and subsequent rollback cannot undo committed contents', (t) => {
  const { rootPath, store } = fixture(t);
  save(store, [uploadedFolder()]);
  const update = store.beginUpdate([uploadedFolder('replacement')], { templateId: 1 });
  update.commit();
  update.commit();
  update.rollback();
  assert.equal(store.readFile(update.folders[0].files[0]).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
  assert.deepEqual(fs.readdirSync(path.join(currentPath(rootPath), 'folders')), ['replacement']);
});

test('rollback restores the old directory even when rejected-content cleanup fails', (t) => {
  const { rootPath, store } = fixture(t);
  const saved = save(store, [uploadedFolder()]);
  const update = store.beginUpdate([uploadedFolder('new', 'new bytes')], { templateId: 1 });
  const originalRemove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (path.basename(target).startsWith('.upload-')) {
      throw Object.assign(new Error('simulated rollback cleanup failure'), { code: 'EIO' });
    }
    return originalRemove(target, options);
  };
  try {
    assert.throws(() => update.rollback(), /rollback cleanup failure/);
    assert.equal(store.readFile(saved[0].files[0]).toString(), 'Example skill');
  } finally {
    fs.rmSync = originalRemove;
  }
  update.rollback();
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});

test('all references are authorized and source bytes validated before modifying the current directory', (t) => {
  const { rootPath, store } = fixture(t);
  const [saved] = save(store, [uploadedFolder()]);
  const file = saved.files[0];
  const other = save(store, [uploadedFolder()], { templateId: 2 })[0];
  for (const folders of [
    [{ ...saved, name: 'other' }],
    [{ ...saved, files: [{ ...file, path: 'other.md', storagePath: file.storagePath.replace('SKILL.md', 'other.md') }] }],
    [{ ...saved, files: [{ ...file, size: file.size + 1 }] }],
    [{ ...saved, files: [{ ...file, sha256: '0'.repeat(64) }] }],
    [{ ...saved, files: [{ ...file, storagePath: other.files[0].storagePath }] }],
  ]) assert.throws(() => save(store, folders, { existingFolders: [saved] }), /资源引用无效/);
  assert.throws(() => save(store, [saved]), /资源引用无效/);
  const unknownFile = { path: 'a', size: 4, sha256: '0'.repeat(64) };
  assert.throws(() => save(store, [
    uploadedFolder('new'), { name: 'missing', directories: [], files: [unknownFile] },
  ], { trusted: true }), /资源目录不存在/);
  assert.equal(store.readFile(file).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')).sort(), ['1', '2']);
});

test('legacy version directories and objects can be read and migrated to one current template directory', (t) => {
  for (const versioned of [true, false]) {
    const { rootPath, store } = fixture(t);
    const legacy = legacyFile(rootPath, { versioned, content: Buffer.from([0, 255, 128]) });
    assert.deepEqual(store.readFile(legacy.file), legacy.bytes);
    const migrated = save(store, [{ name: 'old', directories: ['empty'], files: [legacy.file] }], { trusted: true });
    assert.equal(migrated[0].files[0].storagePath, 'templates/1/folders/old/old.txt');
    assert.deepEqual(store.readFile(migrated[0].files[0]), legacy.bytes);
    assert.deepEqual(fs.readdirSync(currentPath(rootPath)).sort(), ['folders', 'manifest.json']);
    if (!versioned) assert.deepEqual(fs.readFileSync(legacy.target), legacy.bytes);
  }
});

test('storage paths reject traversal, unsafe IDs, transaction directories, and mismatched suffixes', (t) => {
  const { store } = fixture(t);
  const [saved] = save(store, [uploadedFolder()]);
  const file = saved.files[0];
  for (const storagePath of [
    '/etc/passwd', '../outside', 'objects/ab/hash', file.storagePath.replace('templates/1/', 'templates/01/'),
    file.storagePath.replace('templates/1/', 'templates/0/'),
    file.storagePath.replace('templates/1/', 'templates/9007199254740992/'),
    file.storagePath.replace('templates/1/', 'templates/.backup-1-uuid/'),
    file.storagePath.replace('/folders/', '/other/'), file.storagePath.replace('SKILL.md', 'other.md'),
    file.storagePath + '/', file.storagePath.replace('/skills/', '/skills/../'),
    'templates/1/versions/../folders/skills/SKILL.md',
    'templates/1/versions/.upload-version/folders/skills/SKILL.md', null, '',
  ]) assert.throws(() => store.readFile({ ...file, storagePath }), /路径无效|storagePath 无效|templateId 必须为正整数/);
  for (const invalid of [
    { ...file, sha256: '../outside' }, { ...file, sha256: file.sha256.toUpperCase() },
    { ...file, size: -1 }, { ...file, size: 1.5 }, { ...file, size: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => store.readFile(invalid), /资源信息无效/);
  for (const invalidFolder of [
    { ...uploadedFolder(), name: '../outside' }, { name: 'valid', directories: ['../escape'], files: [] },
    { name: 'valid', directories: [], files: [uploadedFile('../escape', 'bad')] },
  ]) assert.throws(() => save(store, [invalidFolder]), /路径无效/);
});

test('missing or tampered files cannot be copied and failed validation leaves all current files intact', (t) => {
  const { rootPath, store } = fixture(t);
  const saved = save(store, [uploadedFolder('one', 'secret')]);
  const file = saved[0].files[0];
  const target = path.join(rootPath, file.storagePath);
  fs.writeFileSync(target, 'edited');
  assert.throws(() => store.readFile(file), /SHA256 校验失败/);
  assert.throws(() => save(store, saved, { trusted: true }), /SHA256 校验失败/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'edited');
  fs.writeFileSync(target, 'different length');
  assert.throws(() => store.readFile(file), /大小校验失败/);
  fs.unlinkSync(target);
  assert.throws(() => store.readFile(file), /资源不存在/);
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});

test('symbolic links are rejected from the root through each current file and old object fallback', (t) => {
  for (const level of ['root', 'templates', 'template', 'folders', 'folder', 'file']) {
    const { temporaryRoot, rootPath, store } = fixture(t);
    const saved = save(store, [uploadedFolder()]);
    const file = saved[0].files[0];
    const target = path.join(rootPath, file.storagePath);
    const replacedPath = {
      root: rootPath, templates: path.join(rootPath, 'templates'), template: currentPath(rootPath),
      folders: path.join(currentPath(rootPath), 'folders'), folder: path.dirname(target), file: target,
    }[level];
    const outside = path.join(temporaryRoot, 'outside');
    fs.renameSync(replacedPath, outside);
    fs.symlinkSync(outside, replacedPath, level === 'file' ? 'file' : 'dir');
    assert.throws(() => store.readFile(file), /不是普通目录|不是普通文件/, level);
    assert.throws(() => save(store, saved, { trusted: true }), /不是普通目录|不是普通文件/, level);
    if (level === 'root') {
      const trailingSlashStore = createAgentTemplateFolderAssetStore({ rootPath: rootPath + path.sep });
      assert.throws(() => trailingSlashStore.readFile(file), /不是普通目录/);
    }
  }
  for (const level of ['objects', 'shard', 'file']) {
    const { temporaryRoot, rootPath, store } = fixture(t);
    const legacy = legacyFile(rootPath);
    const replacedPath = { objects: path.join(rootPath, 'objects'), shard: path.dirname(legacy.target), file: legacy.target }[level];
    const outside = path.join(temporaryRoot, 'outside');
    fs.renameSync(replacedPath, outside);
    fs.symlinkSync(outside, replacedPath, level === 'file' ? 'file' : 'dir');
    assert.throws(() => store.readFile(legacy.file), /不是普通目录|不是普通文件/);
  }
});

test('failed publication restores the original directory and cleans only its own staging and backup', (t) => {
  const { rootPath, store } = fixture(t);
  const saved = save(store, [uploadedFolder()]);
  const originalRename = fs.renameSync;
  let stagedFilesWereComplete = false;
  fs.renameSync = (source, target) => {
    if (path.basename(source).startsWith('.upload-')) {
      stagedFilesWereComplete = fs.readFileSync(path.join(source, 'folders/new/SKILL.md'), 'utf8') === 'new content'
        && JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8')).templateId === 1;
      throw Object.assign(new Error('simulated publication failure'), { code: 'EIO' });
    }
    return originalRename(source, target);
  };
  try {
    assert.throws(() => save(store, [uploadedFolder('new', 'new content')]), /publication failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(stagedFilesWereComplete, true);
  assert.equal(store.readFile(saved[0].files[0]).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});

test('commit cleanup can be retried and never restores files after the database has committed', (t) => {
  const { rootPath, store } = fixture(t);
  save(store, [uploadedFolder()]);
  const update = store.beginUpdate([uploadedFolder('new', 'new bytes')], { templateId: 1 });
  const originalRemove = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (path.basename(target).startsWith('.backup-')) {
      throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
    }
    return originalRemove(target, options);
  };
  try {
    assert.throws(() => update.commit(), /cleanup failure/);
    update.rollback();
    assert.equal(store.readFile(update.folders[0].files[0]).toString(), 'new bytes');
  } finally {
    fs.rmSync = originalRemove;
  }
  update.commit();
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});

test('directory durability failures preserve the current template while unsupported directory fsync is tolerated', (t) => {
  const { rootPath, store } = fixture(t);
  const originalFsync = fs.fsyncSync;
  let directoryError = 'ENOTSUP';
  let saved;
  fs.fsyncSync = (handle) => {
    if (fs.fstatSync(handle).isDirectory()) {
      throw Object.assign(new Error('simulated directory fsync failure'), { code: directoryError });
    }
    return originalFsync(handle);
  };
  try {
    saved = save(store, [uploadedFolder()]);
    directoryError = 'EIO';
    assert.throws(() => save(store, [uploadedFolder('new', 'changed')]), /directory fsync failure/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(store.readFile(saved[0].files[0]).toString(), 'Example skill');
  assert.deepEqual(fs.readdirSync(path.join(rootPath, 'templates')), ['1']);
});
