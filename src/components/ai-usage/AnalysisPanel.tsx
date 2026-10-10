import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import MetricDefinition from './MetricDefinition';
import { analysisGroups, analysisMetrics, hasAnalysisRecords, nextReportSort, visibleAnalysisMetrics, visibleAnalysisSort } from './analysisState';
import { tableNameFilter } from './filterState';
import { usageRequest } from './client';
import ReportIdentity from './ReportIdentity';
import ReportGrouping from './ReportGrouping';
import { isTimeGroup, reportGroupLabel } from './groupingState';
import { useReportView } from './ReportViewContext';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { ReportTable, ReportPagination, type ReportColumn, type ReportSort } from './ReportTable';
import { assertPublishedBatch, displayReportValue, formatExecutionDuration, formatUsageDuration } from './usageUtils';
import type { AnalysisTab, UsageList, UsageRow } from './types';

const inputClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/30';
type AnalysisResult = UsageList & { summary: UsageRow | null; includeZeroUsers?: boolean };

export default function AnalysisPanel({ tab, params, onAccessError, onDetails, hookDirectory = false, groups, stateKey, onTemplate }: {
  tab: AnalysisTab; params: Record<string, unknown>; onAccessError: () => void;
  onDetails?: (row: UsageRow) => void;
  hookDirectory?: boolean;
  groups?: readonly string[]; stateKey?: string; onTemplate?: (row: UsageRow) => void;
}) {
  const { t } = useTranslation('aiUsage');
  const metrics = analysisMetrics[tab];
  const nameFilter = tableNameFilter(tab);
  const groupOptions = groups || analysisGroups[tab];
  const queryKey = JSON.stringify(params);
  const [view, setView] = useReportView(stateKey || tab, queryKey, {
    groupBy: groupOptions[0] as string,
    sort: { sortBy: tab === 'usage' ? 'activeDurationMs' : metrics[0], sortDir: 'desc' } as ReportSort,
    page: 1, pageSize: 20, nameDraft: '', nameSearch: '',
  });
  const { groupBy, sort: savedSort, page, pageSize, nameDraft, nameSearch } = view;
  const sort = useMemo(() => visibleAnalysisSort(tab, groupBy, savedSort), [tab, groupBy, savedSort]);
  const setGroupBy = (value: string) => setView(old => ({ ...old, groupBy: value, sort: isTimeGroup(value) ? { sortBy: 'groupLabel', sortDir: 'asc' } : visibleAnalysisSort(tab, value, old.sort), page: 1 }));
  const setSort = (value: ReportSort) => setView(old => ({ ...old, sort: value }));
  const setPage = (value: number) => setView(old => ({ ...old, page: value }));
  const setPageSize = (value: number) => setView(old => ({ ...old, pageSize: value }));
  const setNameDraft = (value: string) => setView(old => ({ ...old, nameDraft: value }));
  const setNameSearch = (value: string) => setView(old => ({ ...old, nameSearch: value }));
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const title = (key: string) => t(key === 'activeUserCount' && tab === 'hooks' ? 'recordUserCount' : key);
  const tableTitle = t(hookDirectory ? 'hookDirectoryTitle' : tab === 'usage' ? 'usageTableTitle' : `reportTableTitle.${tab}`);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setResult(null); setError('');
    const query = { ...JSON.parse(queryKey), dataset: tab, groupBy, ...sort, page, pageSize,
      ...(tab !== 'usage' ? { search: nameSearch } : {}),
      ...(tab === 'usage' && groupBy === 'user' ? { includeZeroUsers: true } : {}) };
    void usageRequest<AnalysisResult>('analysis', query, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(value, String(query.batchId));
      if (query.includeZeroUsers && value.includeZeroUsers !== true) throw new Error('usageGroupingUnavailable');
      setResult(value);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setResult(null);
      if (isUsageAccessFailure(caught)) onAccessError(); else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'usageGroupingUnavailable' ? caught.message : 'requestFailed'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, tab, groupBy, sort, page, pageSize, nameSearch, onAccessError]);

  const columns: ReportColumn[] = [
    { key: 'groupLabel', title: t(`group.${groupBy}`), sortKey: 'groupLabel', exportValue: (row) => reportGroupLabel(groupBy, row.groupLabel || t('unknown'), params), render: (row) => ['user','workspace','hook','template'].includes(groupBy) ? <ReportIdentity name={displayReportValue(row.groupLabel || t('unknown'))} kind={groupBy} subtitle={['hook', 'template'].includes(groupBy) && row.groupKey != null ? `#${displayReportValue(row.groupKey)}` : undefined} /> : reportGroupLabel(groupBy, row.groupLabel || t('unknown'), params) },
    ...visibleAnalysisMetrics(tab, groupBy).map((key) => ({ key, title: title(key), sortKey: key,
      ...(['activeDurationMs','averageDurationMs'].includes(key) ? {
        render: (row: UsageRow) => key === 'averageDurationMs' ? formatExecutionDuration(row[key]) : formatUsageDuration(row[key]),
        exportValue: (row: UsageRow) => key === 'averageDurationMs' ? formatExecutionDuration(row[key]) : formatUsageDuration(row[key]),
      } : {}) })),
  ];
  if (onDetails && hasAnalysisRecords(tab, groupBy)) {
    columns.push({ key: 'records', title: '', render: (row) => {
      if (row.groupKey == null || row.groupKey === '__unknown__') return null;
      const detailRow: UsageRow = { hookId: String(row.groupKey), hookName: displayReportValue(row.groupLabel), allHookRecords: true };
      return <Button variant="ghost" size="sm" onClick={() => onDetails(detailRow)}>{t(hookDirectory ? 'enterHookReport' : tab === 'hooks' ? 'records' : 'executionRecords')}</Button>;
    } });
  }
  if (onTemplate && groupBy === 'template') columns.push({ key: 'templateUsage', title: '', render: row =>
    row.groupKey != null && row.groupKey !== '__unknown__' ? <Button variant="ghost" size="sm" onClick={() => onTemplate(row)}>{t('exploreTemplate')}</Button> : null });
  return <section className="ai-report-panel overflow-hidden rounded-xl border border-border bg-card" aria-label={tableTitle}>
    <header className="ai-report-section-head"><div className="ai-report-section-title"><h3>{tableTitle}</h3><MetricDefinition><details className="ai-report-help"><summary>{t('redesign.definitions')}</summary><p>{t(hookDirectory ? 'hookDirectoryHint' : tab === 'usage' ? 'usageTableHint' : tab === 'templates' ? params.templateId ? 'templateExploreHint' : 'templateTableHint' : 'unifiedTableHint')}</p></details></MetricDefinition></div>
    <form aria-label={t('tableFilters')} className="ai-report-local-controls" onSubmit={(event) => { event.preventDefault(); setNameSearch(nameDraft.trim()); setPage(1); }}>
      {!hookDirectory && <ReportGrouping value={groupBy} options={groupOptions} onChange={setGroupBy} />}
      {nameFilter && !params.templateId && <><label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(nameFilter.label)}<input type="text" maxLength={150} className={inputClass} placeholder={t('nameSearchPlaceholder')} value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} /></label><Button type="submit" variant="outline" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => { setNameDraft(''); setNameSearch(''); setPage(1); }}>{t('redesign.reset')}</Button></>}

    </form></header>
    {error && <p role="alert" className="p-5 text-sm text-destructive">{t(error)}</p>}
    {loading ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />{t('loading')}</p> : <>
      <div className="ai-report-totals border-b border-border"><p className="text-xs text-muted-foreground">{t('matchingSummary', { total: result?.total || 0 })}</p><div className="flex flex-wrap">{metrics.map((key) => <div key={key}><p className="text-xs text-muted-foreground">{title(key)}</p><p className="mt-1 font-semibold tabular-nums">{['activeDurationMs','averageDurationMs'].includes(key) ? key === 'averageDurationMs' ? formatExecutionDuration(result?.summary?.[key]) : formatUsageDuration(result?.summary?.[key]) : displayReportValue(result?.summary?.[key])}</p></div>)}</div></div>
      <ReportTable columns={columns} rows={result?.items || []} empty={t('empty')} sort={sort} onSort={(key) => { setSort(nextReportSort(sort, key)); setPage(1); }} />
    </>}
    <ReportPagination page={page} total={result?.total || 0} pageSize={pageSize} onPage={setPage} disabled={loading} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
  </section>;
}
