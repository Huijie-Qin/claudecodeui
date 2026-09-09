import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const ROOT_SETTING = 'CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function validateRoot(rootPath, label = ROOT_SETTING) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    throw new Error(`${label} must be an absolute path`);
  }
  // Resolve also strips trailing separators, which otherwise let lstat follow a root symlink.
  const normalized = path.resolve(rootPath);
  if (normalized === path.parse(normalized).root) {
    throw new Error(`${label} must not be the filesystem root`);
  }
  return normalized;
}

export function resolveAgentTemplateAssetsRoot(env = process.env) {
  const configuredRoot = String(env[ROOT_SETTING] || '').trim();
  if (configuredRoot) return validateRoot(configuredRoot);
  const dataRoot = String(env.CLOUDCLI_DATA_ROOT || '').trim();
  if (dataRoot && path.isAbsolute(dataRoot)) return path.join(dataRoot, 'agent-template-assets');
  const databasePath = String(env.DATABASE_PATH || '').trim();
  if (databasePath && path.isAbsolute(databasePath)) {
    return path.join(path.dirname(databasePath), 'agent-template-assets');
  }
  return path.join(APP_ROOT, 'data', 'agent-template-assets');
}

function assetError(message, statusCode = 500) {
  return Object.assign(new Error(message), { statusCode });
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateRelativePath(value, { singleSegment = false, maxLength = 2048 } = {}) {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw assetError('模板文件资源路径无效', 400);
  }
  const segments = value.split('/');
  if ((singleSegment && segments.length !== 1) || segments.some((segment) => (
    !segment || segment === '.' || segment === '..'
    || /[\x00-\x1f\x7f\\:*?"<>|]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    || Buffer.byteLength(segment, 'utf8') > 255
  ))) {
    throw assetError('模板文件资源路径无效', 400);
  }
  return segments;
}

function validateTemplateId(templateId) {
  if (!Number.isSafeInteger(templateId) || templateId <= 0) {
    throw assetError('模板文件资源 templateId 必须为正整数', 400);
  }
  return templateId;
}

function parseStoragePath(storagePath, filePath) {
  const segments = validateRelativePath(storagePath, { maxLength: 4096 });
  const currentPath = segments.length >= 5 && segments[2] === 'folders'
    && segments.slice(4).join('/') === filePath;
  const legacyVersionPath = segments.length >= 7 && segments[2] === 'versions'
    && VERSION_PATTERN.test(segments[3]) && segments[4] === 'folders'
    && segments.slice(6).join('/') === filePath;
  if (segments[0] !== 'templates' || !/^[1-9][0-9]*$/.test(segments[1])
    || (!currentPath && !legacyVersionPath)) {
    throw assetError('模板文件资源 storagePath 无效', 400);
  }
  validateTemplateId(Number(segments[1]));
  return { segments };
}

function validateMetadata(file) {
  if (!file || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)
    || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw assetError('模板文件资源信息无效', 400);
  }
  validateRelativePath(file.path);
  if (Object.hasOwn(file, 'storagePath')) parseStoragePath(file.storagePath, file.path);
  return {
    path: file.path, size: file.size, sha256: file.sha256,
    ...(Object.hasOwn(file, 'storagePath') ? { storagePath: file.storagePath } : {}),
  };
}

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(target, { create = false, recursive = false } = {}) {
  if (create && !lstatIfPresent(target)) {
    try {
      fs.mkdirSync(target, { recursive, mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stats = lstatIfPresent(target);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw assetError('模板文件资源目录不存在或不是普通目录');
  }
}

function referenceKey(folderName, file) {
  return JSON.stringify([folderName, file.path, file.sha256, file.size, file.storagePath ?? null]);
}

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function syncDirectory(directory) {
  let handle;
  try {
    handle = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0));
    fs.fsyncSync(handle);
  } catch (error) {
    // Some filesystems and Windows cannot fsync directory handles. Real I/O errors still abort.
    const unsupported = ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)
      || (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EBADF'].includes(error.code));
    if (!unsupported) throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function writeDurableFile(target, bytes) {
  const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

/** Each template owns one current directory of ordinary files, with reversible updates for the database. */
export function createAgentTemplateFolderAssetStore({ rootPath } = {}) {
  // Resolve the default only on use, after server environment configuration has loaded.
  let resolvedRoot = rootPath === undefined ? undefined : validateRoot(rootPath, 'rootPath');
  const getRoot = () => (resolvedRoot ??= resolveAgentTemplateAssetsRoot());

  function directoryPath(segments, create = false) {
    const root = getRoot();
    assertDirectory(root, { create, recursive: true });
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      assertDirectory(current, { create });
    }
    return current;
  }

  function readRegularFile(segments, expectedSize) {
    const directory = directoryPath(segments.slice(0, -1));
    const target = path.join(directory, segments.at(-1));
    const stats = lstatIfPresent(target);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw assetError('模板文件资源不存在或不是普通文件');
    }
    const handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0));
    try {
      const openedStats = fs.fstatSync(handle);
      if (!openedStats.isFile() || (expectedSize !== undefined && openedStats.size !== expectedSize)) {
        throw assetError('模板文件资源大小校验失败');
      }
      return fs.readFileSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  function readFile(fileMetadata) {
    const file = validateMetadata(fileMetadata);
    // Legacy version directories and content-addressed objects are only read during migration.
    const segments = file.storagePath
      ? parseStoragePath(file.storagePath, file.path).segments
      : ['objects', file.sha256.slice(0, 2), file.sha256];
    const bytes = readRegularFile(segments, file.size);
    if (bytes.length !== file.size || hashBytes(bytes) !== file.sha256) {
      throw assetError('模板文件资源 SHA256 校验失败');
    }
    return bytes;
  }

  function canonicalFolders(folders) {
    return folders.map((folder) => ({
      name: folder.name,
      directories: [...(folder.directories || [])].sort(),
      files: folder.files.map(validateMetadata).sort(comparePaths),
    }));
  }

  function isCurrentTemplate(folders, { templateId } = {}) {
    try {
      validateTemplateId(templateId);
      if (!Array.isArray(folders) || folders.some((folder) => !Array.isArray(folder.files) || folder.files.length > 0)) {
        return false;
      }
      const currentSegments = ['templates', String(templateId)];
      const manifest = JSON.parse(readRegularFile([...currentSegments, 'manifest.json']).toString('utf8'));
      if (manifest.templateId !== templateId
        || JSON.stringify(canonicalFolders(manifest.folders)) !== JSON.stringify(canonicalFolders(folders))) {
        return false;
      }
      for (const folder of folders) {
        const folderSegments = [...currentSegments, 'folders', ...validateRelativePath(folder.name, { singleSegment: true })];
        directoryPath(folderSegments);
        for (const directory of folder.directories || []) {
          directoryPath([...folderSegments, ...validateRelativePath(directory)]);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function beginUpdate(folders, {
    templateId, templateName = '', existingFolders = [], trusted = false,
  } = {}) {
    if (!Array.isArray(folders)) throw assetError('模板文件夹必须为数组', 400);
    validateTemplateId(templateId);
    const allowedReferences = new Set(existingFolders.flatMap((folder) => (
      folder.files.filter((file) => SHA256_PATTERN.test(file.sha256 ?? ''))
        .map((file) => referenceKey(folder.name, file))
    )));
    // Authorize all references and validate paths before reading or writing any uploaded bytes.
    for (const folder of folders) {
      validateRelativePath(folder.name, { singleSegment: true });
      for (const directory of folder.directories || []) validateRelativePath(directory);
      for (const file of folder.files) {
        validateRelativePath(file.path);
        if (!Object.hasOwn(file, 'contentBase64')) {
          validateMetadata(file);
          if (!trusted && !allowedReferences.has(referenceKey(folder.name, file))) {
            throw assetError('模板文件资源引用无效，请重新上传文件夹', 400);
          }
        }
      }
    }
    // Read all current or legacy sources before replacing the template directory.
    const prepared = folders.map((folder) => ({ ...folder, files: folder.files.map((file) => {
      let bytes;
      if (Object.hasOwn(file, 'contentBase64')) {
        const content = file.contentBase64;
        if (typeof content !== 'string') throw assetError('模板文件内容编码无效', 400);
        bytes = Buffer.from(content, 'base64');
        if (bytes.toString('base64') !== content) throw assetError('模板文件内容编码无效', 400);
      } else {
        bytes = readFile(file);
      }
      return { path: file.path, bytes, size: bytes.length, sha256: hashBytes(bytes) };
    }) }));

    const templateSegments = ['templates', String(templateId)];
    const templatesDirectory = directoryPath(['templates'], true);
    const updateId = randomUUID();
    const temporary = path.join(templatesDirectory, `.upload-${templateId}-${updateId}`);
    const backup = path.join(templatesDirectory, `.backup-${templateId}-${updateId}`);
    const destination = path.join(templatesDirectory, String(templateId));
    if (lstatIfPresent(destination)) assertDirectory(destination);
    let temporaryCreated = false;
    let backupCreated = false;
    let replacementActive = false;
    let state = 'pending';
    const rollback = () => {
      if (state !== 'pending') return;
      if (replacementActive) {
        assertDirectory(destination);
        // Restore the previous directory before attempting deletion of the rejected contents.
        fs.renameSync(destination, temporary);
        replacementActive = false;
        temporaryCreated = true;
      }
      if (backupCreated) {
        fs.renameSync(backup, destination);
        backupCreated = false;
      }
      if (temporaryCreated) {
        fs.rmSync(temporary, { recursive: true, force: true });
        temporaryCreated = false;
      }
      state = 'rolledBack';
      syncDirectory(templatesDirectory);
    };
    const commit = () => {
      if (state === 'rolledBack') return;
      // Once the database commits, a cleanup failure must never restore old file contents.
      state = 'committed';
      if (backupCreated) {
        fs.rmSync(backup, { recursive: true });
        backupCreated = false;
      }
      syncDirectory(templatesDirectory);
    };
    try {
      fs.mkdirSync(temporary, { mode: 0o700 });
      temporaryCreated = true;
      const directoriesToSync = new Set([temporary]);
      const createDirectories = (segments) => {
        let target = temporary;
        for (const segment of segments) {
          target = path.join(target, segment);
          assertDirectory(target, { create: true });
          directoriesToSync.add(target);
        }
        return target;
      };
      createDirectories(['folders']);
      const metadata = canonicalFolders(prepared.map((folder) => {
        const folderSegments = ['folders', folder.name];
        createDirectories(folderSegments);
        for (const directory of folder.directories || []) {
          createDirectories([...folderSegments, ...validateRelativePath(directory)]);
        }
        const files = folder.files.map((file) => {
          const relativeSegments = [...folderSegments, ...validateRelativePath(file.path)];
          const parent = createDirectories(relativeSegments.slice(0, -1));
          writeDurableFile(path.join(parent, relativeSegments.at(-1)), file.bytes);
          return {
            path: file.path, size: file.size, sha256: file.sha256,
            storagePath: [...templateSegments, ...relativeSegments].join('/'),
          };
        });
        return { name: folder.name, directories: folder.directories || [], files };
      }));
      writeDurableFile(path.join(temporary, 'manifest.json'), Buffer.from(`${JSON.stringify({
        templateId, templateName: String(templateName), folders: metadata,
      }, null, 2)}\n`));
      for (const directory of [...directoriesToSync].reverse()) syncDirectory(directory);
      if (lstatIfPresent(destination)) {
        assertDirectory(destination);
        fs.renameSync(destination, backup);
        backupCreated = true;
      }
      fs.renameSync(temporary, destination);
      temporaryCreated = false;
      replacementActive = true;
      // The database update can now refer to the complete current directory, with rollback available.
      for (let directory = templatesDirectory; ; directory = path.dirname(directory)) {
        syncDirectory(directory);
        if (directory === getRoot()) break;
      }
      return { folders: metadata, commit, rollback };
    } catch (error) {
      try {
        rollback();
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${error.message}; 模板文件恢复失败：${restoreError.message}`);
      }
      throw error;
    }
  }

  function persistFolders(folders, options = {}) {
    const update = beginUpdate(folders, options);
    update.commit();
    return update.folders;
  }

  return { beginUpdate, persistFolders, readFile, isCurrentTemplate };
}

// Importing the service creates no directories and does not read any objects.
export const agentTemplateFolderAssetStore = createAgentTemplateFolderAssetStore();
