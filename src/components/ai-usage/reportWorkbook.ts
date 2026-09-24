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
export type WorkbookSheet = {
  title: string; rows: (string | number | boolean | null)[][]; headerRows: number[];
  dateCells?: { row: number; col: number; dateOnly?: boolean }[];
  summaryHeaderRows?: number[]; detailHeaderRow?: number; detailRowCount?: number; sectionRows?: number[];
  metadataHeaderRows?: number[];
};
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

type ReportInfo = { title: string; value: ReturnType<typeof cell>; dateOnly?: boolean };

// Each sheet is self-contained: scope/totals above, an independent detail table
// below. Information wraps within the real detail width, never adding columns.
function reportLayout(title: string, columns: string[], info: ReportInfo[], totals: ReportInfo[], t: TFunction): WorkbookSheet {
  const sheet: WorkbookSheet = { title, rows: [], headerRows: [], dateCells: [],
    sectionRows: [], metadataHeaderRows: [], summaryHeaderRows: [] };
  const section = (label: string) => {
    sheet.sectionRows!.push(sheet.rows.length);
    sheet.rows.push([label, ...Array<string>(Math.max(0, columns.length - 1)).fill('')]);
  };
  section(t('workbook.information'));
  const block = (fields: ReportInfo[], summary: boolean) => {
    const width = Math.max(1, Math.min(columns.length, summary ? columns.length : 3));
    for (let i = 0; i < fields.length; i += width) {
      const part = fields.slice(i, i + width);
      (summary ? sheet.summaryHeaderRows! : sheet.metadataHeaderRows!).push(sheet.rows.length);
      sheet.rows.push(part.map(field => field.title));
      for (const [col, field] of part.entries()) {
        if (field.dateOnly) sheet.dateCells!.push({ row: sheet.rows.length, col, dateOnly: true });
      }
      sheet.rows.push(part.map(field => field.value));
    }
  };
  block(info, false);
  if (totals.length) { sheet.rows.push([]); block(totals, true); }
  sheet.rows.push([], []);
  section(t('workbook.details'));
  sheet.detailHeaderRow = sheet.rows.length;
  sheet.headerRows.push(sheet.detailHeaderRow);
  sheet.rows.push(columns);
  return sheet;
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
  const overview: WorkbookSheet = { title: t('summaryTitle'), headerRows: [1], dateCells: [
    { row: 0, col: 1, dateOnly: true }, ...[2, 3, 4, 5].flatMap(row => [2, 3].map(col => ({ row, col, dateOnly: true }))),
  ], rows: [
    [t('dataThrough'), summary.to], [t('workbook.metric'), t('workbook.value'), t('from'), t('to')],
    [t('summarySessions'), cell(summary.sessionCount), summary.from, summary.to],
    [t('summaryPublications'), cell(summary.publishedSkillCount), null, summary.to],
    [t('dau'), cell(summary.dau), summary.activityDate, summary.activityDate],
    [t('mau'), cell(summary.mau), summary.mauFrom, summary.to],
  ] };
  const sheets: WorkbookSheet[] = [overview];
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
    const info: ReportInfo[] = [
      { title: t('from'), value: cell(spec.params.from), dateOnly: true },
      { title: t('to'), value: cell(spec.params.to), dateOnly: true },
      { title: t('groupBy'), value: t(`group.${spec.params.groupBy}`) },
      { title: t('userName'), value: cell(spec.params.userSearch || t('all')) },
      { title: t('workspaceName'), value: cell(spec.params.workspaceSearch || t('all')) },
      { title: t('search'), value: cell(spec.params.search || t('all')) },
    ];
    if (spec.metric) info.push({ title: t('numberField'), value: cell(spec.params.fieldKey || t('all')) },
      { title: t('workbook.statistic'), value: t(`hookReportFields.${spec.metric === 'average' ? 'avg' : spec.metric}`) });
    let totals: ReportInfo[] = [];
    if (first.summary && spec.metrics) {
      const summary = first.summary;
      // Retain API-provided distinct totals, not sums of already-grouped rows.
      totals = spec.metrics.map(metric => {
        const col = spec.columns.find(col => col.key === metric);
        const value = col?.exportValue ? col.exportValue(summary) : summary[metric];
        return { title: col?.title || t(metric), value: cell(value) };
      });
    }
    const sheet = reportLayout(spec.title, spec.columns.map(col => col.title), info, totals, t);
    const { rows, dateCells } = sheet;
    for (const row of data) {
      const values = spec.columns.map((col, index) => {
        if (['firstPublishedAt', 'lastInvokedAt'].includes(col.key) && row[col.key]) {
          const serial = shanghaiExcelTime(row[col.key]);
          if (serial !== null) dateCells!.push({ row: rows.length, col: index });
          return serial;
        }
        return cell(col.exportValue ? col.exportValue(row) : row[col.key]);
      });
      rows.push(values);
    }
    sheet.detailRowCount = data.length;
    sheets.push(sheet);
    const trend = spec.endpoint === 'analysis' && spec.params.dataset === 'usage'
      ? (await request<UsageList>('trend', spec.params, signal)) : null;
    if (trend) assertPublishedBatch(trend, batchId);
    const trendRows = trend?.items || first.trend;
    if (trendRows?.length) {
      const metrics = spec.endpoint === 'code' ? ['generatedLines', 'submittedLines'] : ['sessionCount', 'dau', 'mau'];
      const trendSheet = reportLayout(`${spec.title} · ${t('workbook.dailyTrend')}`,
        [t('group.day'), ...metrics.map(key => spec.columns.find(col => col.key === key)?.title || t(key))],
        info.map(field => field.title === t('groupBy') ? { ...field, value: t('group.day') } : field), [], t);
      for (const row of trendRows) {
        trendSheet.dateCells!.push({ row: trendSheet.rows.length, col: 0, dateOnly: true });
        trendSheet.rows.push([cell(row.date), ...metrics.map(key => cell(row[key]))]);
      }
      trendSheet.detailRowCount = trendRows.length;
      sheets.push(trendSheet);
    }
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
  const { styledWorkbookBytes } = await import('./reportWorkbookStyle');
  return styledWorkbookBytes(sheets);
}
