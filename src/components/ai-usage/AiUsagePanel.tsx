import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, CalendarClock, ChevronDown, CircleHelp, Clock3, Code2, FileText, Layers3, RefreshCw, Sparkles, Webhook } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { usageRequest } from './client';
import AnalysisPanel from './AnalysisPanel';
import SummaryCards from './SummaryCards';
import DemoCodeReport from './DemoCodeReport';
import CodeReport from './CodeReport';
import SessionDetails from './SessionDetails';
import './reportTheme.css';
import SkillsReport from './SkillsReport';
import TemplateReport from './TemplateReport';
import { ReportViewContext } from './ReportViewContext';
import HookReportPanel from './HookReportPanel';
import Overlay from './ReportOverlay';
import { MetricDefinitionAccess } from './metricDefinitionAccess';
import { browserReportViews, saveSharedReportFilters, sharedReportFilters } from './savedReportViews';
import ReportDateInput from './ReportDateInput';
import { normalizeUsageDate } from './dateInput';
import WorkbookDownload from './WorkbookDownload';
import { reportTabOrder } from './analysisState';
import { usageFilterParams, type UsageFilters } from './filterState';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { coverageStatus, dateInZone, defaultUsageRange, validateUsageRange } from './usageUtils';
import type { ReportTenantId, ReportTab, UsageCapabilities, UsageRow, UsageStatus } from './types';

const inputClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/30';
const panelClass = 'rounded-xl border border-border bg-card';

