import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TEMPLATE_FOLDER_BYTES,
  MAX_TEMPLATE_FOLDER_DEPTH,
  MAX_TEMPLATE_FOLDER_ENTRIES,
  MAX_TEMPLATE_FOLDERS,
} from '../../../shared/agentTemplateFolders.js';

import {
  readTemplateFolderEntries,
  readTemplateFolderFiles,
  templateFolderBytes,
  type AgentTemplateFolder,
  type FolderUploadEntry,
} from './agentTemplateFolderUpload';

function uploadFile(path: string, bytes: Uint8Array | string = 'content') {
  const file = new File([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], path.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function fileEntry(file: File): FolderUploadEntry {
  return { name: file.name, isDirectory: false, isFile: true, file: (success) => success(file) };
}

function directory(name: string, batches: FolderUploadEntry[][] = []): FolderUploadEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let batchIndex = 0;
      return { readEntries: (success) => success(batches[batchIndex++] || []) };
    },
  };
}

const emptyFolder = (name: string): AgentTemplateFolder => ({ name, directories: [], files: [] });

test('folder picker groups several roots, keeps nested paths and round-trips binary bytes', async () => {
  const bytes = Uint8Array.from({ length: 70003 }, (_, index) => index % 256);
  const folders = await readTemplateFolderFiles([
    uploadFile('commands/nested/command.md', '# 中文命令'),
    uploadFile('assets/image.bin', bytes),
    uploadFile('commands/root.md', ''),
  ]);
  assert.deepEqual(folders.map((folder) => folder.name), ['commands', 'assets']);
  assert.deepEqual(folders[0].directories, ['nested']);
  assert.deepEqual(folders[0].files.map((file) => file.path), ['nested/command.md', 'root.md']);
  assert.equal(Buffer.from(folders[0].files[0].contentBase64, 'base64').toString(), '# 中文命令');
  assert.deepEqual(Buffer.from(folders[1].files[0].contentBase64, 'base64'), Buffer.from(bytes));
  assert.equal(templateFolderBytes(folders[1]), bytes.length);
  assert.equal(templateFolderBytes(folders[0]), new TextEncoder().encode('# 中文命令').length);
});

test('dragging multiple roots retains empty folders and reads every directory batch', async () => {
  const folders = await readTemplateFolderEntries([
    directory('empty-root'),
    directory('commands', [
      [directory('empty-child'), fileEntry(uploadFile('first.md'))],
      [directory('nested', [[fileEntry(uploadFile('last.bin', new Uint8Array([0, 255])))]])],
    ]),
  ]);
  assert.deepEqual(folders[0], emptyFolder('empty-root'));
  assert.deepEqual(folders[1].directories, ['empty-child', 'nested']);
  assert.deepEqual(folders[1].files.map((file) => file.path), ['first.md', 'nested/last.bin']);
  assert.equal(folders[1].files[1].contentBase64, 'AP8=');
});

test('new batches preserve the existing folders and reject duplicate root names', async () => {
  const existing = [emptyFolder('Commands')];
  const before = structuredClone(existing);
  const added = await readTemplateFolderEntries([directory('rules')], existing);
  assert.deepEqual(added, [emptyFolder('rules')]);
  await assert.rejects(readTemplateFolderFiles([uploadFile('commands/test.md')], existing), /已存在/);
  await assert.rejects(readTemplateFolderEntries([directory('é'), directory('e\u0301')]), /已存在/);
  assert.deepEqual(existing, before);
});

test('saved metadata counts toward size and survives appending uploads without loading file contents', async () => {
  const existing: AgentTemplateFolder[] = [{
    name: 'saved-rules',
    directories: ['empty'],
    files: [{
      path: 'rule.md', size: 1234, sha256: 'a'.repeat(64),
      storagePath: 'templates/3/folders/saved-rules/rule.md',
    }],
  }];
  const before = structuredClone(existing);
  const added = await readTemplateFolderFiles([uploadFile('new-rules/rule.md', 'new')], existing);
  const folders = [...existing, ...added];
  assert.equal(folders.reduce((total, folder) => total + templateFolderBytes(folder), 0), 1237);
  assert.deepEqual(existing, before);
  assert.deepEqual(JSON.parse(JSON.stringify(folders))[0], before[0]);
  assert.equal(folders[0].files[0].storagePath, before[0].files[0].storagePath);
  assert.equal(Object.prototype.hasOwnProperty.call(folders[0].files[0], 'contentBase64'), false);
  assert.equal(added[0].files[0].contentBase64, 'bmV3');
  assert.equal(Object.prototype.hasOwnProperty.call(added[0].files[0], 'storagePath'), false);
  assert.equal(templateFolderBytes({
    name: 'mixed', directories: [], files: [...existing[0].files, ...added[0].files],
  }), 1237);
});

test('rejects conflicting file names, file/directory paths and differently cased parents', async () => {
  await assert.rejects(readTemplateFolderFiles([
    uploadFile('commands/test.md'), uploadFile('commands/TEST.md'),
  ]), /冲突路径/);
  await assert.rejects(readTemplateFolderFiles([
    uploadFile('commands/nested'), uploadFile('commands/nested/test.md'),
  ]), /冲突路径/);
  await assert.rejects(readTemplateFolderFiles([
    uploadFile('commands/Nested/one.md'), uploadFile('commands/nested/two.md'),
  ]), /冲突路径/);
});

