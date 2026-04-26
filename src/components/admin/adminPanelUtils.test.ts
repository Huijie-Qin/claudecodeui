import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTenantMembershipPayload, isSystemAdminUser } from './adminPanelUtils';

test('isSystemAdminUser accepts numeric and boolean admin flags', () => {
  assert.equal(isSystemAdminUser({ username: 'numeric-admin', is_system_admin: 1 }), true);
  assert.equal(isSystemAdminUser({ username: 'boolean-admin', is_system_admin: true }), true);
  assert.equal(isSystemAdminUser({ username: 'member', is_system_admin: 0 }), false);
  assert.equal(isSystemAdminUser(null), false);
});

test('buildTenantMembershipPayload grants active member access with selected permission', () => {
  assert.deepEqual(buildTenantMembershipPayload('view'), {
    role: 'member',
    permission: 'view',
    status: 'active',
  });
});
