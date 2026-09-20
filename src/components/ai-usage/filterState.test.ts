import assert from 'node:assert/strict';
import test from 'node:test';

import { tableNameFilter, usageFilterParams } from './filterState';

test('shared report filters contain only dates and identity names, never table-specific search', () => {
  const params = usageFilterParams({ from: '2026-09-01', to: '2026-09-12',
    userName: ' 模拟用户 05 ', workspaceName: ' 研发工作区 ' });
  assert.equal(params.userSearch, '模拟用户 05');
  assert.equal(params.workspaceSearch, '研发工作区');
  assert.ok(!('userId' in params)); assert.ok(!('workspaceId' in params));
  assert.ok(!('search' in params));
  assert.ok(!('recordType' in params)); assert.ok(!('recordSource' in params));
});

test('each table has its own entity-name search and Hook fields no longer use field-key matching', () => {
  assert.equal(tableNameFilter('usage'), null);
  assert.deepEqual(tableNameFilter('skills'), { key: 'search', label: 'skillNameFilter' });
  assert.deepEqual(tableNameFilter('templates'), { key: 'search', label: 'templateNameFilter' });
  for (const tab of ['hooks', 'hookExecutions', 'hookFields'] as const) {
    assert.deepEqual(tableNameFilter(tab), { key: 'search', label: 'hookNameFilter' });
  }
});
