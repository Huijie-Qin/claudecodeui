import { promises as defaultFs } from 'node:fs';
import path from 'node:path';

import { resolveContainerUser, usesDockerAgentRuntime } from './container-user.js';

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function requireOwnershipTarget(workspaceRoot, targetPath) {
  if (!workspaceRoot || !path.isAbsolute(String(workspaceRoot))) {
    throw new Error('workspaceRoot must be an absolute path');
  }
  if (!targetPath || !path.isAbsolute(String(targetPath))) {
    throw new Error('Ownership target must be an absolute path');
  }

  const root = path.resolve(String(workspaceRoot));
  const target = path.resolve(String(targetPath));
  const relative = path.relative(root, target);
  if (
    relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    return { root, target };
  }

  const error = new Error('Ownership target must stay under workspace root');
  error.statusCode = 403;
  throw error;
}

function assertCanonicalPathInside(canonicalRoot, canonicalTarget) {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (
    relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  ) {
    return;
  }

  const error = new Error('Ownership target resolves outside workspace root');
  error.statusCode = 403;
  throw error;
}

async function resolveSafeExistingPath(fsImpl, targetPath, boundaryRoot) {
  const stats = await fsImpl.lstat(targetPath);
  if (!boundaryRoot) {
    return { stats, operationPath: targetPath };
  }

  if (stats.isSymbolicLink()) {
    const canonicalParent = await fsImpl.realpath(path.dirname(targetPath));
    assertCanonicalPathInside(boundaryRoot, path.resolve(canonicalParent));
    return { stats, operationPath: targetPath };
  }

  const canonicalTarget = path.resolve(await fsImpl.realpath(targetPath));
  assertCanonicalPathInside(boundaryRoot, canonicalTarget);
  return { stats, operationPath: canonicalTarget };
}

async function chownPath(fsImpl, targetPath, { uid, gid }, boundaryRoot = null) {
  const { stats, operationPath } = await resolveSafeExistingPath(fsImpl, targetPath, boundaryRoot);
  if (stats.isSymbolicLink()) {
    if (typeof fsImpl.lchown === 'function') {
      await fsImpl.lchown(operationPath, uid, gid);
      return 1;
    }
    return 0;
  }
  if (stats.uid === uid && stats.gid === gid) {
    return 0;
  }
  await fsImpl.chown(operationPath, uid, gid);
  return 1;
}

export async function migratePathOwnership(fsImpl, targetPath, { uid, gid, boundaryRoot = null } = {}) {
  if (!isNonNegativeInteger(uid) || !isNonNegativeInteger(gid)) {
    throw new Error('uid and gid must be non-negative integers');
  }

  const { stats, operationPath } = await resolveSafeExistingPath(fsImpl, targetPath, boundaryRoot);
  if (stats.isSymbolicLink()) {
    if (typeof fsImpl.lchown === 'function') {
      await fsImpl.lchown(operationPath, uid, gid);
      return 1;
    }
    return 0;
  }

  let migratedEntries = 0;
  if (stats.isDirectory()) {
    const entries = await fsImpl.readdir(operationPath, { withFileTypes: true });
    for (const entry of entries) {
      migratedEntries += await migratePathOwnership(
        fsImpl,
        path.join(operationPath, entry.name),
        { uid, gid, boundaryRoot },
      );
    }
  }

  if (boundaryRoot && stats.uid === uid && stats.gid === gid) {
    return migratedEntries;
  }
  await fsImpl.chown(operationPath, uid, gid);
  return migratedEntries + 1;
}

function addParentPaths(paths, workspaceRoot, targetPath) {
  let currentPath = path.dirname(targetPath);
  while (currentPath === workspaceRoot || currentPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    if (!paths.has(currentPath)) {
      paths.set(currentPath, false);
    }
    if (currentPath === workspaceRoot) break;
    currentPath = path.dirname(currentPath);
  }
}

export async function applyWorkspaceOwnership({
  workspaceRoot,
  targetPaths,
  recursive = false,
  includeParents = true,
  env = process.env,
  fsImpl = defaultFs,
  logger = console,
  reason = 'workspace_write',
  context = {},
} = {}) {
  if (!usesDockerAgentRuntime(env)) {
    return { skipped: true, reason: 'local_execution_mode', entries: 0 };
  }

  const owner = resolveContainerUser(env);
  if (!isNonNegativeInteger(owner.uid) || !isNonNegativeInteger(owner.gid)) {
    throw new Error('CLOUDCLI_DOCKER_UID and CLOUDCLI_DOCKER_GID must be non-negative integers');
  }

  const requestedTargets = (Array.isArray(targetPaths) ? targetPaths : [targetPaths]).filter(Boolean);
  const ownershipPaths = new Map();
  let resolvedRoot = null;
  for (const requestedTarget of requestedTargets) {
    const { root, target } = requireOwnershipTarget(workspaceRoot, requestedTarget);
    resolvedRoot = root;
    if (includeParents) {
      addParentPaths(ownershipPaths, root, target);
    }
    ownershipPaths.set(target, Boolean(recursive) || ownershipPaths.get(target) === true);
  }

  if (ownershipPaths.size === 0) {
    return { skipped: true, reason: 'no_targets', entries: 0 };
  }

  const logDetails = {
    reason,
    targetUser: `${owner.uid}:${owner.gid}`,
    workspaceRoot: resolvedRoot,
    targets: requestedTargets.length,
    ...context,
  };
  logger?.log?.('[workspace-ownership]', JSON.stringify({
    event: 'workspace_ownership_start',
    ...logDetails,
  }));

  try {
    const canonicalRoot = path.resolve(await fsImpl.realpath(resolvedRoot));
    let entries = 0;
    for (const [targetPath, migrateRecursively] of ownershipPaths) {
      const operationTarget = path.resolve(targetPath) === resolvedRoot
        ? canonicalRoot
        : targetPath;
      entries += migrateRecursively
        ? await migratePathOwnership(fsImpl, operationTarget, { ...owner, boundaryRoot: canonicalRoot })
        : await chownPath(fsImpl, operationTarget, owner, canonicalRoot);
    }
    logger?.log?.('[workspace-ownership]', JSON.stringify({
      event: 'workspace_ownership_completed',
      ...logDetails,
      entries,
    }));
    return { skipped: false, owner, entries };
  } catch (error) {
    logger?.error?.('[workspace-ownership]', JSON.stringify({
      event: 'workspace_ownership_failed',
      ...logDetails,
      error: error?.message || String(error),
    }));
    throw error;
  }
}
