import test from 'node:test';
import assert from 'node:assert/strict';
import type { usageRequest } from './client';
import { sqlCodeFacts, loadSqlCodeFacts } from './sqlCodeData';
import { groupDemoCode, summarizeDemoCode } from './demoCodeData';
import type { UsageRow } from './types';

function record(id: number, value: unknown = 50): UsageRow {
  return { id: `sql-${id}`, hookId: 'hook-sql', occurredAt: '2026-09-11T18:00:00Z', userId: id % 40,
    userName: `用户 ${id % 40}`, workspaceId: id % 5, workspaceName: `工作区 ${id % 5}`,
    fields: [{ key: 'sqlLineCount', type: 'number', value }, { key: 'statementCount', type: 'number', value: 999 }] } as UsageRow;
}
test('generated lines only sum the typed SQL line field and use the report timezone', () => {
  const rows = sqlCodeFacts([record(0), record(1, 0), record(2, '40'), record(3, null), record(4, NaN),
    { ...record(5), hookId: 'another-hook' }, { ...record(6), fields: [{ key: 'qualityScore', value: 100 }] }], 'Asia/Shanghai');
  assert.equal(rows.length, 2);
  assert.equal(summarizeDemoCode(rows).generatedLines, 50);
  assert.equal(rows[0].date, '2026-09-12');
  assert.equal(rows[0].repository, '');
  assert.throws(() => sqlCodeFacts([{ ...record(1), fieldsUnavailable: true }], 'Asia/Shanghai'));
});
test('load all 400 matching SQL records, pin the batch and forward shared filters', async () => {
  const requests: Record<string, unknown>[] = [];
  const request = (async (endpoint: string, params: Record<string, unknown>) => {
    requests.push(params); assert.equal(endpoint, 'hooks/hook-sql/records');
    return { batchId: 'b1', total: 400, items: Array.from({ length: 100 }, (_, i) => record((Number(params.page) - 1) * 100 + i)) };
  }) as typeof usageRequest;
  const rows = await loadSqlCodeFacts({ tenantId: 10, scope: 'tenant', batchId: 'b1', from: '2026-09-01', to: '2026-09-12', userSearch: '用户', workspaceSearch: '工作区' }, new AbortController().signal, request, 'Asia/Shanghai');
  assert.equal(requests.length, 4);
  assert.equal(rows.length, 400);
  assert.equal(summarizeDemoCode(rows).generatedLines, 20_000);
  for (const params of requests) {
    assert.equal(params.batchId, 'b1'); assert.equal(params.userSearch, '用户'); assert.equal(params.workspaceSearch, '工作区');
    assert.equal(params.from, '2026-09-01'); assert.equal(params.to, '2026-09-12');
  }
  for (const group of ['user', 'workspace', 'day', 'week', 'month'] as const) {
    assert.equal(groupDemoCode(rows, group).reduce((n, row) => n + row.generatedLines, 0), 20_000);
  }
});
test('SQL loader rejects changed batches, missing pages, duplicates and cancellation', async () => {
  for (const response of [
    { batchId: 'b2', total: 1, items: [record(1)] },
    { batchId: 'b1', total: 2, items: [record(1)] },
    { batchId: 'b1', total: 2, items: [record(1), record(1)] },
  ]) {
    await assert.rejects(loadSqlCodeFacts({ batchId: 'b1' }, new AbortController().signal, (async () => response) as typeof usageRequest, 'Asia/Shanghai'));
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(loadSqlCodeFacts({ batchId: 'b1' }, abort.signal, (() => assert.fail('Must not fetch after cancellation')) as typeof usageRequest, 'Asia/Shanghai'));
});
test('users with identical names remain separate and workspace labels include every membership', () => {
  const records = [record(1), { ...record(2), userName: '用户 1' }, { ...record(3), userId: 1, userName: '用户 1' }];
  const rows = groupDemoCode(sqlCodeFacts(records, 'Asia/Shanghai'), 'user');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.groupKey === '1')?.generatedLines, 100);
  assert.equal(rows.find(row => row.groupKey === '1')?.workspaceName, '工作区 1、工作区 3');
});
