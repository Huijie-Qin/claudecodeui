import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const ROOT_SETTING = 'CLOUDCLI_AGENT_TEMPLATE_ASSETS_ROOT';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function validateMetadata(file) {
  if (!file || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256)
    || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw assetError('模板文件资源信息无效', 400);
  }
  return { path: file.path, size: file.size, sha256: file.sha256 };
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
  return JSON.stringify([folderName, file.path, file.sha256, file.size]);
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

/** Content-addressed objects are retained while templates or workspace snapshots may reference them. */
export function createAgentTemplateFolderAssetStore({ rootPath } = {}) {
  // Resolve the default only on use, after server environment configuration has loaded.
  let resolvedRoot = rootPath === undefined ? undefined : validateRoot(rootPath, 'rootPath');
  const getRoot = () => (resolvedRoot ??= resolveAgentTemplateAssetsRoot());

  function objectPath(sha256, create = false) {
    const root = getRoot();
    assertDirectory(root, { create, recursive: true });
    const objects = path.join(root, 'objects');
    assertDirectory(objects, { create });
    const shard = path.join(objects, sha256.slice(0, 2));
    assertDirectory(shard, { create });
    return path.join(shard, sha256);
  }

  function readFile(fileMetadata) {
    const file = validateMetadata(fileMetadata);
    const target = objectPath(file.sha256);
    const stats = lstatIfPresent(target);
    if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
      throw assetError('模板文件资源不存在或不是普通文件');
    }
    const handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0));
    try {
      const openedStats = fs.fstatSync(handle);
      if (!openedStats.isFile() || openedStats.size !== file.size) {
        throw assetError('模板文件资源大小校验失败');
      }
      const bytes = fs.readFileSync(handle);
      if (bytes.length !== file.size || hashBytes(bytes) !== file.sha256) {
        throw assetError('模板文件资源 SHA256 校验失败');
      }
      return bytes;
    } finally {
      fs.closeSync(handle);
    }
  }

  function persistFile(file) {
    const content = file.contentBase64;
    if (typeof content !== 'string') throw assetError('模板文件内容编码无效', 400);
    const bytes = Buffer.from(content, 'base64');
    if (bytes.toString('base64') !== content) throw assetError('模板文件内容编码无效', 400);
    const metadata = { path: file.path, size: bytes.length, sha256: hashBytes(bytes) };
    const target = objectPath(metadata.sha256, true);
    if (lstatIfPresent(target)) {
      readFile(metadata);
      return metadata;
    }

    const temporary = path.join(path.dirname(target), `.upload-${randomUUID()}`);
    let handle;
    try {
      handle = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
        | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.writeFileSync(handle, bytes);
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      // Hard-link publication is atomic and exclusive: unlike rename, it cannot replace an object.
      try {
        fs.linkSync(temporary, target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      readFile(metadata);
      syncDirectory(path.dirname(target));
      return metadata;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  function persistFolders(folders, { existingFolders = [], trusted = false } = {}) {
    const allowedReferences = new Set(existingFolders.flatMap((folder) => (
      folder.files.filter((file) => SHA256_PATTERN.test(file.sha256 ?? ''))
        .map((file) => referenceKey(folder.name, file))
    )));
    // Authorize all references before writing any new bytes. A known hash alone grants no access.
    for (const folder of folders) {
      for (const file of folder.files) {
        if (!Object.hasOwn(file, 'contentBase64')) {
          validateMetadata(file);
          if (!trusted && !allowedReferences.has(referenceKey(folder.name, file))) {
            throw assetError('模板文件资源引用无效，请重新上传文件夹', 400);
          }
        }
      }
    }
    return folders.map((folder) => {
      const files = folder.files.map((file) => {
        if (Object.hasOwn(file, 'contentBase64')) return persistFile(file);
        const metadata = validateMetadata(file);
        readFile(metadata);
        return metadata;
      }).sort(comparePaths);
      const manifest = { name: folder.name, directories: [...(folder.directories || [])].sort(), files };
      return { ...manifest, version: hashBytes(JSON.stringify(manifest)) };
    });
  }

  return { persistFolders, readFile };
}

// Importing the service creates no directories and does not read any objects.
export const agentTemplateFolderAssetStore = createAgentTemplateFolderAssetStore();
