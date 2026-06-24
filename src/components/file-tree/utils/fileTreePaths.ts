import type { Project } from '../../../types/app';

function normalizePath(pathValue: string): string {
  return pathValue
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
}

function getPathBasename(pathValue?: string): string {
  return normalizePath(String(pathValue || ''))
    .split('/')
    .filter(Boolean)
    .pop() || '';
}

function getWorkspacePath(project?: Project | null): string {
  return normalizePath(String(project?.fullPath || project?.path || ''));
}

function getWorkspaceName(project?: Project | null): string {
  return getPathBasename(project?.fullPath) || getPathBasename(project?.path);
}

function buildWorkspacePathFromRelativePath(relativePath: string): string {
  const normalizedRelativePath = normalizePath(relativePath).replace(/^\/+/, '');

  return normalizedRelativePath ? `/workspace/${normalizedRelativePath}` : '/workspace';
}

function buildWorkspacePathAfterWorkspaceName(filePath: string, workspaceName: string): string {
  const pathSegments = filePath.split('/').filter(Boolean);
  const workspaceSegmentIndex = pathSegments.lastIndexOf(workspaceName);
  if (workspaceSegmentIndex === -1) {
    return '';
  }

  return buildWorkspacePathFromRelativePath(pathSegments.slice(workspaceSegmentIndex + 1).join('/'));
}

export function getFileTreeClipboardPath(filePath: string, project?: Project | null): string {
  const normalizedPath = normalizePath(String(filePath || ''));
  if (!normalizedPath) {
    return '/workspace';
  }

  const configuredWorkspacePath = getWorkspacePath(project);
  if (configuredWorkspacePath) {
    if (normalizedPath === configuredWorkspacePath) {
      return '/workspace';
    }

    if (normalizedPath.startsWith(`${configuredWorkspacePath}/`)) {
      return buildWorkspacePathFromRelativePath(normalizedPath.slice(configuredWorkspacePath.length + 1));
    }
  }

  const workspaceName = getWorkspaceName(project);
  if (workspaceName) {
    const workspacePath = buildWorkspacePathAfterWorkspaceName(normalizedPath, workspaceName);
    if (workspacePath) {
      return workspacePath;
    }
  }

  if (normalizedPath === '/workspace' || normalizedPath.startsWith('/workspace/')) {
    return normalizedPath;
  }

  return buildWorkspacePathFromRelativePath(normalizedPath);
}
