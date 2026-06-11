import { promises as fs } from 'fs';
import path from 'path';

export const DEFAULT_WORKSPACE_SIZE_MB = 200;
export const WORKSPACE_SIZE_ENV_NAME = 'WORKSPACE_SIZE';
export const WORKSPACE_SIZE_ADMIN_ENV_NAME = 'workspace_size';
export const BYTES_PER_MB = 1024 * 1024;

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

export async function calculateWorkspaceUsageBytes(workspaceRoot) {
  if (!workspaceRoot) {
    return 0;
  }

  const root = path.resolve(workspaceRoot);
  let totalBytes = 0;

  async function visit(targetPath) {
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
      totalBytes += stat.size;
      return;
    }

    if (!stat.isDirectory()) {
      totalBytes += stat.size;
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(targetPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        return;
      }
      throw error;
    }

    await Promise.all(entries.map((entry) => visit(path.join(targetPath, entry))));
  }

  await visit(root);
  return totalBytes;
}

export async function getWorkspaceStorageQuota({ workspace, userStore, env = process.env }) {
  const limitMb = resolveWorkspaceSizeMb({ workspace, userStore, env });
  const limitBytes = workspaceSizeMbToBytes(limitMb);
  const usedBytes = await calculateWorkspaceUsageBytes(workspace?.path);
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
