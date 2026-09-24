import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';
import * as XLSX from 'xlsx';

import type { usageRequest } from './client';
import { collectWorkbook, workbookBytes, workbookSpecs, shanghaiExcelTime, type WorkbookSpec } from './reportWorkbook';
import { SavedReportViews } from './savedReportViews';

const t = ((key: string) => key) as TFunction;
const base = { tenantId: 10, batchId: 'published', through: '2026-09-12', codeAvailable: true, t };
const summary = { batchId: base.batchId, summaryVersion: 1, scope: 'tenant', from: '2026-08-14', to: base.through, activityDate: base.through, mauFrom: '2026-08-14', sessionCount: 999, publishedSkillCount: 30, dau: 4, mau: 40 };
const signal = () => new AbortController().signal;

test('all report sheets use independent applied filters, current authorization/batch and saved grouping', () => {
  const views = new SavedReportViews();
  views.set('filters:usage', { queryKey: '', value: { filters: { from: '2026-09-01', to: base.through, userName: '小王' } } });
  views.set('filters:skills', { queryKey: '', value: { filters: { from: '2026-08-20', to: base.through, userName: '发布者' } } });
  views.set('skills', { queryKey: 'old-batch', value: { groupBy: 'publisher', search: 'SQL', draft: 'unapplied' } });
  views.set('hooks', { queryKey: '', value: { nameSearch: 'SQL Hook' } });
  views.set('hook:sql', { queryKey: '', value: { groupBy: 'workspace', metric: 'average', fieldKey: 'lines', hookName: 'SQL', filters: { from: '2026-09-02', to: base.through, workspaceName: '数据' } } });
  const specs = workbookSpecs({ ...base, views });
  assert.equal(specs.length, 6);
  assert.ok(specs.every(spec => spec.params.tenantId === 10 && spec.params.batchId === 'published' && spec.params.scope === 'tenant'));
  assert.equal(specs[0].params.userSearch, '小王');
  assert.equal(specs[1].params.from, '2026-08-14');
  assert.equal(specs[2].params.userSearch, '发布者');
  assert.equal(specs[2].params.search, 'SQL');
  assert.equal(specs[2].params.groupBy, 'publisher');
  assert.equal(specs[3].params.search, 'SQL Hook');
  assert.equal(specs[5].params.workspaceSearch, '数据');
  assert.equal(specs[5].params.fieldKey, 'lines');
  assert.equal(specs[5].metric, 'average');
  assert.ok(specs[0].columns.every(col => col.key !== 'activeUserCount'));
  assert.equal(specs[0].columns.find(col => col.key === 'activeDurationMs')?.exportValue?.({ activeDurationMs: 1250 }), 1.25);
  assert.doesNotMatch(JSON.stringify(specs), /hookExecutions|unapplied|old-batch/);
});

