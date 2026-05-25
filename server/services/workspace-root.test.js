import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspacesRoot } from './workspace-root.js';

test('resolveWorkspacesRoot prefers an explicit WORKSPACES_ROOT', () => {
  assert.equal(
    resolveWorkspacesRoot({
      env: { WORKSPACES_ROOT: '/custom/workspaces' },
      homedir: '/root',
    }),
    '/custom/workspaces',
  );
});

test('resolveWorkspacesRoot uses /workspace for root-user containers', () => {
  assert.equal(
    resolveWorkspacesRoot({
      env: {},
      homedir: '/root',
    }),
    '/workspace',
  );
});

test('resolveWorkspacesRoot keeps non-root home directories as the default', () => {
  assert.equal(
    resolveWorkspacesRoot({
      env: {},
      homedir: '/home/agent',
    }),
    '/home/agent',
  );
});
