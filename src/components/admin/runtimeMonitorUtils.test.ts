import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRuntimeQueryString,
  formatBytes,
  formatRuntimeAge,
  runtimeRowContainsHostPath,
} from './runtimeMonitorUtils';

test('buildRuntimeQueryString includes only selected filters', () => {
  assert.equal(
    buildRuntimeQueryString({
      tenantId: 'tenant-1',
      userId: '',
      workspaceId: null,
      status: 'idle',
      dockerState: undefined,
      provider: 'claude',
      q: '   ',
    }),
    '?tenantId=tenant-1&status=idle&provider=claude',
  );
});

test('buildRuntimeQueryString encodes spaces and special characters in query text', () => {
  const queryString = buildRuntimeQueryString({ q: 'alice team/provider?' });

  assert.equal(queryString, '?q=alice+team%2Fprovider%3F');
});

test('formatBytes renders compact binary units', () => {
  assert.equal(formatBytes(null), '-');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(2147483648), '2.0 GiB');
});

test('formatRuntimeAge renders compact age values', () => {
  assert.equal(formatRuntimeAge(null), '-');
  assert.equal(formatRuntimeAge(42), '42s');
  assert.equal(formatRuntimeAge(360), '6m');
  assert.equal(formatRuntimeAge(7200), '2h');
});

test('runtimeRowContainsHostPath detects host path fields', () => {
  assert.equal(runtimeRowContainsHostPath({ workspaceHostPath: '/workspace' }), true);
  assert.equal(runtimeRowContainsHostPath({ runtimeHomePath: '/runtime-home' }), true);
  assert.equal(runtimeRowContainsHostPath({ workspacePath: '/workspace' }), false);
  assert.equal(runtimeRowContainsHostPath(null), false);
});
