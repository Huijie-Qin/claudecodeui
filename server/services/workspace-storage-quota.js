import { promises as fs } from 'fs';
import path from 'path';

export const DEFAULT_WORKSPACE_SIZE_MB = 200;
export const WORKSPACE_SIZE_ENV_NAME = 'WORKSPACE_SIZE';
export const WORKSPACE_SIZE_ADMIN_ENV_NAME = 'workspace_size';
export const BYTES_PER_MB = 1024 * 1024;
export const DEFAULT_USAGE_SCAN_CONCURRENCY = 32;

function parseWorkspaceSizeMb(value, fallback = DEFAULT_WORKSPACE_SIZE_MB) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function resolveWorkspaceSizeMb({ workspace, userStore, env = process.env } = {}) {
  let adminValue;
  const ownerUserId = workspace?.owner_user_id ?? workspace?.ownerUserId;

  if (ownerUserId != null && typeof userStore?.getEnvForUser === 'function') {
    try {
      adminValue = userStore.getEnvForUser(ownerUserId)?.[WORKSPACE_SIZE_ADMIN_ENV_NAME];
    } catch {
      adminValue = undefined;
    }
  }

  if (adminValue !== undefined && adminValue !== null && String(adminValue).trim() !== '') {
    return parseWorkspaceSizeMb(adminValue);
  }

  return parseWorkspaceSizeMb(env?.[WORKSPACE_SIZE_ENV_NAME]);
}

export function workspaceSizeMbToBytes(sizeMb) {
  return Math.floor(Number(sizeMb) * BYTES_PER_MB);
}

function createAbortError() {
  const error = new Error('Workspace usage scan was aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_USAGE_SCAN_CONCURRENCY;
  }
  return Math.min(parsed, 128);
}

export async function calculateWorkspaceUsageBytes(workspaceRoot, options = {}) {
  if (!workspaceRoot) {
    return 0;
  }

  const root = path.resolve(workspaceRoot);
  const concurrency = normalizeConcurrency(options.concurrency);
  const signal = options.signal;
  let totalBytes = 0;

  const inspectPath = async (targetPath) => {
    if (signal?.aborted) {
      throw createAbortError();
    }

    let stat;
    try {
      stat = await fs.lstat(targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        return;
      }
      throw error;
    }

    if (stat.isSymbolicLink()) {
      return { bytes: stat.size, children: [] };
    }

    if (!stat.isDirectory()) {
      return { bytes: stat.size, children: [] };
    }

    let entries;
    try {
      entries = await fs.readdir(targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        return { bytes: 0, children: [] };
      }
      throw error;
    }

    return {
      bytes: 0,
      children: entries.map((entry) => path.join(targetPath, entry)),
    };
  };

  // Process a bounded batch at a time. The previous recursive Promise.all
  // implementation could queue tens of thousands of lstat calls at once for
  // workspaces containing node_modules or generated artifacts, exhausting file
  // descriptors and making unrelated HTTP requests appear to hang.
  const pendingPaths = [root];
  let cursor = 0;

  while (cursor < pendingPaths.length) {
    if (signal?.aborted) {
      throw createAbortError();
    }

    const batch = pendingPaths.slice(cursor, cursor + concurrency);
    cursor += batch.length;
    const results = await Promise.all(batch.map(inspectPath));

    for (const result of results) {
      if (!result) continue;
      totalBytes += result.bytes;
      pendingPaths.push(...result.children);
    }
  }

  return totalBytes;
}

export async function getWorkspaceStorageQuota({ workspace, userStore, env = process.env, signal }) {
  const limitMb = resolveWorkspaceSizeMb({ workspace, userStore, env });
  const limitBytes = workspaceSizeMbToBytes(limitMb);
  const usedBytes = await calculateWorkspaceUsageBytes(workspace?.path, { signal });
  const remainingBytes = Math.max(limitBytes - usedBytes, 0);

  return {
    limitMb,
    limitBytes,
    usedBytes,
    remainingBytes,
    exceeded: usedBytes > limitBytes,
  };
}

export function assertWorkspaceUploadFitsQuota(quota, uploadBytes) {
  const size = Number(uploadBytes) || 0;
  if (quota.usedBytes + size <= quota.limitBytes) {
    return;
  }

  const error = new Error('Workspace storage limit exceeded');
  error.statusCode = 413;
  error.details = {
    uploadBytes: size,
    remainingBytes: quota.remainingBytes,
    usedBytes: quota.usedBytes,
    limitBytes: quota.limitBytes,
    limitMb: quota.limitMb,
  };
  throw error;
}
