import assert from 'node:assert/strict';
import test from 'node:test';

import { bindingOptions, canSaveHookBindings, filterBindingOptions, matchBindingUsernames } from './bindings';
import type { HookBindingUser } from './bindings';

const users: HookBindingUser[] = [
  { id: 1, username: 'Alice', isActive: true, isSystemAdmin: false, bound: true },
  { id: 2, username: '张三', isActive: true, isSystemAdmin: false, bound: false },
  { id: 3, username: '已停用', isActive: false, isSystemAdmin: false, bound: true },
];
const tenants = [{ id: 10, name: '研发租户', code: 'dev', active: true, activeUserCount: 8, bound: false }];

test('bulk input deduplicates case-insensitive matches and never selects inactive or missing users', () => {
  assert.deepEqual(matchBindingUsernames('Alice, alice；张三\n已停用 missing', users), { ids: [1, 2], missing: ['已停用', 'missing'] });
});

test('selected-only intersects search without dropping hidden selections', () => {
  const options = bindingOptions('users', users, tenants);
  const selected = new Set([1, 3]);
  assert.deepEqual(filterBindingOptions(options, '', selected, true).map(item => item.id), [1, 3]);
  assert.deepEqual(filterBindingOptions(options, 'ALICE', selected, true).map(item => item.id), [1]);
  assert.equal(filterBindingOptions(options, '张三', selected, true).length, 0);
  assert.deepEqual([...selected], [1, 3]);
});

test('tenant search supports names and codes; all-users uses no selectable list', () => {
  const options = bindingOptions('tenants', users, tenants);
  assert.equal(filterBindingOptions(options, '研发', new Set(), false)[0].id, 10);
  assert.equal(filterBindingOptions(options, ' DEV ', new Set(), false)[0].id, 10);
  assert.deepEqual(bindingOptions('all_users', users, tenants), []);
});

test('save guards preserve empty-user unbinding but reject empty tenants and empty overwrite', () => {
  assert.equal(canSaveHookBindings('users', 0, false, false, false), true);
  assert.equal(canSaveHookBindings('tenants', 0, false, false, false), false);
  assert.equal(canSaveHookBindings('users', 0, true, false, false), false);
  assert.equal(canSaveHookBindings('all_users', 0, true, false, false), false);
  for (const scope of ['users', 'tenants', 'all_users'] as const) {
    assert.equal(canSaveHookBindings(scope, 2, true, false, false), true);
    assert.equal(canSaveHookBindings(scope, 2, false, true, false), false);
    assert.equal(canSaveHookBindings(scope, 2, true, false, true), false);
  }
});
