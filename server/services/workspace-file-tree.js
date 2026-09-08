import { promises as fs } from 'fs';
import path from 'path';

import { shouldHideWorkspaceInternalEntry } from './workspace-file-visibility.js';

const DIRECTORY_CONCURRENCY = 4;
const ENTRY_STAT_CONCURRENCY = 16;

function createAbortError() {
  const error = new Error('Workspace file tree scan was aborted');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function permToRwx(perm) {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

function sortTreeItems(items) {
  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

async function addMetadata(item, signal) {
  assertNotAborted(signal);

  try {
    // lstat avoids following symlinks to slow or unavailable mount targets.
    const stats = await fs.lstat(item.path);
    item.size = stats.size;
    item.modified = stats.mtime.toISOString();

    const mode = stats.mode;
    const ownerPerm = (mode >> 6) & 7;
    const groupPerm = (mode >> 3) & 7;
    const otherPerm = mode & 7;
    item.permissions = `${ownerPerm}${groupPerm}${otherPerm}`;
    item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    item.size = 0;
    item.modified = null;
    item.permissions = '000';
    item.permissionsRwx = '---------';
  }
}

export async function getFileTree(
  dirPath,
  maxDepth = 3,
  currentDepth = 0,
  showInternalConfigFiles = false,
  { signal } = {},
) {
  const rootItems = [];
  const pendingDirectories = [{ dirPath, depth: currentDepth, items: rootItems }];
  let directoryCursor = 0;

  const processDirectory = async ({ dirPath: currentPath, depth, items }) => {
    assertNotAborted(signal);

    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.code !== 'EACCES' && error?.code !== 'EPERM' && error?.code !== 'ENOENT') {
        console.error('Error reading directory:', error);
      }
      return;
    }

    const visibleEntries = entries.filter((entry) => !shouldHideWorkspaceInternalEntry({
      name: entry.name,
      currentDepth: depth,
      showInternalConfigFiles,
    }));

    for (let cursor = 0; cursor < visibleEntries.length; cursor += ENTRY_STAT_CONCURRENCY) {
      assertNotAborted(signal);
      const batch = visibleEntries.slice(cursor, cursor + ENTRY_STAT_CONCURRENCY);
      const batchItems = batch.map((entry) => ({
        entry,
        item: {
          name: entry.name,
          path: path.join(currentPath, entry.name),
          type: entry.isDirectory() ? 'directory' : 'file',
        },
      }));

      await Promise.all(batchItems.map(({ item }) => addMetadata(item, signal)));

      for (const { entry, item } of batchItems) {
        if (entry.isDirectory() && depth < maxDepth) {
          item.children = [];
          pendingDirectories.push({
            dirPath: item.path,
            depth: depth + 1,
            items: item.children,
          });
        }
        items.push(item);
      }
    }

    sortTreeItems(items);
  };

  // Keep filesystem pressure bounded across the whole traversal. A recursive
  // Promise.all can otherwise flood libuv's thread pool and starve unrelated
  // API requests when a workspace contains a large dependency directory.
  while (directoryCursor < pendingDirectories.length) {
    assertNotAborted(signal);
    const batch = pendingDirectories.slice(directoryCursor, directoryCursor + DIRECTORY_CONCURRENCY);
    directoryCursor += batch.length;
    await Promise.all(batch.map(processDirectory));
  }

  return rootItems;
}
