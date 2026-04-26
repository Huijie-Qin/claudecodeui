import assert from 'node:assert/strict';
import test from 'node:test';

import type { Tenant } from '../../types/app';

import { resolveTenantSelection, shouldShowTenantSwitcher } from './tenantSwitcherUtils';

const tenants: Tenant[] = [
  { id: 1, code: 'default', name: 'Default', permission: 'edit' },
  { id: 2, code: 'team', name: 'Team', permission: 'view' },
];

test('shouldShowTenantSwitcher only shows when there are multiple tenants', () => {
  assert.equal(shouldShowTenantSwitcher([]), false);
  assert.equal(shouldShowTenantSwitcher([tenants[0]]), false);
  assert.equal(shouldShowTenantSwitcher(tenants), true);
});

test('resolveTenantSelection returns the selected tenant by id', () => {
  assert.equal(resolveTenantSelection(tenants, '2')?.code, 'team');
  assert.equal(resolveTenantSelection(tenants, '99'), null);
  assert.equal(resolveTenantSelection(tenants, 'abc'), null);
});
