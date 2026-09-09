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

function objectPath(rootPath, file) {
  return path.join(rootPath, 'objects', file.sha256.slice(0, 2), file.sha256);
}

test('asset root follows explicit override, data root, database directory, and application defaults', () => {
  assert.equal(resolveAgentTemplateAssetsRoot({
    CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: ' /srv/cloudcli/custom/../assets ',
    CLOUDCLI_DATA_ROOT: '/srv/cloudcli/data',
    DATABASE_PATH: '/srv/cloudcli/database/auth.db',
  }), '/srv/cloudcli/assets');
  assert.equal(resolveAgentTemplateAssetsRoot({
    CLOUDCLI_DATA_ROOT: '/srv/cloudcli/data',
    DATABASE_PATH: '/srv/cloudcli/database/auth.db',
  }), '/srv/cloudcli/data/agent-template-assets');
  assert.equal(resolveAgentTemplateAssetsRoot({ DATABASE_PATH: '/srv/cloudcli/database/auth.db' }),
    '/srv/cloudcli/database/agent-template-assets');
  const defaultRoot = path.join(findAppRoot(getModuleDir(import.meta.url)), 'data', 'agent-template-assets');
  assert.equal(resolveAgentTemplateAssetsRoot({}), defaultRoot);
  assert.equal(resolveAgentTemplateAssetsRoot({ CLOUDCLI_DATA_ROOT: './data', DATABASE_PATH: './auth.db' }),
    defaultRoot);
  for (const root of ['./assets', '/', '/somewhere/..', '/tmp/\0unsafe']) {
    assert.throws(() => resolveAgentTemplateAssetsRoot({ CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT: root }),
      /must be an absolute path|must not be the filesystem root/);
    assert.throws(() => createAgentTemplateFolderAssetStore({ rootPath: root }),
      /must be an absolute path|must not be the filesystem root/);
  }
});

test('creating a store and persisting empty folders do not touch the filesystem', (t) => {
  const { rootPath, store } = fixture(t);
  assert.equal(fs.existsSync(rootPath), false);
  const [empty] = store.persistFolders([{ name: 'empty', directories: ['nested'], files: [] }]);
  assert.match(empty.version, /^[a-f0-9]{64}$/);
  assert.deepEqual(empty.directories, ['nested']);
  assert.equal(fs.existsSync(rootPath), false);
});

test('binary uploads are raw bytes on disk, deduplicated across folders and repeated saves', (t) => {
  const { rootPath, store } = fixture(t);
  const binary = Buffer.from([0, 255, 128, 1, 2, 10, 0, 127]);
  const saved = store.persistFolders([
    { name: 'one', directories: ['empty'], files: [uploadedFile('asset.bin', binary)] },
    { name: 'two', directories: [], files: [uploadedFile('copy.bin', binary)] },
  ]);
  const firstFile = saved[0].files[0];
  assert.equal(firstFile.size, binary.length);
  assert.equal(firstFile.sha256, createHash('sha256').update(binary).digest('hex'));
  assert.equal(saved[1].files[0].sha256, firstFile.sha256);
  assert.equal(JSON.stringify(saved).includes('contentBase64'), false);
  const target = objectPath(rootPath, firstFile);
  assert.deepEqual(fs.readFileSync(target), binary);
  assert.deepEqual(store.readFile(firstFile), binary);
  const original = fs.statSync(target);
  store.persistFolders([uploadedFolder('again', binary)]);
  assert.equal(fs.statSync(target).ino, original.ino);
  assert.equal(fs.statSync(target).mtimeMs, original.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [firstFile.sha256]);
  assert.deepEqual(store.persistFolders(saved, { existingFolders: saved }), saved);
});

test('folder versions are stable under ordering changes and change with content or directory structure', (t) => {
  const { store } = fixture(t);
  const folder = {
    name: 'tools', directories: ['z', 'a', 'a/nested'],
    files: [uploadedFile('z/two.txt', 'two'), uploadedFile('a/one.txt', 'one')],
  };
  const [first] = store.persistFolders([folder]);
  const [reordered] = store.persistFolders([{
    ...folder, directories: [...folder.directories].reverse(), files: [...folder.files].reverse(),
  }]);
  assert.deepEqual(first, reordered);
  for (const updated of [
    { ...folder, name: 'renamed' },
    { ...folder, directories: [...folder.directories, 'empty'] },
    { ...folder, files: [uploadedFile('z/two.txt', 'updated'), folder.files[1]] },
  ]) {
    assert.notEqual(store.persistFolders([updated])[0].version, first.version);
  }
  assert.equal(store.persistFolders([first], { trusted: true })[0].version, first.version);
});

test('untrusted metadata must match a reference belonging to the existing template', (t) => {
  const { store } = fixture(t);
  const [saved] = store.persistFolders([uploadedFolder()]);
  const file = saved.files[0];
  assert.throws(() => store.persistFolders([saved]), /资源引用无效/);
  assert.throws(() => store.persistFolders([{ ...saved, name: 'other' }], { existingFolders: [saved] }),
    /资源引用无效/);
  assert.throws(() => store.persistFolders([{ ...saved, files: [{ ...file, path: 'other.md' }] }],
    { existingFolders: [saved] }), /资源引用无效/);
  assert.throws(() => store.persistFolders([{ ...saved, files: [{ ...file, size: file.size + 1 }] }],
    { existingFolders: [saved] }), /资源引用无效/);
  assert.deepEqual(store.persistFolders([saved], { trusted: true }), [saved]);
});

