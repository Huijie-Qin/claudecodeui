import assert from 'node:assert/strict';
import test from 'node:test';

import { hookDetailScope, initialHookDetailFilters } from './hookDetailState';

const params = { tenantId: 10, scope: 'tenant', batchId: 'published-1', from: '2026-08-14', to: '2026-09-12', userSearch: 'Alice', workspaceSearch: 'Dev', page: 8, search: 'outer', sortBy: 'sum' };
const row = { hookId: 'sql', postActionId: 'record-sql', recordType: 'sql', hookVersion: 2, recordSource: 'post_action' };

test('detail statistics and records share local filters and exact field identity without pagination or outer searches', () => {
  const initial = initialHookDetailFilters(params, row);
  assert.equal(initial.userName, 'Alice');
  assert.equal(initial.workspaceName, 'Dev');
  const local = { ...initial, from: '2026-09-01', to: '2026-09-02', userName: ' Bob ', workspaceName: ' SQL ' };
  const query = hookDetailScope(params, row, local);
  assert.deepEqual(query, { tenantId: 10, scope: 'tenant', batchId: 'published-1', postActionId: 'record-sql', recordType: 'sql', hookVersion: 2, recordSource: 'post_action', recordUserId: undefined, from: '2026-09-01', to: '2026-09-02', userSearch: 'Bob', workspaceSearch: 'SQL' });
  assert.equal(params.userSearch, 'Alice');
  assert.equal(initial.userName, 'Alice');
});

test('user drilldown starts at the exact identity but explicitly editing the name can select another tenant user', () => {
  const userRow = { ...row, userId: 3, userName: 'Same name' };
  const initial = initialHookDetailFilters(params, userRow);
  assert.equal(initial.userName, 'Same name');
  assert.equal(hookDetailScope(params, userRow, initial).recordUserId, 3);
  assert.equal(hookDetailScope(params, userRow, initial).userSearch, '');
  const edited = hookDetailScope(params, userRow, { ...initial, userName: 'New name', recordUserId: undefined });
  assert.equal(edited.recordUserId, undefined);
  assert.equal(edited.userSearch, 'New name');
  assert.equal(edited.tenantId, 10);
});

test('unknown-user drilldown does not silently widen to all users; all-Hook drilldown has no field identity restriction', () => {
  const unknown = { ...row, userId: null };
  assert.equal(hookDetailScope(params, unknown, initialHookDetailFilters(params, unknown)).recordUserId, '__unknown__');
  const all = { hookId: 'sql', allHookRecords: true };
  const query = hookDetailScope(params, all, initialHookDetailFilters(params, all));
  assert.ok(!('hookVersion' in query));
  assert.ok(!('postActionId' in query));
});
