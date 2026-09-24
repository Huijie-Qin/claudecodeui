import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hash } from 'lucide-react';

import { Button } from '../../shared/view/ui';

import MetricDefinition from './MetricDefinition';
import { useMetricDefinitions } from './metricDefinitionAccess';
import { nextReportSort } from './analysisState';
import { useReportView } from './ReportViewContext';
import { savedFilters } from './savedReportViews';
import { usageRequest } from './client';
import { usageFilterParams, type UsageFilters } from './filterState';
import { hookNumberColumns } from './HookNumberColumns';
import HookStatisticSelect from './HookStatisticSelect';
import ReportGrouping from './ReportGrouping';
import ReportSelect from './ReportSelect';
import { isTimeGroup, reportGroupLabel } from './groupingState';
import { ReportPagination, ReportTable, type ReportColumn, type ReportSort } from './ReportTable';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { assertPublishedBatch, displayReportValue as display, formatReportTimestamp, hookStatisticSort, reportFields, reportUserName, reportWorkspaceName, validateUsageRange, type HookNumberMetric } from './usageUtils';
import type { UsageList, UsageRow } from './types';

const inputClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/30';
const sectionClass = 'ai-report-panel overflow-hidden rounded-xl border border-border bg-card';
const groups = ['user', 'workspace', 'day', 'week', 'month', 'hook'] as const;
type Statistics = UsageList & { hookReportVersion?: number; availableFields?: { key: string; label: string; unit?: string }[] };

