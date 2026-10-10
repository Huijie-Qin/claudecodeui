import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTenantMembershipPayload,
  normalizeTenantCode,
  isSystemAdminUser,
  parseBatchUsernames,
} from './adminPanelUtils';

test('isSystemAdminUser accepts numeric and boolean admin flags', () => {
  assert.equal(isSystemAdminUser({ username: 'numeric-admin', is_system_admin: 1 }), true);
  assert.equal(isSystemAdminUser({ username: 'boolean-admin', is_system_admin: true }), true);
  assert.equal(isSystemAdminUser({ username: 'member', is_system_admin: 0 }), false);
  assert.equal(isSystemAdminUser(null), false);
});

test('single and batch grants default to edit and preserve the existing role unless selected', () => {
  assert.deepEqual(buildTenantMembershipPayload(), {
    permission: 'edit',
    status: 'active',
  });
});

test('membership payload only changes a role when explicitly selected', () => {
  assert.deepEqual(buildTenantMembershipPayload('tenant_admin'), {
    role: 'tenant_admin', permission: 'edit', status: 'active',
  });
  assert.deepEqual(buildTenantMembershipPayload('member'), {
    role: 'member', permission: 'edit', status: 'active',
  });
  assert.equal(isSystemAdminUser({ role: 'tenant_admin' }), false);
});

test('normalizeTenantCode creates lowercase hyphen tenant codes', () => {
  assert.equal(normalizeTenantCode(' Acme Team 01 '), 'acme-team-01');
  assert.equal(normalizeTenantCode('Foo_Bar!'), 'foo-bar');
  assert.equal(normalizeTenantCode('--Default--'), 'default');
});

test('parseBatchUsernames accepts common separators and removes duplicates', () => {
  assert.deepEqual(
    parseBatchUsernames('alice\nbob, carol; Alice  dave'),
    ['alice', 'bob', 'carol', 'dave'],
  );
});
