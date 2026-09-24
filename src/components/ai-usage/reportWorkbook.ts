import type { TFunction } from 'i18next';

import { analysisGroups, analysisMetrics, defaultReportSort, visibleAnalysisMetrics, visibleAnalysisSort } from './analysisState';
import type { usageRequest } from './client';
import { usageFilterParams, type UsageFilters } from './filterState';
import { reportGroupLabel } from './groupingState';
import { collectExportRows, maxExportRows } from './reportExport';
import type { ReportColumn, ReportSort } from './ReportTable';
import type { ReportViewStore } from './reportViewState';
import { savedFilters } from './savedReportViews';
import { assertUsageSummary, type UsageSummary } from './summaryState';
import type { AnalysisTab, UsageCapabilities, UsageList, UsageRow } from './types';
import { assertPublishedBatch } from './usageUtils';

export type WorkbookSpec = { title: string; endpoint: string; params: Record<string, unknown>; columns: ReportColumn[]; metrics?: string[]; metric?: string };
export type WorkbookSheet = { title: string; rows: (string | number | boolean | null)[][]; headerRows: number[]; dateCells?: { row: number; col: number }[] };
type ListResult = UsageList & { summary?: UsageRow; trend?: UsageRow[]; includeZeroUsers?: boolean; skillGroupingVersion?: number; codeReportVersion?: number; hookReportVersion?: number };
type Tab = 'usage' | 'code' | 'skills' | 'hooks' | 'templates';

export function workbookSpecs({ tenantId, batchId, through, views, codeAvailable, t }: {
  tenantId: number; batchId: string; through: string; views: ReportViewStore; codeAvailable: boolean; t: TFunction;
}): WorkbookSpec[] {
  const filter = (tab: Tab) => savedFilters(views.get(`filters:${tab}`)?.value.filters, through);
  const base = (tab: Tab, ownFilters?: UsageFilters) => ({ tenantId, scope: 'tenant', batchId, ...usageFilterParams(ownFilters || filter(tab)) });
  const column = (key: string, title = t(key)): ReportColumn => ({ key, title });
  const labelColumn = (group: string, filters: Record<string, unknown>) => ({ key: 'groupLabel', title: t(`group.${group}`), exportValue: (row: UsageRow) => reportGroupLabel(group, row.groupLabel, filters) });
  const analysis = (tab: AnalysisTab, key: string = tab, templateId?: string): WorkbookSpec => {
    const saved = views.get(key)?.value || {};
    const options = templateId ? ['user', 'workspace', 'day', 'week', 'month'] : analysisGroups[tab];
    const groupBy = options.includes(String(saved.groupBy) as never) ? String(saved.groupBy) : options[0];
    const sort = visibleAnalysisSort(tab, groupBy, (saved.sort || defaultReportSort(tab)) as ReportSort);
    const params = { ...base(tab as Tab), dataset: tab, groupBy, ...sort,
      ...(templateId ? { templateId } : {}), ...(tab !== 'usage' ? { search: String(saved.nameSearch || '') } : {}),
      ...(tab === 'usage' && groupBy === 'user' ? { includeZeroUsers: true } : {}) };
    const metricColumn = (key: string) => key === 'activeDurationMs'
      ? { key, title: t('workbook.durationSeconds'), exportValue: (row: UsageRow) => typeof row[key] === 'number' ? row[key] / 1000 : null }
      : column(key, t(tab === 'hooks' && key === 'activeUserCount' ? 'recordUserCount' : key));
    return { title: t(tab), endpoint: 'analysis', params, columns: [labelColumn(groupBy, params), ...visibleAnalysisMetrics(tab, groupBy).map(metricColumn)], metrics: [...analysisMetrics[tab]] };
  };
  const specs = [analysis('usage')];
  if (codeAvailable) {
    const saved = views.get('code')?.value || {};
    const groupBy = ['user', 'workspace', 'day', 'week', 'month'].includes(String(saved.groupBy)) ? String(saved.groupBy) : 'user';
    const params = { ...base('code'), groupBy, ...((saved.sort || { sortBy: 'generatedLines', sortDir: 'desc' }) as ReportSort) };
    specs.push({ title: t('codeReport.tab'), endpoint: 'code', params,
      columns: [labelColumn(groupBy, params), column('generatedLines', t('codeReport.generated')), column('submittedLines', t('codeReport.realSubmitted'))], metrics: ['generatedLines', 'submittedLines'] });
  }
  const skill = views.get('skills')?.value || {};
  const groupBy = skill.groupBy === 'publisher' ? 'publisher' : 'skill';
  specs.push({ title: t('skillsTitle'), endpoint: 'skills', params: { ...base('skills'), groupBy, ...((skill.sort || defaultReportSort('skills')) as ReportSort), search: String(skill.search || '') },
    columns: [
      ...(groupBy === 'skill' ? [column('skillName')] : []), column('publisherName', t('publisher')),
      ...(groupBy === 'skill' ? [column('firstPublishedAt')] : []),
      column('publishedSkillCount', t('periodPublishedSkills')), column('invocationCount', t('skillInvocationCount')), column('callerCount'), column('lastInvokedAt'),
    ], metrics: ['publishedSkillCount', 'invocationCount', 'callerCount'] });
  specs.push(analysis('hooks'), analysis('templates'));
  for (const [key, entry] of views) {
    if (key.startsWith('hook:')) {
      const saved = entry.value;
      const hookId = key.slice(5);
      const groupBy = ['user', 'workspace', 'day', 'week', 'month', 'hook'].includes(String(saved.groupBy)) ? String(saved.groupBy) : 'user';
      const metric = ['sum', 'average', 'min', 'max'].includes(String(saved.metric)) ? String(saved.metric) : 'sum';
      const params = { ...base('hooks', savedFilters(saved.filters, through)), groupBy, fieldKey: String(saved.fieldKey || ''),
        ...((saved.statsSort || { sortBy: 'groupLabel', sortDir: 'asc' }) as ReportSort) };
      specs.push({ title: `${saved.hookName || hookId} · ${t('hookNumericResults')}`, endpoint: `hooks/${encodeURIComponent(hookId)}/field-statistics`, params, metric,
        columns: [...(groupBy === 'hook' ? [] : [labelColumn(groupBy, params)]), column('label', t('field')), column('key', t('workbook.fieldKey')), column('postActionId', t('postAction')),
          column(metric, `${t('fieldResult')} · ${t(`hookReportFields.${metric === 'average' ? 'avg' : metric}`)}`)] });
    } else if (key.startsWith('template:')) {
      const spec = analysis('templates', key, key.slice(9));
      specs.push({ ...spec, title: `${t('templates')} · ${key.slice(9)}` });
    }
  }
  return specs;
}

