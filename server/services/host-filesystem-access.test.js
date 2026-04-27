import assert from 'node:assert/strict';
import test from 'node:test';

import { canAccessHostFilesystem } from './host-filesystem-access.js';

test('host filesystem APIs reject regular users', () => {
  assert.equal(canAccessHostFilesystem({ id: 2, is_system_admin: 0 }), false);
  assert.equal(canAccessHostFilesystem({ id: 2 }), false);
});

test('host filesystem APIs allow system admins', () => {
  assert.equal(canAccessHostFilesystem({ id: 1, is_system_admin: 1 }), true);
  assert.equal(canAccessHostFilesystem({ id: 1, is_system_admin: true }), true);
});
