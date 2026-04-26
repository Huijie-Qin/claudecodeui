import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWorkspaceAclEntries } from './workspaceShare';

test('normalizeWorkspaceAclEntries removes owner and invalid users', () => {
  const entries = normalizeWorkspaceAclEntries(1, [
    { userId: 1, permission: 'edit' },
    { userId: 2, permission: 'edit' },
    { userId: 0, permission: 'view' },
    { userId: 3, permission: 'bad' },
  ]);

  assert.deepEqual(entries, [{ userId: 2, permission: 'edit' }]);
});

test('normalizeWorkspaceAclEntries keeps the latest permission for duplicate users', () => {
  const entries = normalizeWorkspaceAclEntries(1, [
    { userId: 2, permission: 'view' },
    { userId: 2, permission: 'edit' },
  ]);

  assert.deepEqual(entries, [{ userId: 2, permission: 'edit' }]);
});
