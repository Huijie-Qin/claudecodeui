import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowDownToLine, CalendarClock, ChevronDown, CircleHelp, Clock3, Code2, FileText, Layers3, RefreshCw, Sparkles, Webhook } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { downloadUsageExport, UsageApiError, usageRequest } from './client';
import AnalysisPanel from './AnalysisPanel';
import SummaryCards from './SummaryCards';
import DemoCodeReport from './DemoCodeReport';
import CodeReport from './CodeReport';
import ReportTrend from './ReportTrend';
import './reportTheme.css';
import { hookNumberColumns } from './HookNumberColumns';
import HookStatisticSelect from './HookStatisticSelect';
import { HookExecutionRecords } from './DetailTables';
import SkillsReport from './SkillsReport';
import TemplateReport from './TemplateReport';
import { ReportViewContext } from './ReportViewContext';
import type { ReportViewStore } from './reportViewState';
import HookReportPanel from './HookReportPanel';
import Overlay from './ReportOverlay';
import { ReportExportAccess } from './ReportExportContext';
import { nextReportSort, reportTabOrder } from './analysisState';
import { usageFilterParams, type UsageFilters } from './filterState';
import { hookDetailScope, initialHookDetailFilters } from './hookDetailState';
import { ReportTable as UsageTable, ReportPagination as Pagination, type ReportColumn as Column, type ReportSort } from './ReportTable';
import { emptyUsageDetailData, isUsageAccessFailure, usageDetailReducer, usageFailureKey } from './requestState';
import { assertPublishedBatch, coverageStatus, dateInZone, defaultUsageRange, displayReportValue as display, formatReportTimestamp, formatUsageDuration, reportFields, reportUserName, reportWorkspaceName, validateUsageRange, type HookNumberMetric } from './usageUtils';
import type { ExportJob, ReportTab, UsageCapabilities, UsageList, UsageRow, UsageStatus } from './types';

const inputClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/30';
const panelClass = 'rounded-xl border border-border bg-card';
type Detail = { kind: 'hooks' | 'templates' | 'hookExecutions'; row: UsageRow; mode?: 'applications' | 'sessions' };