export default function HookReportPanel({ row, params, through, onAccessError }: {
  row: UsageRow; params: Record<string, unknown>; through: string; onAccessError: () => void;
}) {
  const { t, i18n } = useTranslation('aiUsage');
  const showDefinitions = useMetricDefinitions();
  const initialFilters: UsageFilters = { from: String(params.from || ''), to: String(params.to || ''), userName: String(params.userSearch || ''), workspaceName: String(params.workspaceSearch || '') };
  const [saved, setSaved] = useReportView(`hook:${row.hookId}`, JSON.stringify(params), {
    page: 1, filters: initialFilters, groupBy: 'user' as typeof groups[number], metric: 'sum' as HookNumberMetric, fieldKey: '',
    hookId: String(row.hookId), hookName: row.hookName || String(row.hookId),
    statsSort: { sortBy: 'groupLabel', sortDir: 'asc' } as ReportSort,
    recordSort: { sortBy: 'occurredAt', sortDir: 'desc' } as ReportSort,
  });
  const [filters, setFilters] = useState(() => savedFilters(saved.filters, through));
  const [draft, setDraft] = useState(filters);
  const [groupBy, setGroupBy] = useState<typeof groups[number]>(saved.groupBy);
  const [metric, setMetric] = useState<HookNumberMetric>(saved.metric);
  const [fieldKey, setFieldKey] = useState(saved.fieldKey);
  const [statsPage, setStatsPage] = useState(1);
  const [recordsPage, setRecordsPage] = useState(1);
  const [statsSort, setStatsSort] = useState<ReportSort>(saved.statsSort);
  const [recordSort, setRecordSort] = useState<ReportSort>(saved.recordSort);
  const [data, setData] = useState<{ statistics: Statistics; records: UsageList } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rangeError, setRangeError] = useState('');
  const queryKey = JSON.stringify({ tenantId: params.tenantId, scope: params.scope, batchId: params.batchId, ...usageFilterParams(filters), fieldKey });
  const id = encodeURIComponent(String(row.hookId));
  useEffect(() => {
    const controller = new AbortController();
    const query = JSON.parse(queryKey);
    setLoading(true); setData(null); setError('');
    void Promise.all([
      usageRequest<Statistics>(`hooks/${id}/field-statistics`, { ...query, groupBy, ...statsSort, page: statsPage, pageSize: 20 }, controller.signal),
      usageRequest<UsageList>(`hooks/${id}/records`, { ...query, ...recordSort, page: recordsPage, pageSize: 20 }, controller.signal),
    ]).then(([statistics, records]) => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(statistics, String(query.batchId)); assertPublishedBatch(records, String(query.batchId));
      if (statistics.hookReportVersion !== 1 || statistics.groupBy !== groupBy) throw new Error('hookNumbersUnavailable');
      setData({ statistics, records });
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'hookNumbersUnavailable' ? caught.message : 'requestFailed'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, id, groupBy, statsSort, recordSort, statsPage, recordsPage, onAccessError]);
  useEffect(() => { setSaved(old => ({ ...old, filters, groupBy, metric, fieldKey, statsSort, recordSort })); }, [filters, groupBy, metric, fieldKey, statsSort, recordSort, setSaved]);
  const resetPages = () => { setStatsPage(1); setRecordsPage(1); };
  const fields = Array.from(new Map((data?.statistics.availableFields || []).map((field) => [field.key, field])).values());
  const businessColumns = Array.from(new Map((data?.records.items || []).flatMap((item) => reportFields(item.fields)).map((field) => [field.key, field])).values())
    .filter((field) => !fieldKey || field.key === fieldKey).map((field) => ({ key: `field:${field.key}`, title: field.label,
      render: (item: UsageRow) => display(reportFields(item.fields).find((value) => value.key === field.key)?.value) }));
  const statColumns: ReportColumn[] = [
    ...(groupBy === 'hook' ? [] : [{ key: 'groupLabel', title: t(`group.${groupBy}`), sortKey: 'groupLabel', render: (item: UsageRow) => reportGroupLabel(groupBy, item.groupLabel, filters), exportValue: (item: UsageRow) => reportGroupLabel(groupBy, item.groupLabel, filters) }]),
    { key: 'label', title: t('field'), sortKey: 'label', render: (item) => <>{display(item.label)}<span className="mt-1 block text-xs text-muted-foreground">{display(item.key)}</span></> },
    { key: 'postActionId', title: t('postAction') }, ...hookNumberColumns(t, metric, true),
  ];
  const recordColumns: ReportColumn[] = [
    { key: 'occurredAt', title: t('createdAt'), sortKey: 'occurredAt', render: (item) => formatReportTimestamp(item.occurredAt, String(params.timeZone || 'Asia/Shanghai'), i18n.language) },
    { key: 'userName', title: t('userName'), sortKey: 'userName', render: reportUserName },
    { key: 'workspaceName', title: t('workspaceName'), sortKey: 'workspaceName', render: reportWorkspaceName },
    { key: 'postActionId', title: t('postAction') }, ...businessColumns,
  ];
  return <section className="space-y-5" aria-label={t('singleHookReport')}>
    <MetricDefinition><details className="ai-report-help"><summary>{t('redesign.definitions')}</summary><p>{t('singleHookHint')}</p></details></MetricDefinition>
    <form className={`${sectionClass} flex flex-wrap items-end gap-3 p-4`} aria-label={t('hookReportFilters')} onSubmit={(event) => {
      event.preventDefault(); const problem = validateUsageRange(draft.from, draft.to, through);
      setRangeError(problem ? `range.${problem}` : ''); if (!problem) { setFilters(draft); resetPages(); }
    }}>
      {(['from', 'to'] as const).map((key) => <label key={key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(key)}<input type="date" className={inputClass} required max={through} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      {(['userName', 'workspaceName'] as const).map((key) => <label key={key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(key)}<input type="text" className={`${inputClass} w-40`} maxLength={150} placeholder={t('nameSearchPlaceholder')} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      <Button type="submit" variant="outline" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => { setDraft(initialFilters); setFilters(initialFilters); setFieldKey(''); resetPages(); setRangeError(''); }}>{t('resetFilters')}</Button>
      {rangeError ? <p role="alert" className="w-full text-xs text-destructive">{t(rangeError)}</p> : <MetricDefinition><p className="w-full text-xs text-muted-foreground">{t('hookReportFilterHint')}</p></MetricDefinition>}
    </form>
    <section className={sectionClass} aria-label={t('hookNumericResults')} aria-busy={loading}>
      <header className="border-b border-border px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-semibold">{t('hookNumericResults')}</h4>

      </div><MetricDefinition><details className="ai-report-help"><summary>{t('redesign.definitions')}</summary><p>{t('hookNumericHint')}</p></details></MetricDefinition></header>
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4">
        <ReportGrouping value={groupBy} options={groups} labels={{ hook: t('detailStatsAll') }} onChange={value => { setGroupBy(value as typeof groupBy); if (isTimeGroup(value)) setStatsSort({ sortBy: 'groupLabel', sortDir: 'asc' }); setStatsPage(1); }} />
        <ReportSelect label={t('numberField')} value={fieldKey} disabled={loading} className="ai-report-field-select" icon={<Hash />} menuMinWidth={280}
          options={[{ value: '', label: t('allNumberFields') }, ...fields.map(field => ({ value: field.key, label: field.label || field.key, description: field.key })),
            ...(fieldKey && !fields.some(field => field.key === fieldKey) ? [{ value: fieldKey, label: fieldKey }] : [])]}
          onChange={value => { setFieldKey(value); resetPages(); }} />
        <HookStatisticSelect value={metric} onChange={(value) => { setMetric(value); setStatsSort((old) => hookStatisticSort(old, value)); setStatsPage(1); }} />
      </div>
      {error && <p role="alert" className="p-5 text-sm text-destructive">{t(error)}</p>}
      {loading ? <p role="status" className="p-8 text-center text-sm text-muted-foreground">{t('loading')}</p> : <ReportTable columns={statColumns} rows={data?.statistics.items || []} empty={t('noNumericResults')} sort={statsSort} onSort={(key) => { setStatsSort(nextReportSort(statsSort, key)); setStatsPage(1); }} />}
      <ReportPagination page={statsPage} total={data?.statistics.total || 0} onPage={setStatsPage} disabled={loading} />
    </section>
    <section className={sectionClass} aria-label={t('records')} aria-busy={loading}>
      <header className="border-b border-border px-5 py-4"><h4 className="font-semibold">{t('records')}</h4><p className="mt-2 text-xs text-muted-foreground">{t(showDefinitions ? 'hookRecordsHint' : 'workbook.matchingRecords', { count: data?.records.total || 0 })}</p></header>
      {loading ? <p className="p-8 text-center text-sm text-muted-foreground">{t('loading')}</p> : <ReportTable columns={recordColumns} rows={data?.records.items || []} empty={t('empty')} sort={recordSort} onSort={(key) => { setRecordSort(nextReportSort(recordSort, key)); setRecordsPage(1); }} />}
      <ReportPagination page={recordsPage} total={data?.records.total || 0} onPage={setRecordsPage} disabled={loading} />
    </section>
  </section>;
}
