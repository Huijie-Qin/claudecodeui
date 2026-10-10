import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

test('single-Hook report groups filtered numeric fields, combines compatible versions and keeps record parity', (t) => {
  const { db, batch, row, access, accessService, queryService: query } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  db.exec("INSERT INTO workspaces VALUES(7,10,'研发','active'),(8,10,'运营','active')");
  const base = { hookId: 'sql', hookName: 'SQL', postActionId: 'record-sql', recordType: 'sql', recordSource: 'post_action' };
  const fields = (value) => [{ key: 'lines', label: 'SQL 行数', type: 'number', unit: '行', value }, { key: 'note', label: '备注', type: 'string', value: 'safe' }];
  const samples = [
    { id: 'a', userId: 3, workspaceId: 7, date: '2026-09-06', version: 1, values: [2] },
    { id: 'b', userId: 3, workspaceId: 7, date: '2026-09-07', version: 2, values: [4, 6] },
    { id: 'c', userId: 4, workspaceId: 8, date: '2026-09-08', version: 1, values: [10] },
  ];
  for (const sample of samples) {
    const definition = { ...base, hookVersion: sample.version };
    sample.values.forEach((value, index) => row({ ...sample, id: `${sample.id}-${index}`, dataset: 'hook_records', subjectId: 'sql', value: { ...definition, fields: fields(value) } }));
    row({ ...sample, dataset: 'hook_daily', subjectId: 'sql', value: { ...definition, fields: [{ ...fields(0)[0], validCount: sample.values.length, sum: sample.values.reduce((a, b) => a + b, 0), min: Math.min(...sample.values), max: Math.max(...sample.values) }] } });
  }
  const report = (filters = {}, actor = access) => query.hookStatistics(actor, 'sql', filters, true, true);
  for (const expectedSource of ['daily', 'records']) {
    const users = report({ groupBy: 'user', sortDir: 'asc' });
    assert.equal(users.hookReportVersion, 1); assert.equal(users.aggregationSource, expectedSource);
    assert.equal(users.total, 2);
    const member = users.items.find((item) => item.userId === 3);
    assert.deepEqual([member.sum, member.average, member.min, member.max, member.validCount], [12, 4, 2, 6, 3]);
    assert.ok(!Object.hasOwn(member, 'hookVersion'));
    assert.equal(report({ groupBy: 'hook' }).items[0].sum, 22);
    assert.equal(report({ groupBy: 'day' }).total, 3);
    assert.equal(report({ groupBy: 'week' }).total, 2);
    assert.equal(report({ groupBy: 'month' }).total, 1);
    assert.deepEqual(report({ groupBy: 'workspace', sortDir: 'asc' }).items.map((item) => item.groupLabel).sort(), ['研发', '运营']);
    const filter = { groupBy: 'user', userSearch: 'member', workspaceSearch: '研发', from: '2026-09-07', to: '2026-09-08', fieldKey: 'lines' };
    const filtered = report(filter);
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0].sum, 10); assert.equal(filtered.items[0].average, 5);
    assert.equal(query.hookRecords(access, 'sql', filter).total, 2);
    assert.equal(query.hookRecords(access, 'sql', { ...filter, fieldKey: 'note' }).total, 0);
    assert.equal(report({ ...filter, fieldKey: 'note' }).total, 0);
    assert.deepEqual(report({ ...filter, fieldKey: 'missing' }).availableFields, [{ key: 'lines', label: 'SQL 行数', unit: '行' }]);
    const first = report({ groupBy: 'user', sortBy: 'sum', sortDir: 'desc', pageSize: 1 });
    assert.equal(first.items[0].sum, 12); assert.equal(first.total, 2);
    assert.equal(report({ groupBy: 'user', sortBy: 'sum', sortDir: 'desc', pageSize: 1, page: 2 }).items[0].sum, 10);
    const self = accessService.resolve({ userId: 3, tenantId: 10 });
    assert.equal(report({ groupBy: 'workspace' }, self).total, 1);
    assert.equal(report({ groupBy: 'user', userSearch: 'another' }, self).total, 0);
    db.exec('UPDATE ai_usage_tenant_state SET data_revision=1 WHERE tenant_id=10');
  }
  // Different units/actions/record definitions must never share a result.
  for (const [index, patch] of [{ postActionId: 'other' }, { recordType: 'other' }, { recordSource: 'other' }].entries()) {
    row({ id: `split-${index}`, dataset: 'hook_records', subjectId: 'sql', value: { ...base, ...patch, fields: fields(100) } });
  }
  row({ id: 'unit', dataset: 'hook_records', subjectId: 'sql', value: { ...base, fields: [{ ...fields(100)[0], unit: '千行' }] } });
  row({ id: 'another-hook', dataset: 'hook_records', subjectId: 'not-sql', value: { ...base, hookId: 'not-sql', fields: fields(9999) } });
  assert.equal(report({ groupBy: 'hook' }).total, 5);
  assert.throws(() => report({ groupBy: 'provider' }), { statusCode: 400 });
  assert.throws(() => report({ sortBy: 'privateData' }), { statusCode: 400 });
  assert.throws(() => report({ fieldKey: ['lines'] }), { statusCode: 400 });
  assert.throws(() => query.hookRecords(access, 'sql', { fieldKey: ['lines'] }), { statusCode: 400 });
});