export default function AiUsagePanel({ tenantId }: { tenantId: number }) {
  const { t, i18n } = useTranslation('aiUsage');
  const [capabilities, setCapabilities] = useState<UsageCapabilities | null>(null);
  const [status, setStatus] = useState<UsageStatus | null>(null);
  const scope = 'tenant';
  const [tab, setTab] = useState<ReportTab | 'code'>('usage');
  const [revision, setRevision] = useState(0);
  const { views: viewStore } = useMemo(() => ({ tenantId, views: new Map() as ReportViewStore }), [tenantId]);
  const [filters, setFilters] = useState<UsageFilters>({ from: '', to: '', userName: '', workspaceName: '' });
  const [draft, setDraft] = useState(filters);
  const [trendMetric, setTrendMetric] = useState<'sessionCount' | 'dau' | 'mau'>('sessionCount');
  const [trend, setTrend] = useState<UsageRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedHook, setSelectedHook] = useState<UsageRow | null>(null);
  const [exportsOpen, setExportsOpen] = useState(false);
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rangeError, setRangeError] = useState('');
  const requestEpoch = useRef(0);
  const snapshotKey = `${tenantId}:${scope}:${status?.batchId}:${tab}:${JSON.stringify(filters)}:${revision}`;
  const [loadedKey, setLoadedKey] = useState('');
  const through = status?.dataThroughDate || (status?.dataThrough ? dateInZone(new Date(new Date(status.dataThrough).getTime() - 1).toISOString(), status.timeZone) : '');

  const onAccessError = useCallback(() => {
    viewStore.clear();
    requestEpoch.current += 1;
    setTrend([]); setDetail(null); setSelectedHook(null); setExportsOpen(false); setRefreshConfirmOpen(false); setStatusOpen(false); setDefinitionsOpen(false);
    setCapabilities(null); setStatus(null); setLoadedKey('');
    setError('accessChanged'); setRevision((value) => value + 1);
  }, [viewStore]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCapabilities(null); setStatus(null); setTrend([]); setLoadedKey('');
    void (async () => {
      try {
        const nextCapabilities = await usageRequest<UsageCapabilities>('capabilities', { tenantId }, controller.signal);
        if (controller.signal.aborted) return;
        setCapabilities(nextCapabilities);
        if (!nextCapabilities.simulation && !nextCapabilities.codeReportAvailable) setTab(old => old === 'code' ? 'usage' : old);
        if (!nextCapabilities.canViewTenant) {
          viewStore.clear();
          setDetail(null); setExportsOpen(false); setRefreshConfirmOpen(false); setError('');
          return;
        }
        const nextStatus = await usageRequest<UsageStatus>('status', { tenantId, scope }, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        const date = nextStatus.dataThroughDate || (nextStatus.dataThrough ? dateInZone(new Date(new Date(nextStatus.dataThrough).getTime() - 1).toISOString(), nextStatus.timeZone) : '');
        setFilters((old) => {
          const next = old.from && old.to ? { ...old, to: date && old.to > date ? date : old.to } : { ...old, ...defaultUsageRange(date) };
          setDraft(next); return next;
        });
        setError('');
      } catch (caught) {
        if (controller.signal.aborted) return;
        setCapabilities(null); setStatus(null);
        setError(isUsageAccessFailure(caught) ? 'accessChanged' : usageFailureKey(caught));
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [tenantId, revision, viewStore]);

  useEffect(() => {
    if (!capabilities?.simulation) return;
    document.body.classList.add('ai-report-preview');
    return () => document.body.classList.remove('ai-report-preview');
  }, [capabilities?.simulation]);

  useEffect(() => {
    if (!status?.batchId || !capabilities?.canViewTenant || !filters.from || !filters.to) return;
    const controller = new AbortController();
    const epoch = ++requestEpoch.current;
    const batchId = status.batchId;
    setLoading(true); setError('');
    const params = { tenantId, scope, batchId, ...usageFilterParams(filters) };
    void (async () => {
      try {
        if (tab === 'usage') {
          const nextTrend = await usageRequest<UsageList>('trend', params, controller.signal);
          if (controller.signal.aborted || epoch !== requestEpoch.current) return;
          assertPublishedBatch(nextTrend, batchId);
          setTrend(nextTrend.items || []);
        } else { setTrend([]); }
        setLoadedKey(snapshotKey);
      } catch (caught) {
        if (controller.signal.aborted || epoch !== requestEpoch.current) return;
        setTrend([]);
        if (isUsageAccessFailure(caught)) onAccessError();
        else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'batchMismatch' ? 'batchMismatch' : 'requestFailed'));
      } finally { if (!controller.signal.aborted && epoch === requestEpoch.current) setLoading(false); }
    })();
    return () => controller.abort();
  }, [tenantId, scope, status?.batchId, capabilities, filters, tab, revision, snapshotKey, onAccessError]);

  const formatTime = (value?: string) => value ? new Date(value).toLocaleString(i18n.language, { timeZone: status?.timeZone || 'Asia/Shanghai', hour12: false }) : '—';
  const ready = loadedKey === snapshotKey && !error;
  const showDetail = (row: UsageRow, mode: 'applications' | 'sessions' = 'applications') => setDetail({ kind: tab === 'hooks' ? 'hooks' : tab === 'hookExecutions' ? 'hookExecutions' : 'templates', row, mode });
  const showPartial = status?.batchId && coverageStatus(status.coverage) !== 'complete';
  const analysisParams = { tenantId, scope, batchId: status?.batchId, ...usageFilterParams(filters) };
  const childKey = `${tenantId}:${scope}:${tab}:${status?.batchId}:${JSON.stringify(filters)}:${revision}`;
  const analysisPanel = tab === 'skills' || tab === 'hooks' || tab === 'templates' || tab === 'code' ? null : <AnalysisPanel key={childKey} tab={tab} params={analysisParams} onAccessError={onAccessError} onDetails={showDetail} />;
  const visibleTabs: (ReportTab | 'code')[] = capabilities?.simulation || capabilities?.codeReportAvailable ? ['usage', 'code', ...reportTabOrder.slice(1)] : [...reportTabOrder];
  // Updated fixture servers exercise the same topic-table API as production.
  // Retain only the old offline HTML's explicit demo mode when no API exists.
  const legacyCodeDemo = capabilities?.simulation && !capabilities.codeReportAvailable;

  if (capabilities && !capabilities.canViewTenant) return <div className="mx-auto max-w-[1480px] space-y-4 p-4 md:p-7 lg:p-9">
    <h2 className="text-2xl font-semibold">{t('title')}</h2>
    <p role="alert" className={`${panelClass} p-6 text-sm text-muted-foreground`}>{t('tenantReportDenied')}</p>
  </div>;

  return <ReportViewContext.Provider value={viewStore}><ReportExportAccess.Provider value={Boolean(capabilities?.canExport && capabilities.canViewTenant)}><div ref={panelRef} className="ai-report">
    {capabilities?.simulation && <div className="ai-report-appbar"><div className="ai-report-brand"><span className="ai-report-logo"><Layers3 className="h-4 w-4" /></span>CCUI<span className="ai-report-breadcrumb">/ <span>{t('redesign.tenantManagement')}</span> / <b>{t('redesign.title')}</b></span></div><span className="ai-report-appbar-note">{t('redesign.previewWorkspace')}</span></div>}
    <section className="ai-report-heading">
      <div><div className="flex flex-wrap items-center gap-3"><h2>{t('redesign.title')}</h2>{capabilities?.simulation && <span className="ai-report-badge">{t('redesign.demo')}</span>}</div><p>{t('redesign.subtitle')}</p></div>
      <div className="ai-report-heading-actions flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" aria-label={t('redesign.updates')} onClick={() => setStatusOpen(true)}><span className={`ai-report-status-dot ${showPartial ? 'partial' : ''}`} />{t('dataThrough')} {through?.slice(5).replace('-', '/') || '—'}{showPartial && <span className="ai-report-status-label">· {t('partial')}</span>}<ChevronDown className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant="outline" disabled={loading} aria-label={t('refresh')} title={t('refresh')} onClick={() => setRefreshConfirmOpen(true)}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        {capabilities?.canExport && capabilities.canViewTenant && <Button size="sm" variant="outline" disabled={loading || !ready || !status?.batchId} onClick={() => panelRef.current?.querySelector<HTMLButtonElement>('[data-report-export]')?.click()}><ArrowDownToLine className="h-4 w-4" />{t('exportCurrent')}</Button>}
        {capabilities?.exportConfigured && tab !== 'code' && <Button size="sm" variant="ghost" onClick={() => setExportsOpen(true)}>{t('exportJobs')}</Button>}
      </div>
    </section>
    {status && ['failed', 'paused', 'running', 'disabled'].includes(status.state || '') && <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" />{t(status.state || 'pending')} · {t('staleHint')}</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{t(error)}</p>}
    {status?.batchId && capabilities && <SummaryCards key={`${tenantId}:${status.batchId}:${capabilities.canViewTenant}:${revision}`} tenantId={tenantId} batchId={status.batchId} capabilities={capabilities} onAccessError={onAccessError} />}
    <div className="ai-report-tabs" role="tablist" aria-label={t('title')}>{visibleTabs.map((key) => { const Icon = { usage: Activity, code: Code2, skills: Sparkles, hookExecutions: Activity, hooks: Webhook, templates: FileText }[key]; return <button key={key} type="button" role="tab" id={`ai-report-tab-${key}`} aria-selected={tab === key} aria-controls="ai-usage-tab-panel" className="ai-report-tab" onClick={() => { setTab(key); setDetail(null); setSelectedHook(null); }}><Icon className="h-4 w-4" />{t(key === 'code' ? 'codeReport.tab' : key)}</button>; })}</div>
    {status?.batchId && <form aria-label={t('sharedFilters')} className="ai-report-filters" onSubmit={(event) => { event.preventDefault(); const problem = validateUsageRange(draft.from, draft.to, through); setRangeError(problem ? `range.${problem}` : ''); if (!problem) { setFilters(draft); setDetail(null); } }}>
      {(['from', 'to'] as const).map((key) => <label key={key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(key)}<input type="date" className={inputClass} required max={through} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(tab === 'skills' ? 'publisherNameFilter' : 'userName')}<input className={`${inputClass} w-40`} type="text" maxLength={150} value={draft.userName} placeholder={t('nameSearchPlaceholder')} onChange={(event) => setDraft({ ...draft, userName: event.target.value })} /></label>
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('workspaceName')}<input className={`${inputClass} w-40`} type="text" maxLength={150} value={draft.workspaceName} placeholder={t('nameSearchPlaceholder')} onChange={(event) => setDraft({ ...draft, workspaceName: event.target.value })} /></label>
      <Button type="submit" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => { const cleared = { ...defaultUsageRange(through), userName: '', workspaceName: '' }; setDraft(cleared); setFilters(cleared); setRangeError(''); setDetail(null); }}>{t('resetFilters')}</Button><span className="ai-report-filters-note">{t('redesign.filterScope')}</span>{rangeError && <p role="alert" className="w-full text-xs text-destructive">{t(rangeError)}</p>}
    </form>}
    <div id="ai-usage-tab-panel" role="tabpanel" aria-labelledby={`ai-report-tab-${tab}`} aria-busy={loading} className="space-y-4">
      {tab === 'hooks' && ready && status?.batchId && <AnalysisPanel key={childKey} tab="hooks" hookDirectory params={analysisParams} onAccessError={onAccessError} onDetails={setSelectedHook} />}
      {!status?.batchId ? <div className={`${panelClass} px-6 py-16 text-center`}><CalendarClock className="mx-auto h-9 w-9 text-muted-foreground/60" /><h3 className="mt-4 font-medium">{loading ? t('loading') : t('noBatch')}</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{t('noBatchHint')}</p></div> : loading && !ready ? <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />{t('loading')}</div> : tab === 'usage' ? <>
        <section className="ai-report-trend">
          <header><h3>{t('trendTitle')}</h3>
            <select className={inputClass} aria-label={t('trendMetric')} value={trendMetric} onChange={(event) => setTrendMetric(event.target.value as typeof trendMetric)}>
              {(['sessionCount','dau','mau'] as const).map((key) => <option key={key} value={key}>{t(key)}</option>)}
            </select>
          </header>
          {ready && trend.length ? <ReportTrend rows={trend.filter(row => Boolean(row.date)).map(row => ({ date: String(row.date), value: typeof row[trendMetric] === 'number' ? row[trendMetric] as number : null }))} series={[{ key: 'value', label: t(trendMetric) }]} unit={t(trendMetric)} label={t('trendTitle')} /> : <p className="py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>}
          <footer><span>{filters.from} — {filters.to}</span><span>{t('redesign.dailyTrend')}</span></footer>
        </section>
        {analysisPanel}
      </> : tab === 'code' ? legacyCodeDemo ? <DemoCodeReport key={childKey} tenantId={tenantId} batchId={status.batchId} filters={filters} timeZone={status.timeZone || 'Asia/Shanghai'} onAccessError={onAccessError} /> : <CodeReport key={childKey} params={analysisParams} onAccessError={onAccessError} /> : tab === 'skills' ? <SkillsReport key={`skills:${childKey}`} params={{ ...analysisParams, timeZone: status.timeZone }} onAccessError={onAccessError} /> : tab === 'templates' ? <TemplateReport key={childKey} params={analysisParams} onAccessError={onAccessError} /> : analysisPanel}
    </div>
    <footer className="ai-report-note"><span>{capabilities?.simulation ? t('redesign.simulationHint') : t('todayHint')}</span><Button variant="ghost" size="sm" onClick={() => setDefinitionsOpen(true)}><CircleHelp className="h-3.5 w-3.5" />{t('redesign.definitions')}</Button></footer>
    {statusOpen && <Overlay title={t('redesign.updates')} onClose={() => setStatusOpen(false)} compact><p className="mb-3 text-xs text-muted-foreground">{t('nonRealtime')}</p><dl className="divide-y divide-border">{[[t('dataThrough'), through || '—'], [t('lastSuccess'), formatTime(status?.lastSucceededAt || status?.generatedAt)], [t('nextRun'), status?.nextRunAt ? formatTime(status.nextRunAt) : t('notScheduled')], [t('timeZone'), status?.timeZone || '—']].map(([label, value]) => <div className="flex flex-wrap justify-between gap-3 py-3 text-sm" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl>{showPartial && <p className="ai-report-coverage-note"><AlertCircle className="h-4 w-4 shrink-0" />{t('partialHint')}</p>}</Overlay>}
    {definitionsOpen && <Overlay title={t('redesign.definitions')} onClose={() => setDefinitionsOpen(false)} compact><div className="space-y-4 text-sm leading-6 text-muted-foreground"><p>{t('summaryHint')}</p><p>{t('todayHint')}</p><p>{t('sharedFiltersHint')}</p><p>{t('durationHint')}</p><p>{t('exportCurrentHint')}</p>{legacyCodeDemo ? <><p>{t('codeReport.generatedHint')} · {t('codeReport.submittedHint')}</p><p>{t('codeReport.fixtureOnly')}</p></> : capabilities?.codeReportAvailable && <><p>{t('codeReport.generatedHint')}</p><p>{t('codeReport.realSubmittedHint')}</p></>}</div></Overlay>}
    {tab === 'hooks' && ready && selectedHook && status?.batchId && <Overlay title={`${display(selectedHook.hookName)} · ${t('singleHookReport')}`} onClose={() => setSelectedHook(null)} fullHeight>
      <HookReportPanel key={`${childKey}:${selectedHook.hookId}`} row={selectedHook} params={{ ...analysisParams, timeZone: status.timeZone }} through={through} onAccessError={onAccessError} />
    </Overlay>}
    {refreshConfirmOpen && <Overlay title={t('refreshConfirmTitle')} onClose={() => setRefreshConfirmOpen(false)} compact><p className="text-sm leading-6 text-muted-foreground">{t('refreshConfirmMessage')}</p><div className="mt-6 flex justify-end gap-3"><Button variant="outline" onClick={() => setRefreshConfirmOpen(false)}>{t('cancel')}</Button><Button disabled={loading} onClick={() => { setRefreshConfirmOpen(false); setDetail(null); setRevision((value) => value + 1); }}>{t('confirmRefresh')}</Button></div></Overlay>}
    {detail && status?.batchId && (detail.kind === 'hookExecutions' ? <Overlay title={`${display(detail.row.hookName)} · ${t('executionRecords')}`} onClose={() => setDetail(null)}><HookExecutionRecords key={JSON.stringify(detail)} row={detail.row} params={{ ...analysisParams, timeZone: status.timeZone }} onAccessError={onAccessError} /></Overlay> : <DetailPanel key={`${tenantId}:${scope}:${status.batchId}:${JSON.stringify(detail)}`} detail={detail} params={{ ...analysisParams, timeZone: status.timeZone }} through={through} onClose={() => setDetail(null)} onAccessError={onAccessError} />)}
    {exportsOpen && <ExportPanel tenantId={tenantId} capabilities={tab === 'skills' && capabilities ? { ...capabilities, exportConfigured: false } : capabilities} params={{ ...analysisParams, dataset: tab === 'usage' ? 'users' : tab, reportType: tab === 'usage' ? 'ai_usage' : tab === 'skills' ? 'skill_usage' : tab === 'hooks' ? 'hook_records' : tab === 'hookExecutions' ? 'hook_execution_usage' : 'agent_template_usage' }} onClose={() => setExportsOpen(false)} onAccessError={onAccessError} />}
  </div></ReportExportAccess.Provider></ReportViewContext.Provider>;
}

function DetailPanel({ detail, params, through, onClose, onAccessError }: { detail: Detail; params: Record<string, unknown>; through: string; onClose: () => void; onAccessError: () => void }) {
  const { t, i18n } = useTranslation('aiUsage');
  const timeZone = typeof params.timeZone === 'string' ? params.timeZone : 'Asia/Shanghai';
  const timestamp = (value: unknown) => formatReportTimestamp(value, timeZone, i18n.language);
  const [page, setPage] = useState(1);
  const [metric, setMetric] = useState<HookNumberMetric>('sum');
  const [groupBy, setGroupBy] = useState<'hook' | 'user'>('hook');
  const [filters, setFilters] = useState(() => initialHookDetailFilters(params, detail.row));
  const [draft, setDraft] = useState(filters);
  const [rangeError, setRangeError] = useState('');
  const [{ list, statistics }, dispatchDetails] = useReducer(usageDetailReducer, undefined, emptyUsageDetailData);
  const [sort, setSort] = useState<ReportSort>({ sortBy: detail.mode === 'sessions' ? 'lastInteractionAt' : 'occurredAt', sortDir: 'desc' });
  const [provider, setProvider] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const queryKey = JSON.stringify(params);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); dispatchDetails({ type: 'request_started' }); setError('');
    const base = JSON.parse(queryKey);
    const sharedQuery = detail.kind === 'hooks' ? hookDetailScope(base, detail.row, filters) : base;
    const query = { ...sharedQuery, page, pageSize: 20, ...sort, ...(detail.mode === 'sessions' ? { provider } : {}) };
    const id = encodeURIComponent(String(detail.kind === 'hooks' ? detail.row.hookId : detail.row.templateId));
    void Promise.all([
      usageRequest<UsageList>(`${detail.kind}/${id}/${detail.kind === 'hooks' ? 'records' : detail.mode || 'applications'}`, query, controller.signal),
      detail.kind === 'hooks' ? usageRequest<UsageList>(`hooks/${id}/statistics`, { ...sharedQuery, groupBy }, controller.signal) : Promise.resolve(null),
    ]).then(([nextList, stats]) => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(nextList, String(query.batchId));
      if (stats) { assertPublishedBatch(stats, String(query.batchId)); if (stats.numericStatisticsVersion !== 1 || stats.groupBy !== groupBy) throw new Error('hookNumbersUnavailable'); }
      dispatchDetails({ type: 'succeeded', list: nextList, statistics: stats?.items || [] });
    }).catch((caught) => { if (controller.signal.aborted) return; dispatchDetails({ type: 'request_failed' }); if (isUsageAccessFailure(caught)) onAccessError(); else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'hookNumbersUnavailable' ? caught.message : 'requestFailed')); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, detail, filters, groupBy, page, provider, sort, onAccessError]);
  const recordColumns: Column[] = Array.from(new Map((list?.items || []).flatMap((row) => reportFields(row.fields)).map((field) => [field.key, field])).values()).slice(0, 20).map((field) => ({
    key: `field:${field.key}`, title: field.label, render: (row) => display(reportFields(row.fields).find((value) => value.key === field.key)?.value),
  }));
  const columns: Column[] = [
    { key: 'occurredAt', title: t(detail.mode === 'sessions' ? 'firstInteractionAt' : 'createdAt'), render: (row) => timestamp(row.firstInteractionAt || row.occurredAt || row.createdAt) }, { key: 'userName', title: t('user'), render: reportUserName },
    { key: 'workspaceName', title: t('workspace'), render: reportWorkspaceName },
    ...(detail.kind === 'hooks' ? [
      ...(detail.row.allHookRecords ? [{ key: 'postActionId', title: t('postAction') }] : []),
      { key: 'sessionKey', title: t('session'), render: (row: UsageRow) => display(row.sessionKey || row.sessionId) }, ...recordColumns] : []),
    ...(detail.mode === 'sessions' ? [{ key: 'sessionKey', title: t('session') }, { key: 'provider', title: t('provider') }, { key: 'lastInteractionAt', title: t('lastInteractionAt'), render: (row: UsageRow) => timestamp(row.lastInteractionAt) }, { key: 'activeDurationMs', title: t('activeDurationMs'), render: (row: UsageRow) => formatUsageDuration(row.activeDurationMs) }] : []),
  ];
  return <Overlay title={`${display(detail.row.hookName || detail.row.templateName)} · ${t(detail.kind === 'hooks' ? 'records' : detail.mode || 'applications')}`} onClose={onClose}>
    <p className="mb-4 text-xs text-muted-foreground">{t('batch')}: {String(params.batchId)} · {t('timeZone')}: {timeZone}</p>
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{t(error)}</p>}
    {detail.kind === 'hooks' && <>
      <section className={`${panelClass} mb-5`} aria-label={t('fields')} aria-busy={loading}>
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><h3 className="text-sm font-semibold">{t('fields')}</h3><div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">{t('detailStatsGroup')}<select className={inputClass} value={groupBy} onChange={(event) => setGroupBy(event.target.value as 'hook' | 'user')}><option value="hook">{t('detailStatsAll')}</option><option value="user">{t('hookFieldsByUser')}</option></select></label>
          <HookStatisticSelect value={metric} onChange={setMetric} />
        </div></header>
        {loading ? <p className="px-5 py-6 text-sm text-muted-foreground">{t('loading')}</p> : <div className="max-h-72 overflow-auto"><UsageTable columns={[
          ...(groupBy === 'user' ? [{ key: 'userName', title: t('user'), render: reportUserName }] : []),
          { key: 'label', title: t('field'), render: (row) => display(row.label || row.key) }, { key: 'postActionId', title: t('postAction') }, ...hookNumberColumns(t, metric),
        ]} rows={statistics} empty={t('empty')} /></div>}
      </section>
      <form aria-label={t('detailRecordFilters')} className={`${panelClass} mb-5 flex flex-wrap items-end gap-3 p-4`} onSubmit={(event) => {
        event.preventDefault(); const problem = validateUsageRange(draft.from, draft.to, through);
        setRangeError(problem ? `range.${problem}` : '');
        if (!problem) { setFilters(draft); setPage(1); }
      }}>
        {(['from', 'to'] as const).map((key) => <label key={key} className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(key)}<input type="date" className={inputClass} required max={through} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('userName')}<input type="text" className={`${inputClass} w-40`} maxLength={150} placeholder={t('nameSearchPlaceholder')} value={draft.userName} onChange={(event) => setDraft({ ...draft, userName: event.target.value, recordUserId: undefined })} /></label>
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('workspaceName')}<input type="text" className={`${inputClass} w-40`} maxLength={150} placeholder={t('nameSearchPlaceholder')} value={draft.workspaceName} onChange={(event) => setDraft({ ...draft, workspaceName: event.target.value })} /></label>
        <Button type="submit" variant="outline" disabled={loading}>{t('apply')}</Button>
        <Button type="button" variant="ghost" onClick={() => { const initial = initialHookDetailFilters(params, detail.row); setDraft(initial); setFilters(initial); setPage(1); setRangeError(''); }}>{t('resetFilters')}</Button>
        <p className="w-full text-xs leading-5 text-muted-foreground">{rangeError ? <span role="alert" className="text-destructive">{t(rangeError)}</span> : t('detailRecordFiltersHint')}</p>
      </form>
    </>}
    {detail.kind === 'templates' && <p className="mb-4 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">{t(detail.mode === 'sessions' ? 'sessionActorHint' : 'applicationActorHint')}</p>}
    {detail.mode === 'sessions' && <label className="mb-4 flex items-center gap-3 text-sm text-muted-foreground">{t('provider')}<select className={inputClass} value={provider} onChange={(event) => { setProvider(event.target.value); setPage(1); }}><option value="">{t('all')}</option>{['claude', 'codex', 'gemini', 'cursor'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
    {loading ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p> : <section className={panelClass}><UsageTable columns={columns.map((column) => ({ ...column,
      sortKey: column.key === 'occurredAt' ? detail.mode === 'sessions' ? 'firstInteractionAt' : 'occurredAt'
        : ['userName','workspaceName','provider','lastInteractionAt','activeDurationMs'].includes(column.key) ? column.key : undefined,
    }))} rows={list?.items || []} empty={t('empty')} sort={sort} onSort={(key) => { setSort(nextReportSort(sort, key)); setPage(1); }} /><Pagination page={page} total={list?.total || 0} onPage={setPage} /></section>}
  </Overlay>;
}

function ExportPanel({ tenantId, capabilities, params, onClose, onAccessError }: { tenantId: number; capabilities: UsageCapabilities | null; params: Record<string, unknown>; onClose: () => void; onAccessError: () => void }) {
  const { t } = useTranslation('aiUsage');
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState('');
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => () => downloadController.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const result = await usageRequest<{ items?: ExportJob[]; jobs?: ExportJob[] }>('exports', { tenantId }, controller.signal);
        if (controller.signal.aborted) return;
        const next = result.items || result.jobs || []; setJobs(next);
        if (next.some((job) => ['queued', 'running'].includes(job.status || job.state || ''))) timer = window.setTimeout(load, 5000);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setJobs([]);
        if (isUsageAccessFailure(caught)) onAccessError();
        else if (!(caught instanceof UsageApiError && caught.code === 'exportNotConfigured')) setError(usageFailureKey(caught));
      }
    };
    void load(); return () => { controller.abort(); window.clearTimeout(timer); };
  }, [tenantId, revision, onAccessError]);
  const create = async () => {
    setCreating(true); setError('');
    try { await usageRequest('exports', { tenantId }, undefined, params); setRevision((value) => value + 1); }
    catch (caught) { if (isUsageAccessFailure(caught)) { setJobs([]); onAccessError(); } else setError(usageFailureKey(caught, caught instanceof UsageApiError && caught.code === 'exportNotConfigured' ? 'exportUnconfigured' : 'requestFailed')); }
    finally { setCreating(false); }
  };
  const download = async (job: ExportJob) => {
    const id = job.id || job.jobId; if (!id) return;
    downloadController.current?.abort(); const controller = new AbortController(); downloadController.current = controller;
    setDownloading(id); setError('');
    try { await downloadUsageExport(tenantId, id, controller.signal); }
    catch (caught) { if (controller.signal.aborted) return; if (isUsageAccessFailure(caught)) { setJobs([]); onAccessError(); } else setError(usageFailureKey(caught)); }
    finally { if (!controller.signal.aborted) setDownloading(''); }
  };
  return <Overlay title={t('exportJobs')} onClose={onClose}><p className="rounded-lg bg-muted/50 p-4 text-sm leading-6 text-muted-foreground">{t(capabilities?.exportConfigured ? 'exportSnapshot' : 'exportUnconfigured')}</p>{error && <p role="alert" className="mt-3 text-sm text-destructive">{t(error)}</p>}<Button className="my-4" disabled={!capabilities?.exportConfigured || !capabilities.canExport || !params.batchId || creating} onClick={() => void create()}>{t('export')}</Button><div className="divide-y divide-border rounded-lg border border-border">{jobs.length ? jobs.map((job, index) => <div key={job.id || job.jobId || index} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><div><p>{job.dataset ? t(job.dataset === 'users' ? 'usage' : job.dataset) : job.reportType || t('title')}</p><p className="mt-1 text-xs text-muted-foreground">{job.createdAt || job.id || job.jobId}</p></div><span>{t(job.status === 'ready' ? 'succeeded' : job.status || job.state || 'pending')}</span>{job.downloadReady && <Button size="sm" variant="outline" disabled={Boolean(downloading)} onClick={() => void download(job)}><ArrowDownToLine className="h-4 w-4" />{t('download')}</Button>}</div>) : <p className="p-8 text-center text-sm text-muted-foreground">{t('noJobs')}</p>}</div></Overlay>;
}
