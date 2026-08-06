import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  requireSafePathSegment,
  resolveDirectChildPath,
} from './runtime-paths.js';

test('safe path segments preserve compatible project names', () => {
  const validNames = [
    '-Users-demo-project',
    'project.v2',
    '项目-甲',
    '.hidden',
    '...',
    'name%20with%20escapes',
  ];

  for (const name of validNames) {
    assert.equal(requireSafePathSegment(name, { label: 'project name' }), name);
  }
});

test('safe path segments reject cross-platform traversal and absolute paths', () => {
  const invalidNames = [
    '',
    '.',
    '..',
    '../outside',
    '..\\outside',
    '/tmp/outside',
    'C:\\tmp\\outside',
    '\\\\server\\share',
    'C:outside',
    `nul\0byte`,
  ];

  for (const name of invalidNames) {
    assert.throws(
      () => requireSafePathSegment(name, { label: 'project name' }),
      (error) => error?.statusCode === 400 && error?.code === 'INVALID_PATH_SEGMENT',
      name,
    );
  }
});

test('direct child resolution cannot resolve the parent or an ancestor', () => {
  const root = path.resolve('safe-root');

  assert.equal(
    resolveDirectChildPath(root, 'project.v2', { label: 'project name' }),
    path.join(root, 'project.v2'),
  );

  for (const name of ['.', '..', '../outside', '..\\outside']) {
    assert.throws(
      () => resolveDirectChildPath(root, name, { label: 'project name' }),
      (error) => error?.statusCode === 400,
      name,
    );
  }
});
