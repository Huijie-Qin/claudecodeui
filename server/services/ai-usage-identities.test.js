import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

function namedFixture(t) {
  const f = fixture(t); f.batch();
  f.db.exec(`UPDATE users SET username=CASE id WHEN 3 THEN 'Zoe' WHEN 4 THEN 'Alice' ELSE username END;
    INSERT INTO workspaces VALUES(7,10,'研发工作区','active'),(8,10,'产品工作区','active'),(9,20,'其他租户工作区','active');`);
  for (const dataset of ['hook_records', 'hook_executions', 'template_applications', 'interactions']) {
    for (const userId of [3, 4]) f.row({ id: `${dataset}-${userId}`, dataset, userId, workspaceId: userId === 3 ? 7 : 8,
      subjectId: dataset.startsWith('hook') ? 'hook-a' : 'template-a', sessionKey: `session-${userId}`,
      value: { userName: '旧用户名', workspaceName: '旧工作区名', hookName: 'Hook', templateId: 'template-a',
        fields: [{ key: 'count', type: 'number', value: 5 }] } });
  }
  return f;
}

test('all record endpoints return matching names and sort names globally before paging', (t) => {
  const f = namedFixture(t);
  for (const [method, id] of [['hookRecords', 'hook-a'], ['hookExecutionRecords', 'hook-a'],
    ['templateApplications', 'template-a'], ['templateSessions', 'template-a']]) {
    const query = (extra = {}) => f.queryService[method](f.access, id, { sortBy: 'userName', sortDir: 'asc', pageSize: 1, ...extra });
    assert.deepEqual(query().items.map((row) => [row.userId, row.userName, row.workspaceId, row.workspaceName]), [[4, 'Alice', 8, '产品工作区']]);
    assert.equal(query({ page: 2 }).items[0].userName, 'Zoe');
    assert.equal(query({ sortBy: 'workspaceName' }).items[0].workspaceName, '产品工作区');
    const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
    assert.deepEqual(f.queryService[method](self, id).items.map((row) => row.userName), ['Zoe']);
    assert.throws(() => f.queryService[method](self, id, { userId: 4 }), { statusCode: 403 });
  }
});

test('grouping displays names while same-name users and workspaces stay separate by ID', (t) => {
  const f = namedFixture(t);
  f.db.exec("UPDATE users SET username='同名用户' WHERE id IN (3,4); UPDATE workspaces SET display_name='同名工作区' WHERE tenant_id=10;");
  for (const dataset of ['usage', 'hooks', 'hookExecutions', 'templates']) {
    for (const groupBy of ['user', 'workspace']) {
      const result = f.queryService.analysis(f.access, { dataset, groupBy });
      assert.equal(result.total, 2);
      assert.deepEqual(result.items.map((row) => row.groupLabel), Array(2).fill(groupBy === 'user' ? '同名用户' : '同名工作区'));
      assert.equal(new Set(result.items.map((row) => row.groupKey)).size, 2);
    }
  }
  assert.deepEqual(f.queryService.hookFieldStatistics(f.access, { groupBy: 'user' }).items.map((row) => row.userName), ['同名用户', '同名用户']);
});

test('missing names use safe snapshots or null without exposing another tenant workspace', (t) => {
  const f = namedFixture(t);
  f.row({ id: 'deleted-workspace', dataset: 'hook_records', workspaceId: 99, subjectId: 'missing', value: { workspaceName: '历史工作区' } });
  f.row({ id: 'foreign-workspace', dataset: 'hook_records', workspaceId: 9, subjectId: 'missing' });
  f.row({ id: 'unknown', dataset: 'hook_records', userId: null, workspaceId: null, subjectId: 'missing', value: { userName: '不应显示', workspaceName: '不应显示' } });
  const rows = f.queryService.hookRecords(f.access, 'missing').items;
  assert.equal(rows.find((row) => row.id === 'deleted-workspace').workspaceName, '历史工作区');
  assert.equal(rows.find((row) => row.id === 'foreign-workspace').workspaceName, null);
  assert.deepEqual([rows.find((row) => row.id === 'unknown').userName, rows.find((row) => row.id === 'unknown').workspaceName], [null, null]);
  f.db.exec('DELETE FROM users WHERE id=4');
  assert.deepEqual(f.queryService.hookRecords(f.access, 'hook-a').items.map((row) => row.userId), [3]);
});

