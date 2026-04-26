import assert from 'node:assert/strict';
import test from 'node:test';

import { isProjectUpdateScopedToTenant } from './projectTenantUpdates';

test('isProjectUpdateScopedToTenant accepts updates for the selected tenant', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'alpha', displayName: 'Alpha', fullPath: '/tmp/alpha', tenantId: 2 },
    { name: 'beta', displayName: 'Beta', fullPath: '/tmp/beta', tenantId: 2 },
  ], 2), true);
});

test('isProjectUpdateScopedToTenant rejects legacy or cross-tenant updates', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'legacy', displayName: 'Legacy', fullPath: '/tmp/legacy' },
  ], 2), false);
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'other', displayName: 'Other', fullPath: '/tmp/other', tenantId: 1 },
  ], 2), false);
});

test('isProjectUpdateScopedToTenant allows updates when no tenant is selected', () => {
  assert.equal(isProjectUpdateScopedToTenant([
    { name: 'legacy', displayName: 'Legacy', fullPath: '/tmp/legacy' },
  ], null), true);
});
