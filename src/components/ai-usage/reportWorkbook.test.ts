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
  assert.equal(workbook.Sheets.usage.A2.v, 'group.user');
  assert.match(workbook.Sheets.usage.A1.v, /from：2026-08-14/);
  assert.match(workbook.Sheets.usage.A1.v, /sessionCount：205/);
  assert.match(workbook.Sheets.usage.A1.v, /workbook.durationSeconds：1.25/);
  assert.match(workbook.Sheets.usage.A1.v, /activeUserCount：205/);
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
  assert.equal(sheet.B2.t, 'n'); assert.equal(sheet.B2.v, 0); assert.equal(sheet.C2?.v, undefined);
  assert.equal(sheet.B2.w, '0');
  assert.equal(sheet.D2.v, 1.23456789); assert.equal(sheet.E2.w, '2026-09-12 09:02:03');
});

test('plain Excel retains bounded filters, frozen headers, typed dates and print settings without decorative styles', async () => {
  const rows = [['开始日期', '2026-09-01', '结束日期', '2026-09-12'], [], ['会话次数', '活跃人数'], [25, 2], [],
    ['用户名', '会话次数', '时长（秒）'], ...Array.from({ length: 25 }, (_, i) => [`用户 ${i}`, 1, 1.25]), [],
    ['每日趋势'], ['日期', '会话次数'], ['2026-09-12', 25]];
  const bytes = await workbookBytes([{ title: 'AI 使用', rows, headerRows: [5, 33], summaryHeaderRows: [2],
    sectionRows: [32], detailHeaderRow: 5, detailRowCount: 25,
    dateCells: [{ row: 0, col: 1, dateOnly: true }, { row: 0, col: 3, dateOnly: true }, { row: 34, col: 0, dateOnly: true }] }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');
  assert.match(styles, /<fonts count="1">/);
  assert.match(styles, /<fills count="2">/);
  assert.doesNotMatch(styles, /<b\b|<i\b|patternType="solid"|FF294B7A|FFF4F7FC/);
  assert.doesNotMatch(xml, /<tabColor|每日趋势/);
  assert.match(xml, /<mergeCell ref="A1:C1"/);
  assert.match(xml, /showGridLines="1"/);
  assert.match(xml, /ySplit="2" topLeftCell="A3"/);
  assert.match(xml, /<autoFilter ref="A2:C27"/);
  assert.match(xml, /orientation="landscape" fitToWidth="1" fitToHeight="0"/);
  assert.equal((xml.match(/<sheetPr>/g) || []).length, 1);
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets['AI 使用'];
  assert.equal(sheet.A1.v, '开始日期：2026-09-01；结束日期：2026-09-12\n会话次数：25；活跃人数：2');
  assert.deepEqual(sheet['!merges'], [XLSX.utils.decode_range('A1:C1')]);
  assert.equal(sheet['!ref'], 'A1:C30');
  assert.equal(sheet.C3.v, 1.25);
  assert.deepEqual(sheet.A3.s, sheet.A4.s);
  assert.equal(sheet.A30.t, 'n'); assert.equal(sheet.A30.w, '2026-09-12');
  assert.equal(sheet['!rows']![0].hpt, 48);
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
  assert.equal(sheet.B2?.v, undefined);
  assert.ok(sheet['!rows']![1].hpt! > 25);
  assert.ok(sheet['!cols']![0].wch! <= 48);
});

test('long information fits in a single merged cell without exceeding row heights or widening detail columns', async () => {
  const search = '很长的工作区筛选条件'.repeat(60);
  const bytes = await workbookBytes([{ title: '长筛选', rows: [
    ['工作区'], [search], ['日期', '次数'], ['2026-09-12', 0],
  ], metadataHeaderRows: [0], headerRows: [2], detailHeaderRow: 2, detailRowCount: 1,
  dateCells: [{ row: 3, col: 0, dateOnly: true }] }]);
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets['长筛选'];
  assert.equal(sheet.A1.v, `工作区：${search}`);
  assert.equal(sheet['!merges']!.length, 1);
  const merge = sheet['!merges']![0];
  assert.ok(merge.e.r > 0);
  assert.equal(merge.e.c, 1);
  for (const row of sheet['!rows']!) assert.ok(row.hpt! <= 409);
  assert.ok(sheet['!cols']!.every(col => col.wch! <= 18));
  const header = merge.e.r + 2;
  assert.equal(sheet[`A${header}`].v, '日期');
  assert.equal(sheet[`A${header + 1}`].w, '2026-09-12');
  assert.equal(sheet[`B${header + 1}`].v, 0);
  assert.equal(sheet['!autofilter']!.ref, `A${header}:B${header + 1}`);
});

test('empty reports retain literal information, zero, false and readable metadata dates in one cell', async () => {
  const bytes = await workbookBytes([{ title: '空报告', rows: [
    ['名称', '次数', '启用', '日期'], ['=1+1', 0, false, shanghaiExcelTime('2026-09-12T01:02:03Z')],
    ['用户', '次数'],
  ], metadataHeaderRows: [0], dateCells: [{ row: 1, col: 3 }], headerRows: [2], detailHeaderRow: 2, detailRowCount: 0 }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.doesNotMatch(xml, /<pane |<autoFilter/);
  const sheet = XLSX.read(bytes, { type: 'array' }).Sheets['空报告'];
  assert.equal(sheet['!ref'], 'A1:B2');
  assert.equal(sheet.A1.t, 's');
  assert.equal(sheet.A1.f, undefined);
  assert.equal(sheet.A1.v, '名称：=1+1；次数：0；启用：false；日期：2026-09-12 09:02:03');
  assert.equal(sheet.A2.v, '用户');
});

test('information beyond Excel cell capacity is rejected instead of truncated', async () => {
  await assert.rejects(workbookBytes([{ title: '超长筛选', rows: [
    ['名称'], ['x'.repeat(32768)], ['用户'],
  ], metadataHeaderRows: [0], headerRows: [2], detailHeaderRow: 2, detailRowCount: 0 }]), /exportTooLarge/);
});

test('wrapped information and multiline detail strings do not add invalid OOXML whitespace attributes', async () => {
  const bytes = await workbookBytes([{ title: '换行', rows: [
    ['开始日期', '结束日期'], ['2026-09-01', '2026-09-12'], ['用户'], [' 全部 '],
    ['名称', '次数'], [' 第一行\n第二行 ', 0],
  ], metadataHeaderRows: [0, 2], headerRows: [4], detailHeaderRow: 4, detailRowCount: 1 }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.doesNotMatch(xml, /<(?:row|c|v)\b[^>]*\bxml:space=/);
  const sheet = XLSX.read(bytes, { type: 'array' }).Sheets['换行'];
  assert.equal(sheet.A1.v, '开始日期：2026-09-01；结束日期：2026-09-12\n用户： 全部 ');
  assert.equal(sheet.A3.v, ' 第一行\n第二行 ');
});

test('the whole used rectangle has four-sided borders, including missing values and blank separators', async () => {
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
  for (let row = 1; row <= 5; row++) {
    for (const col of ['A', 'B', 'C']) {
      const cell = xml.match(new RegExp(`<c\\b[^>]*r="${col}${row}"[^>]*>`))![0];
      const border = borders[formats[Number(cell.match(/\bs="(\d+)"/)![1])]];
      for (const edge of ['left', 'right', 'top', 'bottom']) assert.ok(border.includes(`<${edge} style="thin">`), `${col}${row}: ${edge}`);
    }
  }
  const sheet = XLSX.read(bytes, { type: 'array', cellStyles: true }).Sheets['边框及行高'];
  for (const row of [2, 3, 4, 5]) assert.equal(sheet['!rows']![row - 1].hpt, 20, `row ${row}`);
  assert.match(sheet.A1.v, /次数：0；时长：1.25；未知：/);
  assert.equal(sheet.B3.v, 0);
  assert.equal(sheet.C3?.v, undefined);
  assert.equal(sheet.C4?.v, undefined);
  assert.match(xml, /<c r="C3" s="\d+"\/>/);
  assert.doesNotMatch(xml, /筛选与汇总|明细/);
  assert.equal(sheet['!ref'], 'A1:C5');
  assert.equal(XLSX.utils.decode_range(sheet['!ref']!).e.c, 2);
});

test('information occupies one wrapping cell above plain details, without report titles or section headings', async () => {
  const bytes = await workbookBytes([{ title: '展示区外框', rows: [
    ['筛选与汇总', '', '', ''], ['日期', '用户'], ['2026-09-12', '全部'], [],
    ['次数', '未知'], [0, null], [], [], ['明细', '', '', ''],
    ['用户', '次数', '时长', '工作区'], ['小王', 0, null, '研发'],
  ], sectionRows: [0, 8], metadataHeaderRows: [1], summaryHeaderRows: [4],
  headerRows: [9], detailHeaderRow: 9, detailRowCount: 1 }]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const borders = [...styles.matchAll(/<border(?:\s[^>]*)?>[\s\S]*?<\/border>|<border\/>/g)].map(match => match[0]);
  const formats = [...styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)![1].matchAll(/<xf\b[^>]*borderId="(\d+)"/g)].map(match => Number(match[1]));
  const hasEdge = (address: string, edge: string) => {
    const cell = xml.match(new RegExp(`<c\\b[^>]*r="${address}"[^>]*>`))?.[0];
    const style = cell?.match(/\bs="(\d+)"/)?.[1];
    return style !== undefined && borders[formats[Number(style)]].includes(`<${edge} style="thin">`);
  };
  for (let row = 1; row <= 3; row++) for (const col of ['A', 'B', 'C', 'D']) {
    for (const edge of ['left', 'right', 'top', 'bottom']) assert.ok(hasEdge(`${col}${row}`, edge));
  }
  assert.doesNotMatch(xml, /展示区外框|筛选与汇总|明细/);
  assert.match(xml, /<autoFilter ref="A2:D3"/);
  assert.match(styles, /horizontal="left" vertical="top" wrapText="1"/);
  const sheet = XLSX.read(bytes, { type: 'array' }).Sheets['展示区外框'];
  assert.equal(sheet['!ref'], 'A1:D3');
  assert.deepEqual(sheet['!merges'], [XLSX.utils.decode_range('A1:D1')]);
  assert.equal(sheet.A1.v, '日期：2026-09-12；用户：全部\n次数：0；未知：');
  assert.equal(sheet.A2.v, '用户');
  assert.equal(sheet.A3.v, '小王');
  assert.equal(sheet.B3.v, 0);
  assert.equal(sheet.C3?.v, undefined);
  assert.equal(sheet.D3.v, '研发');
});

test('plain daily trend preserves all four data columns and remaps dates, filters and frozen headers', async () => {
  const source: WorkbookSheet = { title: 'AI 使用 · 每日趋势', rows: [
    ['筛选与汇总', '', '', ''], ['开始日期', '结束日期', '分组'], ['2026-09-01', '2026-09-30', '日期'],
    ['用户', '工作区', '名称'], ['全部', '全部', '全部'], [], [], ['明细', '', '', ''],
    ['日期', '会话次数', 'DAU', 'MAU'], ...Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, 20, 4, 41]),
  ], sectionRows: [0, 7], metadataHeaderRows: [1, 3], headerRows: [8], detailHeaderRow: 8, detailRowCount: 30,
  dateCells: [{ row: 2, col: 0, dateOnly: true }, { row: 2, col: 1, dateOnly: true },
    ...Array.from({ length: 30 }, (_, i) => ({ row: 9 + i, col: 0, dateOnly: true }))] };
  const original = structuredClone(source);
  const bytes = await workbookBytes([source]);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.doesNotMatch(xml, /筛选与汇总|明细/);
  assert.match(xml, /<mergeCell ref="A1:D1"/);
  assert.match(xml, /<autoFilter ref="A2:D32"/);
  assert.match(xml, /ySplit="2" topLeftCell="A3"/);
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets[source.title];
  assert.equal(sheet['!ref'], 'A1:D32');
  assert.equal(sheet['!cols']!.length, 4);
  assert.equal(sheet.A1.v, '开始日期：2026-09-01；结束日期：2026-09-30；分组：日期\n用户：全部；工作区：全部；名称：全部');
  assert.equal(sheet.A3.t, 'n'); assert.equal(sheet.A3.w, '2026-09-01');
  assert.equal(sheet.A32.w, '2026-09-30');
  assert.equal(sheet.D2.v, 'MAU');
  assert.equal(sheet.D3.v, 41);
  assert.equal(sheet.D32.v, 41);
  assert.deepEqual(source, original);
});

test('plain export removes only marked headings, preserving literal labels, false, zero and empty detail records', async () => {
  const bytes = await workbookBytes([{ title: '报告名', rows: [[], ['字段', '值'], ['明细', false], [], [], ['筛选与汇总', 0]],
    headerRows: [1], detailHeaderRow: 1, detailRowCount: 4 }]);
  const book = XLSX.read(bytes, { type: 'array' });
  const sheet = book.Sheets['报告名'];
  assert.equal(sheet['!ref'], 'A1:B5');
  assert.equal(sheet.A1.v, '字段');
  assert.equal(sheet.A2.v, '明细');
  assert.equal(sheet.B2.v, false);
  assert.equal(sheet.A5.v, '筛选与汇总');
  assert.equal(sheet.B5.v, 0);
  assert.equal(sheet['!autofilter']!.ref, 'A1:B5');
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
  const header = 2;
  assert.ok(xml.includes(`ySplit="${header}" topLeftCell="A${header + 1}"`));
  assert.ok(xml.includes(`<autoFilter ref="A${header}:B${header + 30}"`));
  const book = XLSX.read(bytes, { type: 'array', cellNF: true, cellStyles: true });
  const sheet = book.Sheets['templates · sql'];
  assert.equal(XLSX.utils.decode_range(sheet['!ref']!).e.c, 1);
  assert.equal(sheet['!cols']!.length, 2);
  assert.equal(sheet[`A${header}`].v, 'group.user');
  assert.equal(sheet[`A${header + 1}`].v, '用户 0');
  assert.equal(sheet[`B${header + 1}`].v, 0);
  assert.match(sheet.A1.v, /from：2026-08-14/);
  assert.match(sheet.A1.v, /activeUserCount：29；sessionCount：435/);
  assert.deepEqual(sheet['!merges'], [XLSX.utils.decode_range('A1:B1')]);
  assert.ok(sheet['!rows']![0].hpt! > 100);
  assert.deepEqual(sheet[`A${header + 1}`].s, sheet[`A${header + 2}`].s);
  assert.equal(book.Workbook?.Names?.find(name => name.Name === '_xlnm.Print_Titles')?.Ref, `'templates · sql'!$${header}:$${header}`);
  assert.equal(book.Workbook?.Names?.find(name => name.Name === '_xlnm.Print_Area')?.Ref, `'templates · sql'!$A$1:$B$${header + 30}`);
});