function cell(value: unknown): string | number | boolean | null {
  return typeof value === 'number' ? Number.isFinite(value) ? value : null
    : typeof value === 'string' || typeof value === 'boolean' ? value : null;
}

export async function collectWorkbook({ specs, tenantId, batchId, request, signal, t, onProgress }: {
  specs: WorkbookSpec[]; tenantId: number; batchId: string; request: typeof usageRequest; signal: AbortSignal; t: TFunction;
  onProgress?: (sheet: string, count: number) => void;
}): Promise<WorkbookSheet[]> {
  const authorize = async () => {
    signal.throwIfAborted();
    const access = await request<UsageCapabilities>('capabilities', { tenantId }, signal);
    signal.throwIfAborted();
    if (!access.canExport || !access.canViewTenant) throw new Error('exportDenied');
  };
  await authorize();
  const summary = assertUsageSummary(await request<UsageSummary>('summary', { tenantId, scope: 'tenant', batchId }, signal), batchId, 'tenant');
  const sheets: WorkbookSheet[] = [{ title: t('summaryTitle'), headerRows: [1], rows: [
    [t('dataThrough'), summary.to], [t('workbook.metric'), t('workbook.value'), t('from'), t('to')],
    [t('summarySessions'), cell(summary.sessionCount), summary.from, summary.to],
    [t('summaryPublications'), cell(summary.publishedSkillCount), null, summary.to],
    [t('dau'), cell(summary.dau), summary.activityDate, summary.activityDate],
    [t('mau'), cell(summary.mau), summary.mauFrom, summary.to],
  ] }];
  let count = 0;
  for (const spec of specs) {
    signal.throwIfAborted();
    const first = await request<ListResult>(spec.endpoint, { ...spec.params, page: 1, pageSize: 100 }, signal);
    assertPublishedBatch(first, batchId);
    if ((spec.params.includeZeroUsers && first.includeZeroUsers !== true)
      || (spec.endpoint === 'skills' && first.skillGroupingVersion !== 1)
      || (spec.endpoint === 'code' && first.codeReportVersion !== 1)
      || (spec.endpoint.endsWith('/field-statistics') && first.hookReportVersion !== 1)) throw new Error('exportChanged');
    count += first.total;
    if (count > maxExportRows) throw new Error('exportTooLarge');
    // Reuse the first page without weakening pagination/batch/permission checks.
    const fetchPage: typeof usageRequest = async <T,>(endpoint: string, params: Record<string, unknown> = {}, abort?: AbortSignal) =>
      endpoint === spec.endpoint && params.page === 1 ? first as T : request<T>(endpoint, params, abort);
    const data = await collectExportRows({ endpoint: spec.endpoint, params: spec.params, total: first.total, signal, request: fetchPage, onProgress: n => onProgress?.(spec.title, n) });
    const rows: WorkbookSheet['rows'] = [
      [t('from'), cell(spec.params.from), t('to'), cell(spec.params.to)],
      [t('userName'), cell(spec.params.userSearch || t('all')), t('workspaceName'), cell(spec.params.workspaceSearch || t('all'))],
      [t('groupBy'), t(`group.${spec.params.groupBy}`), t('search'), cell(spec.params.search || t('all'))],
    ];
    if (spec.metric) rows.push([t('numberField'), cell(spec.params.fieldKey || t('all')), t('workbook.statistic'), t(`hookReportFields.${spec.metric === 'average' ? 'avg' : spec.metric}`)]);
    const headerRows: number[] = [];
    if (first.summary && spec.metrics) {
      rows.push([]); headerRows.push(rows.length); rows.push([t('workbook.metric'), t('workbook.value')]);
      for (const metric of spec.metrics) {
        const col = spec.columns.find(col => col.key === metric);
        const value = col?.exportValue ? col.exportValue(first.summary) : first.summary[metric];
        rows.push([col?.title || t(metric), cell(value)]);
      }
    }
    rows.push([]); headerRows.push(rows.length); rows.push(spec.columns.map(col => col.title));
    const dateCells: { row: number; col: number }[] = [];
    for (const row of data) {
      const values = spec.columns.map((col, index) => {
        if (['firstPublishedAt', 'lastInvokedAt'].includes(col.key) && row[col.key]) {
          const serial = shanghaiExcelTime(row[col.key]);
          if (serial !== null) dateCells.push({ row: rows.length, col: index });
          return serial;
        }
        return cell(col.exportValue ? col.exportValue(row) : row[col.key]);
      });
      rows.push(values);
    }
    const trend = spec.endpoint === 'analysis' && spec.params.dataset === 'usage'
      ? (await request<UsageList>('trend', spec.params, signal)) : null;
    if (trend) assertPublishedBatch(trend, batchId);
    const trendRows = trend?.items || first.trend;
    if (trendRows?.length) {
      const metrics = spec.endpoint === 'code' ? ['generatedLines', 'submittedLines'] : ['sessionCount', 'dau', 'mau'];
      rows.push([]); headerRows.push(rows.length); rows.push([t('group.day'), ...metrics.map(key => spec.columns.find(col => col.key === key)?.title || t(key))]);
      for (const row of trendRows) rows.push([cell(row.date), ...metrics.map(key => cell(row[key]))]);
    }
    sheets.push({ title: spec.title, rows, headerRows, dateCells });
  }
  // Never emit a partial or cross-batch workbook, even if publishing happens near the end.
  const status = await request<{ batchId: string }>('status', { tenantId, scope: 'tenant' }, signal);
  assertPublishedBatch(status, batchId);
  await authorize();
  return sheets;
}

