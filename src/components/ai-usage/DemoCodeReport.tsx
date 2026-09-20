import { useContext, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';
import { usageRequest } from './client';
import { ReportExportAccess } from './ReportExportContext';
import { useReportView } from './ReportViewContext';
import { ReportPagination, ReportTable, type ReportColumn, type ReportSort } from './ReportTable';
import { downloadReportCsv, reportCsv, reportExportFilename } from './reportExport';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { nextReportSort } from './analysisState';
import { codeGroupKey, filterDemoCode, groupDemoCode, summarizeDemoCode, type CodeGroup, type DemoCodeFact } from './demoCodeData';
import { usageFilterParams, type UsageFilters } from './filterState';
import { loadSqlCodeFacts } from './sqlCodeData';
import ReportIdentity from './ReportIdentity';
import ReportGrouping from './ReportGrouping';
import { isTimeGroup, reportGroupLabel } from './groupingState';
import type { UsageCapabilities, UsageRow } from './types';
import Overlay from './ReportOverlay';
import ReportTrend from './ReportTrend';

export default function DemoCodeReport({ tenantId, batchId, filters, timeZone, onAccessError }: {
  tenantId: number; batchId: string; filters: UsageFilters; timeZone: string; onAccessError: () => void;
}) {
  const { t } = useTranslation('aiUsage');
  const allowed = useContext(ReportExportAccess);
  const [view, setView] = useReportView('demo-code', JSON.stringify([tenantId, batchId, filters]), {
    groupBy: 'user' as CodeGroup, page: 1, pageSize: 20,
    sort: { sortBy: 'generatedLines', sortDir: 'desc' } as ReportSort,
  });
  const [detail, setDetail] = useState<string | null>(null);
  const [detailPage, setDetailPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const [sqlFacts, setSqlFacts] = useState<DemoCodeFact[] | null>(null);
  const [error, setError] = useState('');
  const sourceKey = JSON.stringify({ tenantId, scope: 'tenant', batchId, ...usageFilterParams(filters) });
  const [loadedSourceKey, setLoadedSourceKey] = useState('');
  const ready = sqlFacts !== null && loadedSourceKey === sourceKey && !error;
  const groupBy: CodeGroup = ['user', 'workspace', 'day', 'week', 'month'].includes(view.groupBy) ? view.groupBy : 'user';
  useEffect(() => {
    const abort = new AbortController();
    setSqlFacts(null); setError('');
    void loadSqlCodeFacts(JSON.parse(sourceKey), abort.signal, usageRequest, timeZone).then(facts => {
      if (!abort.signal.aborted) { setSqlFacts(facts); setLoadedSourceKey(sourceKey); }
    }).catch(caught => {
      if (abort.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError(); else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'batchMismatch' ? 'batchMismatch' : 'requestFailed'));
    });
    return () => abort.abort();
  }, [sourceKey, timeZone, onAccessError]);
  const controller = useRef<AbortController | null>(null);
  // Previously saved ratio sorting must not keep sorting by a removed metric.
  const sort: ReportSort = ['groupLabel', 'generatedLines', 'submittedLines'].includes(view.sort.sortBy)
    ? view.sort : { sortBy: 'generatedLines', sortDir: 'desc' };
  const queryKey = JSON.stringify([sourceKey, groupBy, sort, allowed]);
  useEffect(() => {
    setDetail(null); setDetailPage(1); setExporting(false); setMessage('');
    return () => { controller.current?.abort(); controller.current = null; };
  }, [queryKey]);
  const facts = ready ? [...sqlFacts!, ...filterDemoCode(filters)] : [];
  const summary = summarizeDemoCode(facts);
  const rows: UsageRow[] = groupDemoCode(facts, groupBy).sort((a, b) => {
    const va = (a as Record<string, unknown>)[sort.sortBy], vb = (b as Record<string, unknown>)[sort.sortBy];
    if (va == null) return vb == null ? 0 : 1;
    if (vb == null) return -1;
    const order = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'zh-CN');
    return order * (sort.sortDir === 'asc' ? 1 : -1) || a.groupLabel.localeCompare(b.groupLabel);
  });
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
  const columns: ReportColumn[] = [
    { key: 'groupLabel', title: t(`group.${groupBy}`), sortKey: 'groupLabel', exportValue: row => reportGroupLabel(groupBy, row.groupLabel, filters), render: row => ['user', 'workspace'].includes(groupBy) ? <ReportIdentity name={String(row.groupLabel)} kind={groupBy} /> : reportGroupLabel(groupBy, row.groupLabel, filters) },
    ...(groupBy === 'user' ? [{ key: 'workspaceName', title: t('workspaceName') }] : []),
    { key: 'generatedLines', title: t('codeReport.generated'), sortKey: 'generatedLines', numeric: true },
    { key: 'submittedLines', title: t('codeReport.submitted'), sortKey: 'submittedLines', numeric: true },
    { key: 'records', title: '', render: row => <Button variant="ghost" size="sm" onClick={() => { setDetail(String(row.groupKey)); setDetailPage(1); }}>{t('codeReport.records')}<ArrowUpRight className="h-3.5 w-3.5" /></Button> },
  ];
  const trend = groupDemoCode(facts, 'day').sort((a, b) => a.groupLabel.localeCompare(b.groupLabel)).map(row => ({ date: row.groupLabel, generatedLines: row.generatedLines, submittedLines: row.submittedLines }));
  const exportRows = async () => {
    if (!allowed || !ready || controller.current) return;
    const active = new AbortController(); controller.current = active; setExporting(true); setMessage('');
    try {
      // Even synthetic downloads preserve live report permission checks.
      const access = await usageRequest<UsageCapabilities>('capabilities', { tenantId }, active.signal);
      if (!access.canViewTenant || !access.canExport || !access.simulation) { onAccessError(); return; }
      active.signal.throwIfAborted();
      downloadReportCsv(reportCsv(columns, rows), reportExportFilename(`${t('codeReport.tab')}_${t('redesign.demo')}`, { ...filters, groupBy }));
      setMessage(t('exportComplete', { count: rows.length }));
    } catch (caught) {
      if (active.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError(); else setMessage(t('exportFailed'));
    } finally { if (controller.current === active) { controller.current = null; setExporting(false); } }
  };
  const detailFacts = facts.filter(row => codeGroupKey(row, groupBy) === detail && row.submittedLines > 0);
  return <>
    {error && <p role="alert" className="ai-report-error">{t(error)}</p>}
    <section className="ai-report-trend" aria-label={t('codeReport.title')} aria-busy={!ready && !error}>
      <div className="ai-code-metrics">{[
        [t('codeReport.generated'), ready ? number(summary.generatedLines) : '—', t('codeReport.generatedHint')],
        [t('codeReport.submitted'), ready ? number(summary.submittedLines) : '—', t('codeReport.submittedHint')],
      ].map(([label, value, hint]) => <div key={label}><span>{label}</span><strong>{value}</strong><p>{hint}</p></div>)}</div>
      <header><h3>{t('codeReport.trend')}</h3><div className="ai-code-legend"><span><i className="secondary" />{t('codeReport.generatedShort')}</span><span><i />{t('codeReport.submittedShort')}</span></div></header>
      {facts.length ? <ReportTrend rows={trend} series={[{ key: 'generatedLines', label: t('codeReport.generatedShort'), secondary: true }, { key: 'submittedLines', label: t('codeReport.submittedShort') }]} unit={t('codeReport.lines')} label={t('codeReport.trend')} /> : <p className="p-10 text-center text-muted-foreground">{t(!ready && !error ? 'loading' : 'empty')}</p>}
      <footer><span>{filters.from} — {filters.to} · {t('codeReport.daily')}</span><span className="ai-report-badge">{t('codeReport.fixtureOnly')}</span></footer>
    </section>
    <section className="ai-report-panel" aria-label={t('codeReport.table')}>
      <header className="ai-report-section-head"><div><h3>{t('codeReport.table')}</h3><p className="ai-report-caption">{t('codeReport.tableHint')}</p></div><div className="ai-report-local-controls">
        <ReportGrouping value={groupBy} options={['user','workspace','day','week','month']} onChange={value => setView(old => ({ ...old, groupBy: value as CodeGroup, page: 1, sort: isTimeGroup(value) ? { sortBy: 'groupLabel', sortDir: 'asc' } : old.sort }))} />
        {allowed && <Button data-report-export type="button" size="sm" variant="outline" disabled={exporting || !ready} aria-label={t('exportCurrent')} title={t('exportCurrent')} onClick={() => void exportRows()}><ArrowDownToLine className="h-4 w-4" /></Button>}
      </div>{message && <span role="status" className="w-full text-xs text-muted-foreground">{message}</span>}</header>
      <ReportTable columns={columns} rows={rows.slice((view.page - 1) * view.pageSize, view.page * view.pageSize)} empty={t('empty')} sort={sort} onSort={key => setView(old => ({ ...old, sort: nextReportSort(sort, key), page: 1 }))} />
      <ReportPagination page={view.page} pageSize={view.pageSize} total={rows.length} onPage={page => setView(old => ({ ...old, page }))} onPageSize={pageSize => setView(old => ({ ...old, pageSize, page: 1 }))} />
    </section>
    {detail && <Overlay title={`${reportGroupLabel(groupBy, rows.find(row => row.groupKey === detail)?.groupLabel || detail, filters)} · ${t('codeReport.records')}`} onClose={() => setDetail(null)}>
      <p className="mb-4 text-xs text-muted-foreground">{t('codeReport.fixtureOnly')} · {t('codeReport.submittedHint')}</p>
      <ReportTable columns={[
        { key: 'date', title: t('createdAt') }, { key: 'userName', title: t('userName') }, { key: 'workspaceName', title: t('workspaceName') },
        { key: 'repository', title: t('codeReport.repository') }, { key: 'commitSha', title: t('codeReport.commit') },
        { key: 'submittedLines', title: t('codeReport.submitted'), numeric: true },
      ]} rows={detailFacts.slice((detailPage - 1) * 20, detailPage * 20)} empty={t('empty')} />
      <ReportPagination page={detailPage} total={detailFacts.length} onPage={setDetailPage} />
    </Overlay>}
  </>;
}
