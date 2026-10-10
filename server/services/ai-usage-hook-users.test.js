import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

const dimensions = { hookId: 'hook-a', hookName: '会话记录', postActionId: 'archive', recordType: 'conversation_record', hookVersion: 1, recordSource: 'post_action' };
const field = { key: 'score', label: '评分', type: 'number', aggregation: 'avg', unit: '分' };

test('detail name/workspace/date filters share all-record statistics, independent of record pagination', (t) => {
  const { db, queryService: query, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  db.exec("INSERT INTO workspaces VALUES(7,10,'SQL 工作区','active'),(8,10,'其他工作区','active')");
  const samples = [
    { id: 'a', userId: 3, workspaceId: 7, date: '2026-09-11', values: [2, 4, 6] },
    { id: 'b', userId: 4, workspaceId: 7, date: '2026-09-11', values: [10, 20] },
    { id: 'c', userId: 3, workspaceId: 8, date: '2026-09-11', values: [999] },
    { id: 'd', userId: 3, workspaceId: 7, date: '2026-09-12', values: [888] },
  ];
  for (const sample of samples) {
    row({ ...sample, dataset: 'hook_daily', subjectId: 'hook-a', value: { ...dimensions, fields: [{ ...field, validCount: sample.values.length, sum: sample.values.reduce((a, b) => a + b, 0), min: Math.min(...sample.values), max: Math.max(...sample.values) }] } });
    sample.values.forEach((value, index) => row({ ...sample, id: `${sample.id}-${index}`, dataset: 'hook_records', subjectId: 'hook-a', value: { ...dimensions, fields: [{ ...field, value }] } }));
  }
  const filters = { batchId: 'batch-1', from: '2026-09-11', to: '2026-09-11', userSearch: 'member', workspaceSearch: 'SQL', postActionId: 'archive', hookVersion: '1' };
  for (const source of ['daily', 'records']) {
    const stats = query.hookStatistics(access, 'hook-a', { ...filters, groupBy: 'user' });
    assert.equal(stats.aggregationSource, source);
    assert.deepEqual(stats.items.map(({ userId, sum, average, min, max }) => ({ userId, sum, average, min, max })), [
      { userId: 3, sum: 12, average: 4, min: 2, max: 6 },
      { userId: 4, sum: 30, average: 15, min: 10, max: 20 },
    ]);
    for (const page of [1, 2]) {
      const records = query.hookRecords(access, 'hook-a', { ...filters, page, pageSize: 2 });
      assert.equal(records.total, 5); assert.equal(records.items.length, 2);
      assert.ok(records.items.every((item) => item.workspaceId === 7 && item.occurredAt.startsWith('2026-09-11')));
      assert.deepEqual(query.hookStatistics(access, 'hook-a', { ...filters, groupBy: 'user', page, pageSize: 2 }).items, stats.items);
    }
    const onlyUser = { ...filters, userSearch: 'another' };
    assert.equal(query.hookRecords(access, 'hook-a', onlyUser).total, 2);
    assert.equal(query.hookStatistics(access, 'hook-a', onlyUser).items[0].sum, 30);
    assert.equal(query.hookRecords(access, 'hook-a', { ...filters, workspaceSearch: 'missing' }).total, 0);
    assert.equal(query.hookStatistics(access, 'hook-a', { ...filters, workspaceSearch: 'missing' }).items.length, 0);
    db.exec('UPDATE ai_usage_tenant_state SET data_revision=1 WHERE tenant_id=10');
  }
});

test('Hook business fields group by user ID with weighted daily averages, scoped drilldown and stable pagination', (t) => {
  const { db, queryService: query, accessService, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  db.exec("UPDATE users SET username='同名用户' WHERE id IN (3,4)");
  const samples = [
    { id: 'a', userId: 3, date: '2026-09-11', workspaceId: 7, values: [2] },
    { id: 'b', userId: 3, date: '2026-09-12', workspaceId: 8, values: [4, 6, 8] },
    { id: 'c', userId: 4, date: '2026-09-12', workspaceId: 7, values: [10, 10] },
  ];
  for (const sample of samples) {
    row({ ...sample, dataset: 'hook_daily', subjectId: 'hook-a', value: { ...dimensions, recordCount: sample.values.length, fields: [{ ...field, validCount: sample.values.length, sum: sample.values.reduce((n, value) => n + value, 0), min: Math.min(...sample.values), max: Math.max(...sample.values) }] } });
    for (const [index, value] of sample.values.entries()) row({ ...sample, id: `${sample.id}-${index}`, dataset: 'hook_records', subjectId: 'hook-a', value: { ...dimensions, fields: [{ ...field, value }] } });
  }
  const filters = { groupBy: 'user', sortBy: 'userName', sortDir: 'asc' };
  const result = query.hookFieldStatistics(access, filters);
  assert.equal(result.groupBy, 'user');
  assert.equal(result.aggregationSource, 'daily');
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(({ userId, userName, validCount, sum, average, min, max }) => ({ userId, userName, validCount, sum, average, min, max })), [
    { userId: 3, userName: '同名用户', validCount: 4, sum: 20, average: 5, min: 2, max: 8 },
    { userId: 4, userName: '同名用户', validCount: 2, sum: 20, average: 10, min: 10, max: 10 },
  ]);
  assert.deepEqual([1, 2].flatMap((page) => query.hookFieldStatistics(access, { ...filters, page, pageSize: 1 }).items), result.items);
  assert.equal(query.hookFieldStatistics(access, { groupBy: 'user', sortBy: 'average', sortDir: 'desc', pageSize: 1 }).items[0].userId, 4);
  assert.equal(query.hookFieldStatistics(access, { groupBy: 'hook' }).total, 1);
  assert.equal(query.hookFieldStatistics(access).items[0].userId, undefined);
  assert.equal(query.hookFieldStatistics(access, { ...filters, userId: '3', fieldKey: 'score', search: '会话' }).items[0].validCount, 4);
  assert.equal(query.hookFieldStatistics(access, { ...filters, workspaceId: '8' }).items[0].average, 6);
  assert.equal(query.hookFieldStatistics(access, { ...filters, from: '2026-09-12', userId: '3' }).items[0].validCount, 3);
  const drilldown = { recordUserId: '3', postActionId: 'archive', hookVersion: '1', recordType: 'conversation_record', recordSource: 'post_action' };
  assert.equal(query.hookRecords(access, 'hook-a', drilldown).total, 4);
  assert.ok(query.hookRecords(access, 'hook-a', drilldown).items.every((item) => item.userId === 3));
  assert.equal(query.hookStatistics(access, 'hook-a', drilldown).items[0].average, 5);
  const self = accessService.resolve({ tenantId: 10, userId: 3 });
  assert.deepEqual(query.hookFieldStatistics(self, filters).items.map((item) => item.userId), [3]);
  assert.equal(query.hookRecords(self, 'hook-a', { recordUserId: '4' }).total, 0);
  assert.equal(query.hookStatistics(self, 'hook-a', { recordUserId: '4' }).items.length, 0);
  assert.throws(() => query.hookFieldStatistics(self, { ...filters, userId: '4' }), { statusCode: 403 });
  batch('foreign', 20, 'published', { dataRevision: 0 });
  row({ id: 'foreign', dataset: 'hook_daily', subjectId: 'hook-a', tenantId: 20, batchId: 'foreign', value: { ...dimensions, fields: [{ ...field, validCount: 1, sum: 999, min: 999, max: 999 }] } });
  assert.deepEqual(query.hookFieldStatistics(access, filters).items, result.items);
  assert.throws(() => query.hookFieldStatistics(access, { ...filters, batchId: 'foreign' }), { statusCode: 404 });
  db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'hook_records', 'a-0');
  db.exec('UPDATE ai_usage_tenant_state SET data_revision=1 WHERE tenant_id=10');
  const fallback = query.hookFieldStatistics(access, filters);
  assert.equal(fallback.aggregationSource, 'records');
  assert.equal(fallback.items[0].validCount, 3);
  assert.equal(fallback.items[0].average, 6);
  assert.deepEqual(fallback.items[1], result.items[1]);
});

