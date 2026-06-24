import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import { getFileTreeClipboardPath } from '../utils/fileTreePaths';

const project: Project = {
  name: 'workspace-project-slug',
  displayName: 'Workspace Project',
  fullPath: 'C:/Users/Alex/test/s00948802/skill',
};

test('clipboard path uses fixed workspace prefix and keeps content after current workspace path', () => {
  assert.equal(
    getFileTreeClipboardPath(
      'C:/Users/Alex/test/s00948802/skill/claude-test/server/database/schema.js',
      project,
    ),
    '/workspace/claude-test/server/database/schema.js',
  );
});

test('clipboard path keeps existing paths that are already relative to workspace root unchanged', () => {
  assert.equal(
    getFileTreeClipboardPath('/workspace/claude-test/server/database/schema.js', project),
    '/workspace/claude-test/server/database/schema.js',
  );
});

test('clipboard path strips the current workspace name from existing workspace-prefixed paths', () => {
  assert.equal(
    getFileTreeClipboardPath('/workspace/skill/claude-test/server/database/schema.js', project),
    '/workspace/claude-test/server/database/schema.js',
  );
});