// Excel has no timezone; store Shanghai wall time as a sortable numeric date.
export function shanghaiExcelTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}+08:00`;
  const time = Date.parse(zoned);
  return Number.isFinite(time) ? (time + 8 * 60 * 60 * 1000) / 86_400_000 + 25569 : null;
}

export async function workbookBytes(sheets: WorkbookSheet[]): Promise<ArrayBuffer> {
  if (new TextEncoder().encode(JSON.stringify(sheets)).length > 10 * 1024 * 1024) throw new Error('exportTooLarge');
  const XLSX = await import('xlsx');
  const book = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const sheet of sheets) {
    const base = sheet.title.replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').slice(0, 31) || 'Report';
    let name = base;
    for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${base.slice(0, 26)} (${suffix})`;
    used.add(name.toLowerCase());
    // aoa_to_sheet creates literal strings, not formulas, for untrusted labels.
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    const width = Math.max(...sheet.rows.map(row => row.length));
    ws['!cols'] = Array.from({ length: width }, (_, col) => ({ wch: Math.min(48, Math.max(16, ...sheet.rows.map(row => {
      const value = row[col];
      return typeof value === 'number' ? 16 : [...String(value ?? '')].reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0) + 2;
    }))) }));
    ws['!rows'] = sheet.rows.map((_, row) => ({ hpt: sheet.headerRows.includes(row) ? 26 : 22 }));
    for (const key of Object.keys(ws).filter(key => !key.startsWith('!'))) if (ws[key].t === 'n') ws[key].z = '#,##0.########';
    for (const { row, col } of sheet.dateCells || []) ws[XLSX.utils.encode_cell({ r: row, c: col })].z = 'yyyy-mm-dd hh:mm:ss';
    XLSX.utils.book_append_sheet(book, ws, name);
  }
  return XLSX.write(book, { bookType: 'xlsx', type: 'array', compression: true });
}