test('workbook includes unvisited tabs, fixed overview, every matching page and trend; numbers stay numeric', async () => {
  const views = new SavedReportViews(); const specs = workbookSpecs({ ...base, views });
  const seen: Record<string, number[]> = {};
  const request = (async (endpoint: string, params: Record<string, unknown> = {}) => {
    if (endpoint === 'capabilities') return { canExport: true, canViewTenant: true };
    if (endpoint === 'summary') { assert.deepEqual(params, { tenantId: 10, scope: 'tenant', batchId: 'published' }); return summary; }
    if (endpoint === 'status') return { batchId: 'published' };
    if (endpoint === 'trend') return { batchId: 'published', items: [{ date: '2026-09-12', sessionCount: 2, dau: 1, mau: 3 }] };
    const id = `${endpoint}:${params.dataset || ''}`; (seen[id] ||= []).push(Number(params.page));
    const total = params.dataset === 'usage' ? 205 : 1;
    const start = (Number(params.page) - 1) * 100;
    return { batchId: 'published', groupBy: params.groupBy, total, includeZeroUsers: true, skillGroupingVersion: 1, codeReportVersion: 1,
      summary: { sessionCount: 205, activeDurationMs: 1250, activeUserCount: 205 },
      items: Array.from({ length: Math.min(100, total - start) }, (_, i) => ({ groupLabel: `用户 ${start + i}`, sessionCount: 1, activeDurationMs: 500, firstPublishedAt: '2026-09-12T01:02:03Z' })) };
  }) as typeof usageRequest;
  const sheets = await collectWorkbook({ ...base, specs, request, signal: signal() });
  assert.equal(sheets.length, 6);
  assert.deepEqual(seen['analysis:usage'], [1, 2, 3]);
  assert.deepEqual(sheets[0].rows[2], ['summarySessions', 999, '2026-08-14', '2026-09-12']);
  assert.equal(sheets[1].rows.filter(row => String(row[0]).startsWith('用户 ')).length, 205);
  assert.deepEqual(sheets[1].rows.find(row => row[0] === '用户 204'), ['用户 204', 1, 0.5]);
  assert.deepEqual(sheets[1].rows.at(-1), ['2026-09-12', 2, 1, 3]);
  const workbook = XLSX.read(await workbookBytes(sheets), { type: 'array', cellNF: true });
  assert.equal(workbook.SheetNames.length, 6);
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[1]], { header: 1 });
  assert.deepEqual(rows.find(row => (row as unknown[])[0] === '用户 204'), ['用户 204', 1, 0.5]);
});

test('permission loss, changed batch, incomplete pages and total limits abort the whole workbook', async () => {
  const spec: WorkbookSpec = { title: 'test', endpoint: 'analysis', params: { tenantId: 10, batchId: 'published', scope: 'tenant', groupBy: 'user' }, columns: [{ key: 'sum', title: '合计' }] };
  for (const failure of ['permission', 'batch', 'page', 'limit']) {
    const request = (async (endpoint: string) => {
      if (endpoint === 'capabilities') return { canExport: failure !== 'permission', canViewTenant: true };
      if (endpoint === 'summary') return summary;
      if (endpoint === 'status') return { batchId: failure === 'batch' ? 'new-batch' : 'published' };
      return { batchId: 'published', groupBy: 'user', total: failure === 'limit' ? 50001 : 1, items: failure === 'page' ? [] : [{ sum: 0 }] };
    }) as typeof usageRequest;
    await assert.rejects(collectWorkbook({ ...base, specs: [spec], request, signal: signal() }), /exportDenied|batchMismatch|exportChanged|exportTooLarge/);
  }
});

test('XLSX preserves zero, null, precision, safe literal names and sortable Shanghai dates', async () => {
  const serial = shanghaiExcelTime('2026-09-12T01:02:03Z');
  assert.equal(serial, shanghaiExcelTime('2026-09-12 09:02:03'));
  assert.equal(shanghaiExcelTime('not-a-date'), null);
  const bytes = await workbookBytes([{ title: '统计/数据', headerRows: [0], dateCells: [{ row: 1, col: 4 }], rows: [
    ['姓名', '零', '缺失', '小数', '上海时间'], ['=HYPERLINK("https://invalid")', 0, null, 1.23456789, serial],
  ] }, { title: '统计/数据', headerRows: [0], rows: [['空表']] }]);
  const book = XLSX.read(bytes, { type: 'array', cellNF: true });
  assert.deepEqual(book.SheetNames, ['统计 数据', '统计 数据 (2)']);
  const sheet = book.Sheets[book.SheetNames[0]];
  assert.equal(sheet.A2.t, 's'); assert.equal(sheet.A2.f, undefined);
  assert.equal(sheet.B2.t, 'n'); assert.equal(sheet.B2.v, 0); assert.equal(sheet.C2, undefined);
  assert.equal(sheet.D2.v, 1.23456789); assert.equal(sheet.E2.w, '2026-09-12 09:02:03');
});
