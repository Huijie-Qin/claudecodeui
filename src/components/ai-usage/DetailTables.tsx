import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { nextReportSort } from './analysisState';
import { tableNameFilter } from './filterState';
import { usageRequest } from './client';
import ReportExportButton from './ReportExportButton';
import { ReportPagination, ReportTable, type ReportColumn, type ReportSort } from './ReportTable';
import { isUsageAccessFailure } from './requestState';
import { assertPublishedBatch, displayReportValue as display, formatReportTimestamp, formatExecutionDuration, reportUserName, reportWorkspaceName } from './usageUtils';
import type { UsageList, UsageRow } from './types';

type Props = { params: Record<string, unknown>; onAccessError: () => void };

function DataTableSection({ params, onAccessError, endpoint, title, hint, columns, initialSort, filterKey, filterLabel, filterValue, onFilter, controls }: Props & {
  endpoint: string; title: string; hint: string; columns: ReportColumn[]; initialSort: string; filterKey?: string; filterLabel?: string;
  filterValue?: string; onFilter?: (value: string) => void;
  controls?: ReactNode;
}) {
  const { t } = useTranslation('aiUsage');
  const [sort, setSort] = useState<ReportSort>({ sortBy: initialSort, sortDir: 'desc' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [draft, setDraft] = useState(filterValue || '');
  const [localFilter, setLocalFilter] = useState('');
  const filter = filterValue ?? localFilter;
  const setFilter = onFilter || setLocalFilter;
  const [result, setResult] = useState<UsageList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const queryKey = JSON.stringify(params);
  useEffect(() => {
    const controller = new AbortController();
    const query = { ...JSON.parse(queryKey), ...sort, page, pageSize, ...(filterKey ? { [filterKey]: filter } : {}) };
    setLoading(true); setError(''); setResult(null);
    void usageRequest<UsageList>(endpoint, query, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(next, String(query.batchId));
      if (endpoint === 'hook-field-statistics' && query.groupBy === 'user' && next.groupBy !== 'user') throw new Error('hookUserGroupingUnavailable');
      if (endpoint === 'hook-field-statistics' && next.numericStatisticsVersion !== 1) throw new Error('hookNumbersUnavailable');
      setResult(next);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError(); else setError(caught instanceof Error && ['hookUserGroupingUnavailable', 'hookNumbersUnavailable'].includes(caught.message) ? caught.message : 'requestFailed');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, sort, page, pageSize, filter, filterKey, endpoint, onAccessError]);
  return <section className="overflow-hidden rounded-xl border border-border bg-card" aria-label={title}>
    <header className="border-b border-border px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">{title}</h3>
      <ReportExportButton endpoint={endpoint} params={{ ...params, ...sort, ...(filterKey ? { [filterKey]: filter } : {}) }} columns={columns} total={result?.total || 0} title={title} disabled={loading || !result || Boolean(error)} onAccessError={onAccessError} />
    </div><p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p></header>
    {(controls || filterKey) && <form className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-3" onSubmit={(event) => { event.preventDefault(); setFilter(draft.trim()); setPage(1); }}>
      {controls}
      {filterKey && <><label className="flex flex-col gap-1 text-xs text-muted-foreground">{filterLabel}<input maxLength={150} placeholder={filterKey === 'search' ? t('nameSearchPlaceholder') : undefined} className="h-9 rounded border border-input bg-background px-3 text-sm text-foreground" value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
      <Button type="submit" variant="outline" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => { setDraft(''); setFilter(''); setPage(1); }}>{t('resetFilters')}</Button></>}
    </form>}
    {error && <p role="alert" className="p-5 text-sm text-destructive">{t(error)}</p>}
    {loading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p> : <ReportTable compact={endpoint === 'hook-field-statistics'} columns={columns} rows={result?.items || []} empty={t('empty')} sort={sort} onSort={(key) => { setSort(nextReportSort(sort, key)); setPage(1); }} />}
    <ReportPagination page={page} pageSize={pageSize} total={result?.total || 0} disabled={loading} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
  </section>;
}

export function HookFieldsTable({ onDetails, ...props }: Props & { onDetails: (row: UsageRow) => void }) {
  const { t } = useTranslation('aiUsage');
  const nameFilter = tableNameFilter('hookFields')!;
  const [groupBy, setGroupBy] = useState<'hook' | 'user'>('hook');
  const [hookSearch, setHookSearch] = useState('');
  const columns: ReportColumn[] = [
    ...(groupBy === 'user' ? [{ key: 'userName', title: t('user'), sortKey: 'userName', render: reportUserName }] : []),
    { key: 'hookName', title: t('hookName'), sortKey: 'hookName', render: (row) => <div className="min-w-24">{display(row.hookName)}<span className="mt-1 block text-xs text-muted-foreground">#{display(row.hookId)}</span></div> },
    { key: 'postActionId', title: t('postAction') },
    { key: 'label', title: t('field'), sortKey: 'label', render: (row) => <>{display(row.label)}<span className="mt-1 block text-xs text-muted-foreground">{display(row.key)}</span></> },
    { key: 'details', title: '', render: (row) => <Button variant="ghost" size="sm" onClick={() => onDetails(row)}>{t('records')}</Button> },
  ];
  const controls = <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('hookFieldsGroupBy')}<select className="h-9 rounded border border-input bg-background px-3 text-sm text-foreground" value={groupBy} onChange={(event) => setGroupBy(event.target.value as 'hook' | 'user')}><option value="hook">{t('hookFieldsByHook')}</option><option value="user">{t('hookFieldsByUser')}</option></select></label>;
  return <DataTableSection key={groupBy} {...props} params={{ ...props.params, groupBy }} controls={controls} endpoint="hook-field-statistics" title={t('hookFieldsTitle')} hint={t('hookFieldsHint')} columns={columns} initialSort={groupBy === 'user' ? 'userName' : 'hookName'} filterKey={nameFilter.key} filterLabel={t(nameFilter.label)} filterValue={hookSearch} onFilter={setHookSearch} />;
}

export function HookExecutionRecords({ row, ...props }: Props & { row: UsageRow }) {
  const { t, i18n } = useTranslation('aiUsage');
  const columns: ReportColumn[] = [
    { key: 'occurredAt', title: t('createdAt'), sortKey: 'occurredAt', render: (item) => formatReportTimestamp(item.occurredAt, String(props.params.timeZone || 'Asia/Shanghai'), i18n.language), exportValue: (item) => formatReportTimestamp(item.occurredAt, String(props.params.timeZone || 'Asia/Shanghai'), i18n.language) },
    { key: 'userName', title: t('user'), sortKey: 'userName', render: reportUserName, exportValue: reportUserName }, { key: 'workspaceName', title: t('workspace'), sortKey: 'workspaceName', render: reportWorkspaceName, exportValue: reportWorkspaceName },
    { key: 'eventName', title: t('eventName') },
    { key: 'status', title: t('status'), sortKey: 'status', render: (item) => t(String(item.status)), exportValue: (item) => t(String(item.status)) },
    { key: 'durationMs', title: t('executionDuration'), sortKey: 'durationMs', render: (item) => formatExecutionDuration(item.durationMs), exportValue: (item) => formatExecutionDuration(item.durationMs) },
    { key: 'sessionKey', title: t('session') },
  ];
  return <DataTableSection {...props} params={{ ...props.params, hookVersion: row.hookVersion, eventName: row.eventName }} endpoint={`hook-executions/${encodeURIComponent(String(row.hookId))}/records`} title={t('executionRecords')} hint={t('executionRecordsHint')} columns={columns} initialSort="occurredAt" filterKey="executionStatus" filterLabel={t('executionStatusFilter')} />;
}
