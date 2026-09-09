import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MAX_TEMPLATE_FOLDER_BYTES,
  MAX_TEMPLATE_FOLDERS,
  MAX_TEMPLATE_FOLDER_ENTRIES,
  MAX_TEMPLATE_FOLDER_DEPTH,
} from '../../shared/agentTemplateFolders.js';

function folderError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function pathKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function validateRelativePath(value, { root = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048) {
    throw folderError('文件夹中的路径不能为空或超过 2048 个字符');
  }
  const segments = value.split('/');
  if (segments.length > (root ? 1 : MAX_TEMPLATE_FOLDER_DEPTH)) {
    throw folderError(root ? '文件夹名称不能包含路径' : `文件夹层级不能超过 ${MAX_TEMPLATE_FOLDER_DEPTH} 层`);
  }
  // Reject Windows aliases as well: templates may be applied on a different OS.
  if (segments.some((segment) => (
    !segment || segment === '.' || segment === '..'
    || /[\x00-\x1f\x7f\\:*?"<>|]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    || Buffer.byteLength(segment, 'utf8') > 255
  ))) {
    throw folderError(`文件夹路径无效：${value}`);
  }
  return value;
}

/** Validate the whole batch before saving or touching the workspace filesystem. */
export function normalizeTemplateFolders(value = []) {
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_FOLDERS) {
    throw folderError(`高级配置最多支持 ${MAX_TEMPLATE_FOLDERS} 个文件夹`);
  }
  const roots = new Set();
  let totalBytes = 0;
  let totalEntries = 0;
  return value.map((folder) => {
    const name = validateRelativePath(folder?.name, { root: true });
    const rootKey = pathKey(name);
    if (roots.has(rootKey)) throw folderError(`文件夹名称重复：${name}`);
    roots.add(rootKey);
    if (!Array.isArray(folder.files) || !Array.isArray(folder.directories ?? [])) {
      throw folderError(`文件夹 ${name} 的文件和目录必须是数组`);
    }
    // Limit before iterating, including duplicate entries submitted by an API caller.
    if (folder.files.length + (folder.directories?.length || 0) > MAX_TEMPLATE_FOLDER_ENTRIES) {
      throw folderError(`文件和子目录总数不能超过 ${MAX_TEMPLATE_FOLDER_ENTRIES}`);
    }
    const entries = new Map();
    const addEntry = (entryPath, type, explicit = false) => {
      const key = pathKey(entryPath);
      const existing = entries.get(key);
      if (existing) {
        if (existing.type !== type || existing.path !== entryPath || type === 'file' || (explicit && existing.explicit)) {
          throw folderError(`文件夹中存在重名或冲突路径：${name}/${entryPath}`);
        }
        existing.explicit ||= explicit;
        return;
      }
      totalEntries += 1;
      if (totalEntries > MAX_TEMPLATE_FOLDER_ENTRIES) {
        throw folderError(`文件和子目录总数不能超过 ${MAX_TEMPLATE_FOLDER_ENTRIES}`);
      }
      entries.set(key, { path: entryPath, type, explicit });
    };
    const addParents = (entryPath) => {
      const parts = entryPath.split('/');
      for (let index = 1; index < parts.length; index += 1) {
        addEntry(parts.slice(0, index).join('/'), 'directory');
      }
    };
    for (const directory of folder.directories || []) {
      validateRelativePath(directory);
      addParents(directory);
      addEntry(directory, 'directory', true);
    }
    const files = folder.files.map((file) => {
      const filePath = validateRelativePath(file?.path);
      addParents(filePath);
      addEntry(filePath, 'file', true);
      const content = file.contentBase64;
      if (typeof content !== 'string' || content.length > Math.ceil(MAX_TEMPLATE_FOLDER_BYTES / 3) * 4) {
        throw folderError(`文件夹总大小不能超过 ${MAX_TEMPLATE_FOLDER_BYTES / 1024 / 1024} MiB`);
      }
      if (content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content)) {
        throw folderError(`文件内容编码无效：${name}/${filePath}`);
      }
      const bytes = Buffer.from(content, 'base64');
      if (bytes.toString('base64') !== content) {
        throw folderError(`文件内容编码无效：${name}/${filePath}`);
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TEMPLATE_FOLDER_BYTES) {
        throw folderError(`文件夹总大小不能超过 ${MAX_TEMPLATE_FOLDER_BYTES / 1024 / 1024} MiB`);
      }
      return { path: filePath, contentBase64: content };
    });
    const directories = [...entries.values()]
      .filter((entry) => entry.type === 'directory')
      .map((entry) => entry.path)
      .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
    return { name, directories, files };
  });
}

async function lstatIfPresent(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(stats, relativePath) {
  if (stats && (stats.isSymbolicLink() || !stats.isDirectory())) {
    throw folderError(`无法创建模板文件夹，目标不是普通目录：${relativePath}`, 409);
  }
}

/** Merge folders without replacing existing files or traversing symbolic links. */
export async function writeWorkspaceTemplateFolders(workspacePath, value) {
  const folders = normalizeTemplateFolders(value);
  if (folders.length === 0) return [];
  const workspaceRoot = await fs.realpath(workspacePath);
  assertDirectory(await fs.lstat(workspaceRoot), '工作空间');
  const directories = ['.claude'];
  const files = [];
  for (const folder of folders) {
    const root = `.claude/${folder.name}`;
    directories.push(root, ...folder.directories.map((directory) => `${root}/${directory}`));
    files.push(...folder.files.map((file) => ({
      relativePath: `${root}/${file.path}`,
      content: Buffer.from(file.contentBase64, 'base64'),
    })));
  }

  // Preflight the entire batch so a conflict in a later folder leaves no earlier files.
  for (const directory of directories) {
    assertDirectory(await lstatIfPresent(path.join(workspaceRoot, directory)), directory);
  }
  for (const file of files) {
    if (await lstatIfPresent(path.join(workspaceRoot, file.relativePath))) {
      throw folderError(`模板文件已存在，请先处理同名文件：${file.relativePath}`, 409);
    }
  }

  const createdDirectories = [];
  const createdFiles = [];
  try {
    for (const directory of directories) {
      const target = path.join(workspaceRoot, directory);
      try {
        await fs.mkdir(target);
        createdDirectories.push(target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        assertDirectory(await fs.lstat(target), directory);
      }
    }
    for (const file of files) {
      const target = path.join(workspaceRoot, file.relativePath);
      const handle = await fs.open(target, 'wx');
      createdFiles.push(target);
      try {
        await handle.writeFile(file.content);
      } finally {
        await handle.close();
      }
    }
    return folders.map((folder) => ({ name: folder.name, path: `.claude/${folder.name}` }));
  } catch (error) {
    await Promise.all(createdFiles.map((target) => fs.unlink(target).catch(() => {})));
    for (const directory of createdDirectories.reverse()) {
      // Only remove directories this operation created, and only while still empty.
      await fs.rmdir(directory).catch(() => {});
    }
    throw error;
  }
}
