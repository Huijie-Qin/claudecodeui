import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

import type { usageRequest } from './client';
import { collectWorkbook, workbookBytes, workbookSpecs, shanghaiExcelTime, type WorkbookSheet, type WorkbookSpec } from './reportWorkbook';
import { SavedReportViews } from './savedReportViews';

const t = ((key: string) => key) as TFunction;
const base = { tenantId: 10, batchId: 'published', through: '2026-09-12', codeAvailable: true, t };
const summary = { batchId: base.batchId, summaryVersion: 1, scope: 'tenant', from: '2026-08-14', to: base.through, activityDate: base.through, mauFrom: '2026-08-14', sessionCount: 999, publishedSkillCount: 30, dau: 4, mau: 40 };
const signal = () => new AbortController().signal;
const metadata = (sheet: WorkbookSheet) => Object.fromEntries((sheet.metadataHeaderRows || [])
  .flatMap(row => sheet.rows[row].map((label, col) => [label, sheet.rows[row + 1][col]])));

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
  assert.equal(sheets.length, 7);
  assert.deepEqual(seen['analysis:usage'], [1, 2, 3]);
  assert.equal(sheets[0].title, 'summaryTitle');
  assert.deepEqual(sheets[0].rows[2], ['summarySessions', 999, '2026-08-14', '2026-09-12']);
  assert.equal(sheets[1].rows.filter(row => String(row[0]).startsWith('用户 ')).length, 205);
  assert.deepEqual(sheets[1].rows.find(row => row[0] === '用户 204'), ['用户 204', 1, 0.5]);
  assert.deepEqual(sheets[1].rows.at(-1), ['用户 204', 1, 0.5]);
  assert.deepEqual(sheets[2].rows.slice(sheets[2].detailHeaderRow), [['group.day', 'sessionCount', 'dau', 'mau'], ['2026-09-12', 2, 1, 3]]);
  assert.deepEqual(sheets[1].rows[sheets[1].summaryHeaderRows![0] + 1], [205, 1.25, 205]);
  for (const sheet of sheets.slice(1)) {
    assert.deepEqual(sheet.headerRows, [sheet.detailHeaderRow]);
    assert.ok(sheet.detailHeaderRow! > 3);
    assert.equal(sheet.rows.length, sheet.detailHeaderRow! + sheet.detailRowCount! + 1);
    assert.equal(sheet.rows[0][0], 'workbook.information');
    assert.equal(sheet.rows[sheet.detailHeaderRow! - 1][0], 'workbook.details');
    assert.deepEqual(sheet.rows.slice(sheet.detailHeaderRow! - 3, sheet.detailHeaderRow! - 1), [[], []]);
  }
  const workbook = XLSX.read(await workbookBytes(sheets), { type: 'array', cellNF: true });
  assert.equal(workbook.SheetNames.length, 7);
  assert.equal(workbook.Sheets.usage[`A${sheets[1].detailHeaderRow! + 4}`].v, 'group.user');
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
  assert.equal(sheet.A5.t, 's'); assert.equal(sheet.A5.f, undefined);
  assert.equal(sheet.B5.t, 'n'); assert.equal(sheet.B5.v, 0); assert.equal(sheet.C5?.v, undefined);
  assert.equal(sheet.B5.w, '0');
  assert.equal(sheet.D5.v, 1.23456789); assert.equal(sheet.E5.w, '2026-09-12 09:02:03');
});