test('user grouping retains Hook/action/version/unit boundaries and unknown-user drilldown cannot include everyone', (t) => {
  const { queryService: query, access, accessService, batch, row } = fixture(t);
  batch();
  const variants = [{}, { hookId: 'hook-b' }, { postActionId: 'review' }, { hookVersion: 2 }, { unit: '秒' }];
  variants.forEach(({ unit = field.unit, ...patch }, index) => row({ id: `v${index}`, dataset: 'hook_records', subjectId: patch.hookId || 'hook-a', value: { ...dimensions, ...patch, fields: [{ ...field, unit, value: index }] } }));
  row({ id: 'unknown', dataset: 'hook_records', userId: null, subjectId: 'hook-a', value: { ...dimensions, fields: [{ ...field, value: 9 }] } });
  row({ id: 'not-number', dataset: 'hook_records', subjectId: 'hook-a', value: { ...dimensions, fields: [{ ...field, value: '9' }, { ...field, key: 'display', aggregation: 'none', value: 500 }] } });
  assert.equal(query.hookFieldStatistics(access, { groupBy: 'user' }).total, 7);
  assert.equal(query.hookFieldStatistics(access, { groupBy: 'user', fieldKey: 'display' }).items[0].sum, 500);
  const unknown = query.hookFieldStatistics(access, { groupBy: 'user', recordUserId: '__unknown__' });
  assert.equal(unknown.total, 1);
  assert.equal(unknown.items[0].userId, null);
  assert.equal(unknown.items[0].average, 9);
  assert.equal(query.hookRecords(access, 'hook-a', { recordUserId: '__unknown__' }).total, 1);
  const self = accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(query.hookRecords(self, 'hook-a', { recordUserId: '__unknown__' }).total, 0);
  assert.equal(query.hookFieldStatistics(self, { groupBy: 'user' }).total, 6);
  for (const groupBy of ['workspace', '', ['user'], 'user; DROP TABLE users']) assert.throws(() => query.hookFieldStatistics(access, { groupBy }), { code: 'invalidFilter' });
  for (const recordUserId of ['0', '-1', '3 OR 1=1', ['3']]) assert.throws(() => query.hookRecords(access, 'hook-a', { recordUserId }), { code: 'invalidFilter' });
});
