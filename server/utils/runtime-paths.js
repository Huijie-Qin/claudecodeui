import path from 'path';
import { fileURLToPath } from 'url';

function createInvalidPathSegmentError(label) {
  const error = new Error(`Invalid ${label}`);
  error.code = 'INVALID_PATH_SEGMENT';
  error.statusCode = 400;
  return error;
}

function matchesPattern(value, pattern) {
  if (!(pattern instanceof RegExp)) {
    return true;
  }

  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function requireSafePathSegment(value, {
  label = 'path segment',
  pattern = null,
} = {}) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || value.includes('\0')
    || value.includes('/')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.basename(value) !== value
    || path.win32.basename(value) !== value
    || !matchesPattern(value, pattern)
  ) {
    throw createInvalidPathSegmentError(label);
  }

  return value;
}

export function resolveDirectChildPath(parentPath, childName, options = {}) {
  const safeChildName = requireSafePathSegment(childName, options);
  const resolvedParent = path.resolve(parentPath);
  const resolvedTarget = path.resolve(resolvedParent, safeChildName);
  const relativePath = path.relative(resolvedParent, resolvedTarget);

  if (
    !relativePath
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
    || path.dirname(relativePath) !== '.'
  ) {
    throw createInvalidPathSegmentError(options.label || 'path segment');
  }

  return resolvedTarget;
}

export function getModuleDir(importMetaUrl) {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function findServerRoot(startDir) {
  // Source files live under /server, while compiled files live under /dist-server/server.
  // Walking up to the nearest "server" folder gives every backend module one stable anchor
  // that works in both layouts instead of relying on fragile "../.." assumptions.
  let currentDir = startDir;

  while (path.basename(currentDir) !== 'server') {
    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not resolve the backend server root from "${startDir}".`);
    }

    currentDir = parentDir;
  }

  return currentDir;
}

export function findAppRoot(startDir) {
  const serverRoot = findServerRoot(startDir);
  const parentOfServerRoot = path.dirname(serverRoot);

  // Source files live at <app>/server, while compiled files live at <app>/dist-server/server.
  // When the nearest server folder sits inside dist-server we need to hop one extra level up
  // so repo-level files still resolve from the real app root instead of the build directory.
  return path.basename(parentOfServerRoot) === 'dist-server'
    ? path.dirname(parentOfServerRoot)
    : parentOfServerRoot;
}
