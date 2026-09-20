import assert from 'node:assert/strict';
import test from 'node:test';

import { canManageTenant, shouldShowTenantManagementEntry } from './tenantManagementAccess';

test('tenant management page access remains available to tenant admins and system admins', () => {
  assert.equal(canManageTenant({ username: 'admin' }, { role: 'tenant_admin' }), true);
  assert.equal(canManageTenant({ username: 'member' }, { role: 'member' }), false);
  assert.equal(canManageTenant({ is_system_admin: 1 }, { role: 'member' }), true);
  assert.equal(canManageTenant({ is_system_admin: true }, {}), true);
  assert.equal(canManageTenant({ is_system_admin: '1' }, { role: 'member' }), false);
  assert.equal(canManageTenant(null, { role: 'tenant_admin' }), false);
  assert.equal(canManageTenant({ is_system_admin: 1 }, null), false);
  assert.equal(canManageTenant({ username: 'admin elsewhere' }, { role: 'system_admin' }), false);
});

test('tenant management entry is visible only to the current tenant administrator', () => {
  assert.equal(shouldShowTenantManagementEntry({ username: 'tenant admin', is_system_admin: 0 }, { role: 'tenant_admin' }), true);
  assert.equal(shouldShowTenantManagementEntry({ is_system_admin: false }, { role: 'tenant_admin' }), true);
  assert.equal(shouldShowTenantManagementEntry({ username: 'tenant admin' }, { role: 'tenant_admin' }), true);
  assert.equal(shouldShowTenantManagementEntry({ username: 'member', is_system_admin: 0 }, { role: 'member' }), false);
  // The same account loses the entry when switching to a tenant it cannot manage.
  assert.equal(shouldShowTenantManagementEntry({ username: 'tenant admin' }, { role: 'member' }), false);
});

test('platform admins never see the tenant management entry, even with tenant admin membership', () => {
  for (const is_system_admin of [1, true, '1']) {
    for (const role of ['tenant_admin', 'member', 'system_admin']) {
      assert.equal(shouldShowTenantManagementEntry({ is_system_admin }, { role }), false);
    }
  }
});

test('tenant management entry stays hidden while user or tenant information is unavailable', () => {
  assert.equal(shouldShowTenantManagementEntry(null, { role: 'tenant_admin' }), false);
  assert.equal(shouldShowTenantManagementEntry(undefined, { role: 'tenant_admin' }), false);
  assert.equal(shouldShowTenantManagementEntry({}, null), false);
  assert.equal(shouldShowTenantManagementEntry({}, undefined), false);
  assert.equal(shouldShowTenantManagementEntry({}, {}), false);
  assert.equal(shouldShowTenantManagementEntry({}, { role: 'system_admin' }), false);
});
