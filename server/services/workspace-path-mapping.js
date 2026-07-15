import path from 'node:path';

export const WORKSPACE_HOST_ROOT_ENV = 'CLOUDCLI_WORKSPACE_HOST_ROOT';
export const WORKSPACE_CONTAINER_ROOT_ENV = 'CLOUDCLI_WORKSPACE_CONTAINER_ROOT';

function isWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function trimTrailingSeparators(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '');
}

function isRelativePathInsideRoot(relativePath, pathApi) {
  return relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relativePath));
}

export function mapWorkspacePathForContainer(workspacePath, env = process.env) {
  const hostRoot = trimTrailingSeparators(env?.[WORKSPACE_HOST_ROOT_ENV]);
  const containerRoot = trimTrailingSeparators(env?.[WORKSPACE_CONTAINER_ROOT_ENV]);
  if (!hostRoot || !containerRoot || typeof workspacePath !== 'string' || !workspacePath.trim()) {
    return null;
  }

  const pathApi = isWindowsPath(hostRoot) || isWindowsPath(workspacePath)
    ? path.win32
    : path.posix;
  const relativePath = pathApi.relative(
    pathApi.resolve(hostRoot),
    pathApi.resolve(workspacePath),
  );
  if (!isRelativePathInsideRoot(relativePath, pathApi)) return null;

  const relativeSegments = relativePath.split(/[\\/]+/).filter(Boolean);
  return path.join(containerRoot, ...relativeSegments);
}

export function buildWorkspacePathCandidates(workspacePath, env = process.env) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return [];

  const paths = [workspacePath];
  const mappedPath = mapWorkspacePathForContainer(workspacePath, env);
  if (mappedPath && mappedPath !== workspacePath) {
    paths.push(mappedPath);
  }

  return [...new Set(paths)];
}