test('Excel has real styles, bounded filters, frozen headers, typed dates and print settings', async () => {
  const rows = [['开始日期', '2026-09-01', '结束日期', '2026-09-12'], [], ['会话次数', '活跃人数'], [25, 2], [],
    ['用户名', '会话次数', '时长（秒）'], ...Array.from({ length: 25 }, (_, i) => [`用户 ${i}`, 1, 1.25]), [],
    ['每日趋势'], ['日期', '会话次数'], ['2026-09-12', 25]];
  const bytes = await workbookBytes([{ title: 'AI 使用', rows, headerRows: [5, 33], summaryHeaderRows: [2],
    sectionRows: [32], detailHeaderRow: 5, detailRowCount: 25,
    dateCells: [{ row: 0, col: 1, dateOnly: true }, { row: 0, col: 3, dateOnly: true }, { row: 34, col: 0, dateOnly: true }] }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');
  assert.match(styles, /<fonts count="5">/);
  assert.match(styles, /FF294B7A/);
  assert.match(styles, /FFF4F7FC/);
  assert.match(xml, /showGridLines="0"/);
  assert.match(xml, /ySplit="9" topLeftCell="A10"/);
  assert.match(xml, /<autoFilter ref="A9:C34"/);
  assert.match(xml, /orientation="landscape" fitToWidth="1" fitToHeight="0"/);
  assert.equal((xml.match(/<sheetPr>/g) || []).length, 1);
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets['AI 使用'];
  assert.equal(sheet.A2.v, 'AI 使用');
  assert.equal(sheet.B4.t, 'n'); assert.equal(sheet.B4.w, '2026-09-01');
  assert.equal(sheet.D4.w, '2026-09-12');
  assert.equal(sheet.C10.v, 1.25);
  assert.notDeepEqual(sheet.A10.s, sheet.A11.s);
  assert.equal(sheet.A38.w, '2026-09-12');
  assert.ok(book.Workbook?.Names?.some(name => name.Name === '_xlnm.Print_Titles'));
  assert.deepEqual(rows[0], ['开始日期', '2026-09-01', '结束日期', '2026-09-12']);
});

test('long names wrap with fitted heights and missing values remain blank', async () => {
  const bytes = await workbookBytes([{ title: 'Empty', rows: [['字段', '数量']], headerRows: [0], detailHeaderRow: 0, detailRowCount: 0 },
    { title: '长字段', rows: [['名称', '数值'], ['较长的工作区名称'.repeat(12), null]], headerRows: [0], detailHeaderRow: 0, detailRowCount: 1 }]);
  const zip = await JSZip.loadAsync(bytes);
  assert.doesNotMatch(await zip.file('xl/worksheets/sheet1.xml')!.async('string'), /<pane |<autoFilter/);
  const book = XLSX.read(bytes, { type: 'array', cellStyles: true });
  const sheet = book.Sheets['长字段'];
  assert.equal(sheet.B5?.v, undefined);
  assert.ok(sheet['!rows']![4].hpt! > 25);
  assert.ok(sheet['!cols']![0].wch! <= 48);
});

test('tables have four-sided borders including blank cells and spacer rows are not compressed', async () => {
  const bytes = await workbookBytes([{ title: '边框及行高', rows: [
    ['筛选与汇总', '', ''], ['开始日期', '结束日期', '用户'], ['2026-09-01', '2026-09-12', '全部'],
    ['工作区', '分组', '名称'], ['全部', '用户', '全部'], [],
    ['次数', '时长', '未知'], [0, 1.25, null], [], [], ['明细', '', ''],
    ['用户', '次数', '时长'], ['小王', 0, null], ['小李', 2], [null, null, null],
  ], sectionRows: [0, 10], summaryHeaderRows: [6], metadataHeaderRows: [1, 3],
  headerRows: [11], detailHeaderRow: 11, detailRowCount: 3 }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const borders = [...styles.matchAll(/<border(?:\s[^>]*)?>[\s\S]*?<\/border>|<border\/>/g)].map(match => match[0]);
  const formats = [...styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)![1].matchAll(/<xf\b[^>]*borderId="(\d+)"/g)].map(match => Number(match[1]));
  for (const row of [10, 11, 15, 16, 17, 18]) {
    for (const col of ['A', 'B', 'C']) {
      const cell = xml.match(new RegExp(`<c\\b[^>]*r="${col}${row}"[^>]*>`))![0];
      const border = borders[formats[Number(cell.match(/\bs="(\d+)"/)![1])]];
      for (const edge of ['left', 'right', 'top', 'bottom']) assert.ok(border.includes(`<${edge} style="thin">`), `${col}${row}: ${edge}`);
    }
  }
  const sheet = XLSX.read(bytes, { type: 'array', cellStyles: true }).Sheets['边框及行高'];
  for (const row of [1, 3, 9, 12, 13]) assert.equal(sheet['!rows']![row - 1].hpt, 20, `row ${row}`);
  assert.equal(sheet.B16.v, 0);
  assert.equal(sheet.C16?.v, undefined);
  assert.equal(sheet.C17?.v, undefined);
  assert.match(xml, /<c r="C16" s="\d+"\/>/);
  assert.equal(XLSX.utils.decode_range(sheet['!ref']!).e.c, 2);
});

test('worksheet print settings precede ignored errors as required by Excel OOXML', async () => {
  // Tolerant readers (including SheetJS) accept out-of-order worksheet children,
  // but Excel can reject or repair those files. Check the serialized ordering.
  const bytes = await workbookBytes([
    { title: '概览', rows: [['指标', '值'], ['会话次数', 30]], headerRows: [0] },
    { title: '空明细', rows: [['用户', '次数']], headerRows: [0], detailHeaderRow: 0, detailRowCount: 0 },
    { title: '明细', rows: [['用户', '次数'], ...Array.from({ length: 30 }, (_, i) => [`用户 ${i}`, i])],
      headerRows: [0], detailHeaderRow: 0, detailRowCount: 30 },
  ]);
  const zip = await JSZip.loadAsync(bytes);
  for (let i = 1; i <= 3; i++) {
    const xml = await zip.file(`xl/worksheets/sheet${i}.xml`)!.async('string');
    const elements = ['sheetPr', 'dimension', 'sheetViews', 'cols', 'sheetData', 'autoFilter', 'pageMargins', 'pageSetup', 'ignoredErrors'];
    const positions = elements.map(name => xml.search(new RegExp(`<${name}\\b`))).filter(pos => pos !== -1);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `sheet${i}: worksheet element order`);
    assert.match(xml, /<pageMargins\b[^>]*\/><pageSetup\b[^>]*\/><ignoredErrors>/);
    assert.equal((xml.match(/<pageSetup\b/g) || []).length, 1);
  }
});

test('each sheet retains its own filters and exact API totals above a separate detail section', async () => {
  const views = new SavedReportViews();
  views.set('filters:usage', { queryKey: '', value: { filters: { from: '2026-09-01', to: base.through, userName: '小王' } } });
  views.set('filters:code', { queryKey: '', value: { filters: { from: '2026-09-02', to: base.through, workspaceName: '研发' } } });
  views.set('hook:sql', { queryKey: '', value: { groupBy: 'workspace', metric: 'average', fieldKey: 'sqlLines', hookName: 'SQL', filters: { from: '2026-09-03', to: base.through, userName: '小李' } } });
  const specs = workbookSpecs({ ...base, views });
  const request = (async (endpoint: string, params: Record<string, unknown> = {}) => {
    if (endpoint === 'capabilities') return { canExport: true, canViewTenant: true };
    if (endpoint === 'summary') return summary;
    if (endpoint === 'status') return { batchId: 'published' };
    if (endpoint === 'trend') return { batchId: 'published', items: [] };
    return { batchId: 'published', groupBy: params.groupBy, total: 1, includeZeroUsers: true,
      skillGroupingVersion: 1, codeReportVersion: 1, hookReportVersion: 1,
      summary: { sessionCount: 8, activeUserCount: 2, activeDurationMs: 1250, generatedLines: 17, submittedLines: 0 },
      items: [{ groupLabel: '小王', sessionCount: 1, activeDurationMs: 1000, average: 2.5, label: 'SQL 行数', key: 'sqlLines' }],
      ...(endpoint === 'code' ? { trend: [{ date: '2026-09-02', generatedLines: 17, submittedLines: 0 }] } : {}) };
  }) as typeof usageRequest;
  const sheets = await collectWorkbook({ ...base, specs, request, signal: signal() });
  for (const spec of specs) {
    const sheet = sheets.find(sheet => sheet.title === spec.title)!;
    const info = metadata(sheet);
    assert.equal(info.from, spec.params.from);
    assert.equal(info.to, spec.params.to);
    assert.equal(info.userName, spec.params.userSearch || 'all');
    assert.equal(info.workspaceName, spec.params.workspaceSearch || 'all');
    assert.ok(sheet.rows.every(row => row.length <= spec.columns.length));
  }
  const usage = sheets.find(sheet => sheet.title === 'usage')!;
  assert.deepEqual(usage.rows[usage.summaryHeaderRows![0] + 1], [8, 1.25, 2]); // Not the sum of the single detail row.
  const hook = sheets.find(sheet => sheet.title.startsWith('SQL ·'))!;
  assert.equal(metadata(hook).numberField, 'sqlLines');
  assert.equal(metadata(hook)['workbook.statistic'], 'hookReportFields.avg');
  const trend = sheets.find(sheet => sheet.title === 'codeReport.tab · workbook.dailyTrend')!;
  assert.deepEqual(trend.rows.at(-1), ['2026-09-02', 17, 0]);
  assert.equal(metadata(trend).groupBy, 'group.day');
  assert.equal(metadata(trend).workspaceName, '研发');
  assert.equal(sheets[0].rows.length, 6); // Fixed overview only, not consolidated tab summaries.
});

test('narrow sheets wrap information without adding blank columns and filters cover only details', async () => {
  const views = new SavedReportViews();
  views.set('template:sql', { queryKey: '', value: { groupBy: 'user' } });
  const specs = workbookSpecs({ ...base, views }).filter(spec => spec.params.templateId === 'sql');
  assert.equal(specs[0].columns.length, 2);
  const request = (async (endpoint: string) => {
    if (endpoint === 'capabilities') return { canExport: true, canViewTenant: true };
    if (endpoint === 'summary') return summary;
    if (endpoint === 'status') return { batchId: 'published' };
    return { batchId: 'published', groupBy: 'user', total: 30,
      summary: { activeUserCount: 29, sessionCount: 435 },
      items: Array.from({ length: 30 }, (_, i) => ({ groupLabel: `用户 ${i}`, sessionCount: i })) };
  }) as typeof usageRequest;
  const sheets = await collectWorkbook({ ...base, specs, request, signal: signal() });
  const report = sheets[1];
  assert.ok(report.rows.every(row => row.length <= 2));
  const bytes = await workbookBytes([report]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const header = report.detailHeaderRow! + 4;
  assert.ok(xml.includes(`ySplit="${header}" topLeftCell="A${header + 1}"`));
  assert.ok(xml.includes(`<autoFilter ref="A${header}:B${header + 30}"`));
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets['templates · sql'];
  assert.equal(XLSX.utils.decode_range(sheet['!ref']!).e.c, 1);
  assert.equal(sheet['!cols']!.length, 2);
  assert.equal(sheet[`A${header}`].v, 'group.user');
  assert.equal(sheet[`A${header + 1}`].v, '用户 0');
  assert.equal(sheet[`B${header + 1}`].v, 0);
  assert.equal(sheet.A6.t, 'n'); assert.equal(sheet.A6.w, '2026-08-14');
  assert.notDeepEqual(sheet[`A${header + 1}`].s, sheet[`A${header + 2}`].s);
  assert.equal(book.Workbook?.Names?.find(name => name.Name === '_xlnm.Print_Titles')?.Ref, `'templates · sql'!$${header}:$${header}`);
  assert.equal(book.Workbook?.Names?.find(name => name.Name === '_xlnm.Print_Area')?.Ref, `'templates · sql'!$A$1:$B$${header + 30}`);
});