test('name filters apply to every report, numeric statistics and record drilldowns', (t) => {
  const f = namedFixture(t);
  const filters = { userSearch: 'lic', workspaceSearch: '产品' };
  for (const dataset of ['usage', 'hooks', 'hookExecutions', 'templates']) {
    const result = f.queryService.analysis(f.access, { ...filters, dataset, groupBy: 'user',
      ...(dataset === 'usage' ? { includeZeroUsers: true } : {}) });
    assert.deepEqual(result.items.map((row) => row.groupKey), ['4']);
  }
  for (const [method, id] of [['hookRecords', 'hook-a'], ['hookExecutionRecords', 'hook-a'],
    ['templateApplications', 'template-a'], ['templateSessions', 'template-a']]) {
    const result = f.queryService[method](f.access, id, filters);
    assert.equal(result.total, 1);
    assert.equal(result.items[0].userName, 'Alice');
    assert.equal(result.items[0].workspaceName, '产品工作区');
    assert.equal(f.queryService[method](f.access, id, { ...filters, workspaceSearch: '研发' }).total, 0);
  }
  const fields = f.queryService.hookFieldStatistics(f.access, { ...filters, groupBy: 'user' });
  assert.equal(fields.total, 1); assert.equal(fields.items[0].userName, 'Alice');
  assert.equal(fields.items[0].sum, 5);
  assert.equal(f.queryService.trend(f.access, filters).items.reduce((sum, row) => sum + row.sessionCount, 0), 1);
  assert.deepEqual(f.queryService.summary(f.access, filters), f.queryService.summary(f.access));
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(f.queryService.hookRecords(self, 'hook-a', filters).total, 0);
  assert.equal(f.queryService.hookRecords(f.access, 'hook-a', { workspaceSearch: '其他租户' }).total, 0);
});

test('Skill name filtering uses the publisher rather than the caller', (t) => {
  const f = namedFixture(t);
  f.row({ id: 'pub', dataset: 'skill_publications', userId: 3, subjectId: 'skill-a', value: { skillName: 'Skill A', publisherUserId: 3 } });
  f.row({ id: 'call', dataset: 'skill_invocations', userId: 4, subjectId: 'skill-a',
    value: { skillName: 'Skill A', publisherUserId: 3, callerUserId: 4 } });
  const published = f.queryService.skills(f.access, { userSearch: 'Zoe', workspaceSearch: '研发' });
  assert.equal(published.total, 1); assert.equal(published.items[0].invocationCount, 1);
  assert.equal(f.queryService.skills(f.access, { userSearch: 'Alice' }).total, 0);
});

test('name filters match displayed names, escape wildcards and validate input', (t) => {
  const f = namedFixture(t);
  f.db.prepare('UPDATE users SET username=? WHERE id=3').run('用户%_\\名');
  f.db.prepare('UPDATE workspaces SET display_name=? WHERE id=7').run('项目%_\\空间');
  const filters = { userSearch: '%_\\', workspaceSearch: '%_\\' };
  assert.deepEqual(f.queryService.hookRecords(f.access, 'hook-a', filters).items.map((row) => row.userId), [3]);
  assert.equal(f.queryService.hookRecords(f.access, 'hook-a', { workspaceSearch: '旧工作区名' }).total, 0);
  f.row({ id: 'snapshot', dataset: 'hook_records', workspaceId: 99, subjectId: 'hook-a', value: { workspaceName: '历史工作区' } });
  assert.equal(f.queryService.hookRecords(f.access, 'hook-a', { workspaceSearch: '历史' }).total, 1);
  for (const key of ['userSearch', 'workspaceSearch']) for (const value of ['x'.repeat(151), [], 42]) {
    assert.throws(() => f.queryService.hookRecords(f.access, 'hook-a', { [key]: value }), { code: 'invalidFilter' });
  }
});
