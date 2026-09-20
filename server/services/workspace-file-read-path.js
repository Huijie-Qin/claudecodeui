import { promises as fs } from 'node:fs';
import path from 'node:path';

function assertInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    return;
  }
  const error = new Error('File path resolves outside the authorized workspace');
  error.statusCode = 403;
  throw error;
}

// Authorization chooses the boundary before this function runs. Resolve both
// paths so final symlinks and symlinked ancestor directories cannot escape it.
// Return the canonical file path so callers do not reopen the original alias.
export async function resolveWorkspaceFileReadPath(boundaryRoot, targetPath) {
  const root = path.resolve(boundaryRoot);
  const target = path.resolve(root, targetPath);
  assertInside(root, target);
  try {
    const canonicalRoot = await fs.realpath(root);
    const canonicalTarget = await fs.realpath(target);
    assertInside(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      error.statusCode = 404;
      error.message = 'File not found';
    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
      error.statusCode = 403;
      error.message = 'Permission denied';
    }
    throw error;
  }
}
