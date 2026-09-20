import assert from 'node:assert/strict';
import test from 'node:test';

import { canManageTenant } from './tenantManagementAccess';

test('tenant management navigation only shows for current tenant admins or system admins', () => {
  assert.equal(canManageTenant({ username: 'admin' }, { role: 'tenant_admin' }), true);
  assert.equal(canManageTenant({ username: 'member' }, { role: 'member' }), false);
  assert.equal(canManageTenant({ is_system_admin: 1 }, { role: 'member' }), true);
  assert.equal(canManageTenant({ is_system_admin: true }, {}), true);
  assert.equal(canManageTenant({ is_system_admin: '1' }, { role: 'member' }), false);
  assert.equal(canManageTenant(null, { role: 'tenant_admin' }), false);
  assert.equal(canManageTenant({ is_system_admin: 1 }, null), false);
  assert.equal(canManageTenant({ username: 'admin elsewhere' }, { role: 'system_admin' }), false);
});
