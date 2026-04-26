import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseInitialTenant } from '../components/tenant/tenantSelectionHelper';

test('chooseInitialTenant keeps saved tenant when still visible', () => {
  const tenant = chooseInitialTenant('2', [
    { id: 1, code: 'one', name: 'One', permission: 'view' },
    { id: 2, code: 'two', name: 'Two', permission: 'edit' },
  ]);

  assert.equal(tenant?.id, 2);
});

test('chooseInitialTenant requires explicit choice when saved tenant is gone', () => {
  const tenant = chooseInitialTenant('99', [
    { id: 1, code: 'one', name: 'One', permission: 'view' },
  ]);

  assert.equal(tenant, null);
});
