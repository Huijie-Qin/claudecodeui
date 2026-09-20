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

test('permission-only grants omit role so existing tenant administrators are preserved', () => {
  assert.deepEqual(buildTenantMembershipPayload('view'), {
    permission: 'view',
    status: 'active',
  });
});

test('membership payload only changes a role when explicitly selected', () => {
  assert.deepEqual(buildTenantMembershipPayload('view', 'tenant_admin'), {
    role: 'tenant_admin', permission: 'view', status: 'active',
  });
  assert.equal(buildTenantMembershipPayload('edit', 'member').role, 'member');
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
