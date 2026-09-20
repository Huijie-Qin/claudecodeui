import assert from 'node:assert/strict';
import test from 'node:test';

import type { usageRequest } from './client';
import { collectExportRows, csvCell, maxExportRows, reportCsv, reportExportFilename } from './reportExport';

const base = { tenantId: 10, scope: 'tenant', batchId: 'published', from: '2026-08-14', to: '2026-09-12', groupBy: 'user', userSearch: '小王', workspaceSearch: '研发', fieldKey: 'lines', sortBy: 'sum', sortDir: 'desc', page: 3, pageSize: 20 };
const access = { canExport: true, canViewTenant: true };
const signal = () => new AbortController().signal;

test('exports every matching page in current filter/group/sort scope, pinning the batch', async () => {
  const source = Array.from({ length: 205 }, (_, index) => ({ userName: `用户 ${index}`, sum: 205 - index }));
  const calls: Array<{ path: string; params: Record<string, unknown> }> = [];
  const request = (async (path: string, params: Record<string, unknown>) => {
    calls.push({ path, params });
    if (path === 'capabilities') return access;
    assert.deepEqual(params, { ...base, page: Number(params.page), pageSize: 100 });
    const start = (Number(params.page) - 1) * 100;
    return { batchId: 'published', groupBy: 'user', total: source.length, items: source.slice(start, start + 100) };
  }) as typeof usageRequest;
  const progress: number[] = [];
  const rows = await collectExportRows({ endpoint: 'hooks/sql/field-statistics', params: base, total: 205, request, signal: signal(), onProgress: (count) => progress.push(count) });
  assert.deepEqual(rows, source);
  assert.deepEqual(progress, [100, 200, 205]);
  assert.deepEqual(calls.map(({ path }) => path), ['capabilities', 'hooks/sql/field-statistics', 'hooks/sql/field-statistics', 'hooks/sql/field-statistics', 'capabilities']);
});

test('empty results produce a header-only CSV, not fabricated zero rows', async () => {
  const request = (async (path: string) => path === 'capabilities' ? access : { batchId: 'published', groupBy: 'user', total: 0, items: [] }) as typeof usageRequest;
  const rows = await collectExportRows({ endpoint: 'analysis', params: base, total: 0, request, signal: signal() });
  assert.deepEqual(rows, []);
  assert.equal(reportCsv([{ key: 'sum', title: '统计结果 · 求和' }], rows), '\uFEFF"统计结果 · 求和"\r\n');
});

test('changed batch, total, grouping and missing page rows abort export', async () => {
  for (const patch of [{ batchId: 'different' }, { total: 2 }, { groupBy: 'workspace' }, { items: [] }]) {
    const request = (async (path: string) => path === 'capabilities' ? access : { batchId: 'published', groupBy: 'user', total: 1, items: [{ sum: 1 }], ...patch }) as typeof usageRequest;
    await assert.rejects(collectExportRows({ endpoint: 'analysis', params: base, total: 1, request, signal: signal() }), /batchMismatch|exportChanged/);
  }
});

test('denied or revoked export permissions do not return downloadable rows', async () => {
  for (const revokeAfter of [0, 1]) {
    let permissions = 0;
    const request = (async (path: string) => path === 'capabilities' ? { ...access, canExport: permissions++ < revokeAfter } : { batchId: 'published', groupBy: 'user', total: 1, items: [{ sum: 1 }] }) as typeof usageRequest;
    await assert.rejects(collectExportRows({ endpoint: 'analysis', params: base, total: 1, request, signal: signal() }), /exportDenied/);
  }
});

test('cancellation and bounds never silently truncate a file', async () => {
  const controller = new AbortController(); controller.abort();
  const request = (async () => { throw Error('must not fetch'); }) as typeof usageRequest;
  await assert.rejects(collectExportRows({ endpoint: 'analysis', params: base, total: 1, request, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(collectExportRows({ endpoint: 'analysis', params: base, total: maxExportRows + 1, request, signal: signal() }), /exportTooLarge/);
  assert.throws(() => reportCsv([{ key: 'text', title: '文本' }], [{ text: 'a'.repeat(10 * 1024 * 1024) }]), /exportTooLarge/);
});

test('CSV preserves Chinese, numeric precision, zero, missing values and only selected visible columns', () => {
  const csv = reportCsv([
    { key: 'userName', title: '用户' }, { key: 'average', title: '统计结果 · 平均值' },
    { key: 'duration', title: '耗时', exportValue: () => '500 ms' }, { key: 'records', title: '' },
  ], [{ userName: '小王', average: 1.23456789, sum: 99, unit: '条', records: '查看记录' }, { userName: '小李', average: 0 }, { userName: '未知', average: null }]);
  assert.equal(csv, '\uFEFF"用户","统计结果 · 平均值","耗时"\r\n"小王","1.23456789","500 ms"\r\n"小李","0","500 ms"\r\n"未知","—","500 ms"\r\n');
  assert.doesNotMatch(csv, /条|99|查看记录/);
});

test('CSV quotes separators, escapes quotes, and neutralizes formula-like text without corrupting negative numbers', () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  for (const value of ['=1+1', '+cmd', '-2+3', '@SUM(1)', ' \t=1', '\r\n+1']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell(-2.5), '"-2.5"');
  assert.equal(csvCell(false), '"false"');
  assert.equal(csvCell({ secret: true }), '"—"');
  assert.equal(csvCell(Infinity), '"—"');
});

test('download names retain report/date/group context and exclude path/control characters', () => {
  const name = reportExportFilename('../SQL/统计:求和', base);
  assert.match(name, /SQL_统计_求和_2026-08-14_2026-09-12_user\.csv$/);
  assert.doesNotMatch(name, /[/:\\\r\n]/);
});
