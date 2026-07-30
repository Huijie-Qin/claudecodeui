import { promises as fs } from 'fs';
import path from 'path';

import { applyWorkspaceOwnership } from './workspace-ownership.js';

function assertUnderRoot(workspaceRoot, targetPath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);

  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return target;
  }

  const error = new Error('Path must be under workspace root');
  error.statusCode = 403;
  throw error;
}

function resolveWorkspacePath(workspaceRoot, requestedPath = '') {
  const target = path.isAbsolute(String(requestedPath))
    ? path.resolve(String(requestedPath))
    : path.resolve(workspaceRoot, String(requestedPath || ''));

  return assertUnderRoot(workspaceRoot, target);
}

function normalizeWorkspaceDisplayPath(requestedPath, fieldName) {
  const normalizedPath = String(requestedPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');

  if (normalizedPath !== '/workspace' && !normalizedPath.startsWith('/workspace/')) {
    const error = new Error(`${fieldName} must be /workspace or start with /workspace/`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedPath === '/workspace'
    ? ''
    : normalizedPath.slice('/workspace/'.length);
}

function resolveWorkspaceDisplayPath(workspaceRoot, requestedPath, fieldName) {
  return resolveWorkspacePath(
    workspaceRoot,
    normalizeWorkspaceDisplayPath(requestedPath, fieldName),
  );
}

function toWorkspaceRelativePath(workspaceRoot, targetPath) {
  return path.relative(path.resolve(workspaceRoot), path.resolve(targetPath)).split(path.sep).join('/');
}

function sanitizePlanSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function formatPlanTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

export async function moveWorkspaceItem({
  workspaceRoot,
  sourcePath,
  targetDirectory = '',
}) {
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required');
  }
  if (!sourcePath) {
    const error = new Error('sourcePath is required');
    error.statusCode = 400;
    throw error;
  }

  const root = path.resolve(workspaceRoot);
  const resolvedSourcePath = resolveWorkspaceDisplayPath(root, sourcePath, 'sourcePath');
  const resolvedTargetDirectory = resolveWorkspaceDisplayPath(root, targetDirectory, 'targetDirectory');

  if (resolvedSourcePath === root) {
    const error = new Error('Cannot move workspace root');
    error.statusCode = 403;
    throw error;
  }

  const sourceStat = await fs.stat(resolvedSourcePath);
  const targetStat = await fs.stat(resolvedTargetDirectory);
  if (!targetStat.isDirectory()) {
    const error = new Error('Target path must be a directory');
    error.statusCode = 400;
    throw error;
  }

  if (sourceStat.isDirectory()) {
    const relativeToSource = path.relative(resolvedSourcePath, resolvedTargetDirectory);
    if (relativeToSource === '' || (!relativeToSource.startsWith('..') && !path.isAbsolute(relativeToSource))) {
      const error = new Error('Cannot move a directory into itself');
      error.statusCode = 400;
      throw error;
    }
  }

  const destinationPath = assertUnderRoot(root, path.join(resolvedTargetDirectory, path.basename(resolvedSourcePath)));

  try {
    await fs.access(destinationPath);
    const error = new Error('A file or directory with this name already exists in the target directory');
    error.statusCode = 409;
    throw error;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.rename(resolvedSourcePath, destinationPath);
  await applyWorkspaceOwnership({
    workspaceRoot: root,
    targetPaths: [destinationPath],
    recursive: sourceStat.isDirectory(),
    reason: 'file_manager_move',
  });

  return {
    success: true,
    oldPath: resolvedSourcePath,
    newPath: destinationPath,
    relativePath: toWorkspaceRelativePath(root, destinationPath),
    type: sourceStat.isDirectory() ? 'directory' : 'file',
  };
}

export async function savePlanMarkdownToWorkspaceRoot({
  workspaceRoot,
  plan,
  now = new Date(),
  sessionId,
}) {
  if (!workspaceRoot) {
    throw new Error('workspaceRoot is required');
  }
  if (typeof plan !== 'string' || !plan.trim()) {
    const error = new Error('Plan content is required');
    error.statusCode = 400;
    throw error;
  }

  const root = path.resolve(workspaceRoot);
  const timestamp = formatPlanTimestamp(now);
  const sessionSegment = sanitizePlanSegment(sessionId);
  const fileName = sessionSegment
    ? `plan-${timestamp}-${sessionSegment}.md`
    : `plan-${timestamp}.md`;
  const targetPath = assertUnderRoot(root, path.join(root, fileName));
  const normalizedPlan = plan.replace(/\\n/g, '\n').trimEnd() + '\n';

  await fs.writeFile(targetPath, normalizedPlan, 'utf8');
  await applyWorkspaceOwnership({
    workspaceRoot: root,
    targetPaths: [targetPath],
    reason: 'workspace_plan_save',
  });

  return {
    success: true,
    path: targetPath,
    relativePath: fileName,
  };
}
