import type { ProjectFilesChangedEvent } from '../file-tree/utils/fileTreeEvents';

export type FilePreviewRefreshTarget = {
  path: string;
  displayPath?: string;
  projectPath?: string;
  projectName?: string;
  workspaceId?: number;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function containsPath(parent: string, file: string): boolean {
  return file === parent || file.startsWith(`${parent}/`);
}

/** File events can carry a real path, a /workspace path, or a workspace-relative directory. */
export function shouldRefreshFilePreview(target: FilePreviewRefreshTarget, event: ProjectFilesChangedEvent): boolean {
  if (event.workspaceId != null && target.workspaceId != null && String(event.workspaceId) !== String(target.workspaceId)) return false;
  if (event.projectName && target.projectName && event.projectName !== target.projectName) return false;

  const changedPath = normalizePath(event.changedPath || '');
  if (!changedPath || changedPath === '.' || changedPath === '/workspace') return true;

  const filePath = normalizePath(target.path);
  const displayPath = target.displayPath ? normalizePath(target.displayPath) : '';
  const projectPath = target.projectPath ? normalizePath(target.projectPath) : '';
  const workspaceRoot = isAbsolutePath(projectPath) ? projectPath : '';
  const paths = new Set([filePath]);
  if (displayPath) paths.add(displayPath);
  if (!isAbsolutePath(filePath)) paths.add(`/workspace/${filePath}`);
  if (workspaceRoot && containsPath(workspaceRoot, filePath)) {
    paths.add(`/workspace${filePath.slice(workspaceRoot.length)}`);
  }

  const changedPaths = new Set([changedPath]);
  if (!isAbsolutePath(changedPath)) changedPaths.add(`/workspace/${changedPath}`);
  if (workspaceRoot && containsPath(workspaceRoot, changedPath)) {
    changedPaths.add(`/workspace${changedPath.slice(workspaceRoot.length)}`);
  }

  for (const changed of changedPaths) {
    for (const file of paths) {
      if (containsPath(changed, file)) return true;
    }
  }
  return false;
}