test('rejects individual files and unsafe relative paths before reading contents', async () => {
  await assert.rejects(readTemplateFolderEntries([fileEntry(uploadFile('test.md'))]), /请拖入文件夹/);
  await assert.rejects(readTemplateFolderFiles([uploadFile('test.md')]), /请选择文件夹/);
  for (const path of ['commands/../test.md', 'commands//test.md', 'commands/test\\name.md', 'commands/CON.txt', 'commands/file.']) {
    await assert.rejects(readTemplateFolderFiles([uploadFile(path)]), /名称不受支持/);
  }
});

test('enforces aggregate byte and root limits across existing and added folders before reading', async () => {
  const file = uploadFile('commands/test.bin');
  Object.defineProperty(file, 'size', { value: MAX_TEMPLATE_FOLDER_BYTES });
  Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('Must not read over-limit payload'); } });
  const existing = [{ name: 'rules', directories: [], files: [{ path: 'one.txt', contentBase64: 'YQ==' }] }];
  await assert.rejects(readTemplateFolderFiles([file], existing), /文件总大小不能超过/);
  const stored: AgentTemplateFolder[] = [{
    name: 'saved-rules', directories: [], files: [{
      path: 'one.txt', size: 1, sha256: 'a'.repeat(64),
      storagePath: 'templates/3/folders/saved-rules/one.txt',
    }],
  }];
  await assert.rejects(readTemplateFolderFiles([file], stored), /文件总大小不能超过/);
  const mixed = [...stored, ...existing];
  const mixedFile = uploadFile('commands/mixed.bin');
  Object.defineProperty(mixedFile, 'size', { value: MAX_TEMPLATE_FOLDER_BYTES - 1 });
  Object.defineProperty(mixedFile, 'arrayBuffer', { value: () => { throw new Error('Must not read over-limit payload'); } });
  await assert.rejects(readTemplateFolderFiles([mixedFile], mixed), /文件总大小不能超过/);
  const roots = Array.from({ length: MAX_TEMPLATE_FOLDERS }, (_, index) => emptyFolder(`folder-${index}`));
  await assert.rejects(readTemplateFolderEntries([directory('extra')], roots), /最多上传/);
});

test('counts inferred parent directories toward entry limits and supports the exact limit', async () => {
  const existing = [{
    name: 'rules',
    directories: Array.from({ length: MAX_TEMPLATE_FOLDER_ENTRIES - 2 }, (_, index) => `folder-${index}`),
    files: [],
  }];
  const added = await readTemplateFolderFiles([uploadFile('commands/nested/one.md')], existing);
  assert.deepEqual(added[0].directories, ['nested']);
  await assert.rejects(readTemplateFolderFiles([
    uploadFile('commands/nested/one.md'), uploadFile('commands/two.md'),
  ], existing), /文件和子文件夹合计不能超过/);
});

test('stops enumerating empty subdirectories when the entry limit is exceeded', async () => {
  const children = Array.from({ length: MAX_TEMPLATE_FOLDER_ENTRIES + 1 }, (_, index) => directory(`empty-${index}`));
  await assert.rejects(readTemplateFolderEntries([directory('commands', [children])]), /文件和子文件夹合计不能超过/);
});

test('enforces relative path depth while allowing the boundary depth', async () => {
  const segments = Array.from({ length: MAX_TEMPLATE_FOLDER_DEPTH - 1 }, (_, index) => `d${index}`);
  const valid = await readTemplateFolderFiles([uploadFile(`commands/${segments.join('/')}/file.txt`)]);
  assert.equal(valid[0].directories.length, MAX_TEMPLATE_FOLDER_DEPTH - 1);
  await assert.rejects(readTemplateFolderFiles([uploadFile(`commands/${segments.join('/')}/extra/file.txt`)]), /层级不能超过/);
});

test('surfaces directory and file permission failures without returning a partial batch', async () => {
  const unreadableDirectory = directory('private');
  unreadableDirectory.createReader = () => ({ readEntries: (_success, error) => error(new DOMException('denied')) });
  await assert.rejects(readTemplateFolderEntries([directory('valid'), unreadableDirectory]), /无法读取文件夹“private”/);
  const file = uploadFile('commands/private.bin');
  Object.defineProperty(file, 'arrayBuffer', { value: async () => { throw new Error('denied'); } });
  await assert.rejects(readTemplateFolderFiles([file]), /无法读取文件“commands\/private.bin”/);
});

test('cancels an in-flight file read so a departed editor never receives upload results', async () => {
  const controller = new AbortController();
  const file = uploadFile('commands/readme.md');
  let finishRead!: (value: ArrayBuffer) => void;
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) });
  const upload = readTemplateFolderFiles([file], [], controller.signal);
  controller.abort();
  finishRead(new ArrayBuffer(file.size));
  await assert.rejects(upload, { name: 'AbortError' });
});