test('authorization is checked before writing other newly uploaded files', (t) => {
  const { rootPath, store } = fixture(t);
  assert.throws(() => store.persistFolders([
    uploadedFolder(),
    { name: 'stolen', directories: [], files: [{ path: 'a', size: 4, sha256: '0'.repeat(64) }] },
  ]), /资源引用无效/);
  assert.equal(fs.existsSync(rootPath), false);
});

test('missing, malformed and tampered objects cannot be read or retained even when trusted', (t) => {
  const { rootPath, store } = fixture(t);
  const [saved] = store.persistFolders([uploadedFolder('one', 'secret')]);
  const file = saved.files[0];
  for (const invalid of [
    { ...file, sha256: '../outside' }, { ...file, sha256: file.sha256.toUpperCase() },
    { ...file, size: -1 }, { ...file, size: 1.5 }, { ...file, size: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => store.readFile(invalid), /资源信息无效/);

  const target = objectPath(rootPath, file);
  fs.writeFileSync(target, 'edited');
  assert.throws(() => store.readFile(file), /SHA256 校验失败/);
  assert.throws(() => store.persistFolders([uploadedFolder('one', 'secret')]), /SHA256 校验失败/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'edited');
  fs.writeFileSync(target, 'different length');
  assert.throws(() => store.readFile(file), /大小校验失败/);
  fs.unlinkSync(target);
  assert.throws(() => store.readFile(file), /资源不存在/);
  assert.throws(() => store.persistFolders([saved], { trusted: true }), /资源不存在/);
});

test('symbolic links at the asset root, object directory, shard, and object are rejected', (t) => {
  for (const level of ['root', 'objects', 'shard', 'file']) {
    const { temporaryRoot, rootPath, store } = fixture(t);
    const [saved] = store.persistFolders([uploadedFolder()]);
    const file = saved.files[0];
    const target = objectPath(rootPath, file);
    const replacedPath = {
      root: rootPath, objects: path.join(rootPath, 'objects'), shard: path.dirname(target), file: target,
    }[level];
    const outside = path.join(temporaryRoot, 'outside');
    fs.renameSync(replacedPath, outside);
    fs.symlinkSync(outside, replacedPath, level === 'file' ? 'file' : 'dir');
    assert.throws(() => store.readFile(file), /不是普通目录|不是普通文件/, level);
    assert.throws(() => store.persistFolders([uploadedFolder()]), /不是普通目录|不是普通文件/, level);
    if (level === 'root') {
      const trailingSlashStore = createAgentTemplateFolderAssetStore({ rootPath: `${rootPath}${path.sep}` });
      assert.throws(() => trailingSlashStore.readFile(file), /不是普通目录/);
    }
  }
});

test('an object directory or directory component replaced by a regular file is rejected', (t) => {
  const { rootPath, store } = fixture(t);
  const [saved] = store.persistFolders([uploadedFolder()]);
  const target = objectPath(rootPath, saved.files[0]);
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  assert.throws(() => store.readFile(saved.files[0]), /不是普通文件/);
  fs.rmSync(path.join(rootPath, 'objects'), { recursive: true });
  fs.writeFileSync(path.join(rootPath, 'objects'), 'not a directory');
  assert.throws(() => store.persistFolders([uploadedFolder()]), /不是普通目录/);
});

test('failed object publication removes temporary files and preserves previously stored objects', (t) => {
  const { rootPath, store } = fixture(t);
  const [saved] = store.persistFolders([uploadedFolder()]);
  const originalLink = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('simulated publication failure'), { code: 'EIO' }); };
  try {
    assert.throws(() => store.persistFolders([uploadedFolder('new', 'new content')]), /publication failure/);
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(store.readFile(saved.files[0]).toString(), 'Example skill');
  const entries = fs.readdirSync(path.join(rootPath, 'objects'), { recursive: true });
  assert.equal(entries.some((entry) => entry.includes('.upload-')), false);
});

test('directory durability errors abort saving while unsupported directory fsync is tolerated', (t) => {
  const { rootPath, store } = fixture(t);
  const originalFsync = fs.fsyncSync;
  let directoryError = 'ENOTSUP';
  fs.fsyncSync = (handle) => {
    if (fs.fstatSync(handle).isDirectory()) {
      throw Object.assign(new Error('simulated directory fsync failure'), { code: directoryError });
    }
    return originalFsync(handle);
  };
  try {
    const [saved] = store.persistFolders([uploadedFolder()]);
    assert.equal(store.readFile(saved.files[0]).toString(), 'Example skill');
    directoryError = 'EIO';
    assert.throws(() => store.persistFolders([uploadedFolder('new', 'changed')]), /directory fsync failure/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  const entries = fs.readdirSync(path.join(rootPath, 'objects'), { recursive: true });
  assert.equal(entries.some((entry) => entry.includes('.upload-')), false);
});