export default function AiUsagePanel({ tenantId }: { tenantId: ReportTenantId }) {
  const { t, i18n } = useTranslation('aiUsage');
  const [capabilities, setCapabilities] = useState<UsageCapabilities | null>(null);
  const [status, setStatus] = useState<UsageStatus | null>(null);
  const scope = 'tenant';
  const [tab, setTab] = useState<ReportTab | 'code'>('usage');
  const [revision, setRevision] = useState(0);
  const { viewStore } = useMemo(() => ({ tenantId, viewStore: browserReportViews() }), [tenantId]);
  const [filters, setFilterState] = useState<UsageFilters>({ from: '', to: '', userName: '', workspaceName: '' });
  const [draft, setDraft] = useState(filters);
  const [selectedHook, setSelectedHook] = useState<UsageRow | null>(null);
  const [refreshConfirmOpen, setRefreshConfirmOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [definitionsOpen, setDefinitionsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rangeError, setRangeError] = useState('');
  const snapshotKey = `${tenantId}:${scope}:${status?.batchId}:${tab}:${JSON.stringify(filters)}:${revision}`;
  const [loadedKey, setLoadedKey] = useState('');
  const through = status?.dataThroughDate || (status?.dataThrough ? dateInZone(new Date(new Date(status.dataThrough).getTime() - 1).toISOString(), status.timeZone) : '');

  const setFilters = (next: UsageFilters) => {
    saveSharedReportFilters(viewStore, next);
    setFilterState(next);
  };
  const selectTab = (next: ReportTab | 'code') => {
    setTab(next); setSelectedHook(null);
  };

  const onAccessError = useCallback(() => {
    viewStore.clear();
    setSelectedHook(null); setRefreshConfirmOpen(false); setStatusOpen(false); setDefinitionsOpen(false);
    setCapabilities(null); setStatus(null); setLoadedKey('');
    setError('accessChanged'); setRevision((value) => value + 1);
  }, [viewStore]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCapabilities(null); setStatus(null); setLoadedKey('');
    void (async () => {
      try {
        const nextCapabilities = await usageRequest<UsageCapabilities>('capabilities', { tenantId }, controller.signal);
        if (controller.signal.aborted) return;
        viewStore.bind(tenantId, nextCapabilities.userId);
        setCapabilities(nextCapabilities);
        if (!nextCapabilities.simulation && !nextCapabilities.codeReportAvailable) setTab(old => old === 'code' ? 'usage' : old);
        if (!nextCapabilities.canViewTenant) {
          viewStore.clear();
          setRefreshConfirmOpen(false); setError('');
          return;
        }
        const nextStatus = await usageRequest<UsageStatus>('status', { tenantId, scope }, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        const date = nextStatus.dataThroughDate || (nextStatus.dataThrough ? dateInZone(new Date(new Date(nextStatus.dataThrough).getTime() - 1).toISOString(), nextStatus.timeZone) : '');
        const next = sharedReportFilters(viewStore, date);
        setFilterState(next); setDraft(next);
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
    setLoadedKey(snapshotKey);
    setLoading(false);
  }, [status?.batchId, capabilities?.canViewTenant, filters.from, filters.to, snapshotKey]);

  const formatTime = (value?: string) => value ? new Date(value).toLocaleString(i18n.language, { timeZone: status?.timeZone || 'Asia/Shanghai', hour12: false }) : '—';
  const ready = loadedKey === snapshotKey && !error;
  const showPartial = status?.batchId && coverageStatus(status.coverage) !== 'complete';
  const excludedCount = typeof status?.coverage === 'object' ? status.coverage?.excludedSessionCount : undefined;
  const excludedSessionCount = status?.batchId && typeof excludedCount === 'number' && Number.isSafeInteger(excludedCount) && excludedCount > 0 ? excludedCount : 0;
  const allTenantsCoverage = typeof status?.coverage === 'object' ? status.coverage?.allTenants : undefined;
  const analysisParams = { tenantId, scope, batchId: status?.batchId, ...usageFilterParams(filters) };
  const childKey = `${tenantId}:${scope}:${tab}:${status?.batchId}:${JSON.stringify(filters)}:${revision}`;
  const analysisPanel = tab === 'usage' || tab === 'skills' || tab === 'hooks' || tab === 'templates' || tab === 'code' ? null : <AnalysisPanel key={childKey} tab={tab} params={analysisParams} onAccessError={onAccessError} />;
  const visibleTabs: (ReportTab | 'code')[] = capabilities?.simulation || capabilities?.codeReportAvailable ? ['usage', 'code', ...reportTabOrder.slice(1)] : [...reportTabOrder];
  // Updated fixture servers exercise the same topic-table API as production.
  // Retain only the old offline HTML's explicit demo mode when no API exists.
  const legacyCodeDemo = capabilities?.simulation && !capabilities.codeReportAvailable;

  if (capabilities && !capabilities.canViewTenant) return <div className="mx-auto max-w-[1480px] space-y-4 p-4 md:p-7 lg:p-9">
    <h2 className="text-2xl font-semibold">{t('title')}</h2>
    <p role="alert" className={`${panelClass} p-6 text-sm text-muted-foreground`}>{t('tenantReportDenied')}</p>
  </div>;

  return <ReportViewContext.Provider value={viewStore}><MetricDefinitionAccess.Provider value={capabilities?.canViewDefinitions === true}><div className="ai-report">
    {capabilities?.simulation && <div className="ai-report-appbar"><div className="ai-report-brand"><span className="ai-report-logo"><Layers3 className="h-4 w-4" /></span>CCUI<span className="ai-report-breadcrumb">/ <span>{t('redesign.tenantManagement')}</span> / <b>{t('redesign.title')}</b></span></div><span className="ai-report-appbar-note">{t('redesign.previewWorkspace')}</span></div>}
    <section className="ai-report-heading">
      <div><div className="flex flex-wrap items-center gap-3"><h2>{t('redesign.title')}</h2>{capabilities?.simulation && <span className="ai-report-badge">{t('redesign.demo')}</span>}</div><p>{t('redesign.subtitle')}</p></div>
      <div className="ai-report-heading-actions flex flex-wrap items-center gap-2"><Button size="sm" variant="ghost" aria-label={t('redesign.updates')} onClick={() => setStatusOpen(true)}><span className={`ai-report-status-dot ${showPartial ? 'partial' : ''}`} />{t('dataThrough')} {through?.slice(5).replace('-', '/') || '—'}{showPartial && <span className="ai-report-status-label">· {t('partial')}</span>}<ChevronDown className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant="outline" disabled={loading} aria-label={t('refresh')} title={t('refresh')} onClick={() => setRefreshConfirmOpen(true)}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
        {capabilities?.canExport && capabilities.canViewTenant && status?.batchId && <WorkbookDownload key={`${tenantId}:${status.batchId}`} tenantId={tenantId} batchId={status.batchId} through={through} views={viewStore} codeAvailable={Boolean(capabilities.codeReportAvailable)} disabled={loading || !ready} onAccessError={onAccessError} />}
      </div>
    </section>
    {status && ['failed', 'paused', 'running', 'disabled'].includes(status.state || '') && <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"><Clock3 className="mt-0.5 h-4 w-4 shrink-0" />{t(status.state || 'pending')} · {t('staleHint')}</p>}
    {Boolean(excludedSessionCount) && <p role="status" className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{t('sessionScopeConflictNotice', { count: excludedSessionCount })}</p>}
    {tenantId === 'all' && allTenantsCoverage && <p role="status" className="ai-report-coverage-note">{t('allTenantsCoverage', allTenantsCoverage)}</p>}
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{t(error)}</p>}
    {status?.batchId && capabilities && <SummaryCards key={`${tenantId}:${status.batchId}:${capabilities.canViewTenant}:${revision}`} tenantId={tenantId} batchId={status.batchId} capabilities={capabilities} onAccessError={onAccessError} />}
    <div className="ai-report-tabs" role="tablist" aria-label={t('title')}>{visibleTabs.map((key) => { const Icon = { usage: Activity, code: Code2, skills: Sparkles, hookExecutions: Activity, hooks: Webhook, templates: FileText }[key]; return <button key={key} type="button" role="tab" id={`ai-report-tab-${key}`} aria-selected={tab === key} aria-controls="ai-usage-tab-panel" className="ai-report-tab" onClick={() => selectTab(key)}><Icon className="h-4 w-4" />{t(key === 'code' ? 'codeReport.tab' : key)}</button>; })}</div>
    {status?.batchId && <form noValidate aria-label={t('sharedFilters')} className="ai-report-filters" onSubmit={(event) => { event.preventDefault(); const next = { ...draft, from: normalizeUsageDate(draft.from) ?? draft.from, to: normalizeUsageDate(draft.to) ?? draft.to }; setDraft(next); const problem = validateUsageRange(next.from, next.to, through); setRangeError(problem ? `range.${problem}` : ''); if (!problem) { setFilters(next); } }}>
      {(['from', 'to'] as const).map((key) => <ReportDateInput key={key} label={t(key)} calendarLabel={t('chooseDate', { label: t(key) })} max={through} value={draft[key]} onChange={(value) => setDraft(old => ({ ...old, [key]: value }))} />)}
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t(tab === 'skills' ? 'publisherNameFilter' : 'userName')}<input className={`${inputClass} w-40`} type="text" maxLength={150} value={draft.userName} placeholder={t('nameSearchPlaceholder')} onChange={(event) => setDraft({ ...draft, userName: event.target.value })} /></label>
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('workspaceName')}<input className={`${inputClass} w-40`} type="text" maxLength={150} value={draft.workspaceName} placeholder={t('nameSearchPlaceholder')} onChange={(event) => setDraft({ ...draft, workspaceName: event.target.value })} /></label>
      <Button type="submit" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => { const cleared = { ...defaultUsageRange(through), userName: '', workspaceName: '' }; setDraft(cleared); setFilters(cleared); setRangeError(''); }}>{t('resetFilters')}</Button><span className="ai-report-filters-note">{t('workbook.savedFilters')}</span>{rangeError && <p role="alert" className="w-full text-xs text-destructive">{t(rangeError)}</p>}
    </form>}
    <div id="ai-usage-tab-panel" role="tabpanel" aria-labelledby={`ai-report-tab-${tab}`} aria-busy={loading} className="space-y-4">
      {tab === 'hooks' && ready && status?.batchId && <AnalysisPanel key={childKey} tab="hooks" hookDirectory params={analysisParams} onAccessError={onAccessError} onDetails={setSelectedHook} />}
      {!status?.batchId ? <div className={`${panelClass} px-6 py-16 text-center`}><CalendarClock className="mx-auto h-9 w-9 text-muted-foreground/60" /><h3 className="mt-4 font-medium">{loading ? t('loading') : t('noBatch')}</h3><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{t('noBatchHint')}</p></div> : loading && !ready ? <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />{t('loading')}</div> : tab === 'usage' ? <SessionDetails key={childKey} params={analysisParams} onAccessError={onAccessError} /> : tab === 'code' ? legacyCodeDemo ? <DemoCodeReport key={childKey} tenantId={tenantId} batchId={status.batchId} filters={filters} timeZone={status.timeZone || 'Asia/Shanghai'} onAccessError={onAccessError} /> : <CodeReport key={childKey} params={analysisParams} onAccessError={onAccessError} /> : tab === 'skills' ? <SkillsReport key={`skills:${childKey}`} params={{ ...analysisParams, timeZone: status.timeZone }} onAccessError={onAccessError} /> : tab === 'templates' ? <TemplateReport key={childKey} params={analysisParams} onAccessError={onAccessError} /> : analysisPanel}
    </div>
    <footer className="ai-report-note"><span>{capabilities?.simulation ? t('redesign.simulationHint') : t('todayHint')}</span>{capabilities?.canViewDefinitions === true && <Button variant="ghost" size="sm" onClick={() => setDefinitionsOpen(true)}><CircleHelp className="h-3.5 w-3.5" />{t('redesign.definitions')}</Button>}</footer>
    {statusOpen && <Overlay title={t('redesign.updates')} onClose={() => setStatusOpen(false)} compact><p className="mb-3 text-xs text-muted-foreground">{t('nonRealtime')}</p><dl className="divide-y divide-border">{[[t('dataThrough'), through || '—'], [t('lastSuccess'), formatTime(status?.lastSucceededAt || status?.generatedAt)], [t('nextRun'), status?.nextRunAt ? formatTime(status.nextRunAt) : t('notScheduled')], [t('timeZone'), status?.timeZone || '—']].map(([label, value]) => <div className="flex flex-wrap justify-between gap-3 py-3 text-sm" key={label}><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl>{showPartial && <p className="ai-report-coverage-note"><AlertCircle className="h-4 w-4 shrink-0" />{t(excludedSessionCount > 0 ? 'sessionScopeConflictHint' : 'partialHint')}</p>}</Overlay>}
    {capabilities?.canViewDefinitions === true && definitionsOpen && <Overlay title={t('redesign.definitions')} onClose={() => setDefinitionsOpen(false)} compact><div className="space-y-4 text-sm leading-6 text-muted-foreground"><p>{t('summaryHint')}</p><p>{t('todayHint')}</p><p>{t('sharedFiltersHint')}</p><p>{t('durationHint')}</p>{excludedSessionCount > 0 && <p>{t('sessionScopeConflictHint')}</p>}<p>{t('workbook.hint')}</p>{legacyCodeDemo ? <><p>{t('codeReport.generatedHint')} · {t('codeReport.submittedHint')}</p><p>{t('codeReport.fixtureOnly')}</p></> : capabilities?.codeReportAvailable && <><p>{t('codeReport.generatedHint')}</p><p>{t('codeReport.realSubmittedHint')}</p></>}</div></Overlay>}
    {tab === 'hooks' && ready && selectedHook && status?.batchId && <Overlay title={`${selectedHook.hookName || selectedHook.hookId} · ${t('singleHookReport')}`} onClose={() => setSelectedHook(null)} fullHeight>
      <HookReportPanel key={`${childKey}:${selectedHook.hookId}`} row={selectedHook} params={{ ...analysisParams, timeZone: status.timeZone }} through={through} onAccessError={onAccessError} />
    </Overlay>}
    {refreshConfirmOpen && <Overlay title={t('refreshConfirmTitle')} onClose={() => setRefreshConfirmOpen(false)} compact><p className="text-sm leading-6 text-muted-foreground">{t('refreshConfirmMessage')}</p><div className="mt-6 flex justify-end gap-3"><Button variant="outline" onClick={() => setRefreshConfirmOpen(false)}>{t('cancel')}</Button><Button disabled={loading} onClick={() => { setRefreshConfirmOpen(false); setRevision((value) => value + 1); }}>{t('confirmRefresh')}</Button></div></Overlay>}
  </div></MetricDefinitionAccess.Provider></ReportViewContext.Provider>;
}
