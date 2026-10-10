import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import MetricDefinition from './MetricDefinition';
import { usageRequest } from './client';
import { nextReportSort } from './analysisState';
import { useReportView } from './ReportViewContext';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { assertPublishedBatch, displayReportValue, formatReportTimestamp } from './usageUtils';
import { isTimeGroup, reportGroupLabel } from './groupingState';
import { ReportPagination, ReportTable, type ReportColumn, type ReportSort } from './ReportTable';
import ReportGrouping from './ReportGrouping';
import ReportIdentity from './ReportIdentity';
import ReportTrend from './ReportTrend';
import Overlay from './ReportOverlay';
import type { UsageList, UsageRow } from './types';

type CodeResult = UsageList & { summary: UsageRow | null; trend: UsageRow[]; codeReportVersion: number };

// Real code reporting never imports demoCodeData or scans generic Hook records.
export default function CodeReport({ params, onAccessError }: { params: Record<string, unknown>; onAccessError: () => void }) {
  const { t } = useTranslation('aiUsage');
  const key = JSON.stringify(params);
  const [view, setView] = useReportView('code', key, { groupBy: 'user', page: 1, pageSize: 20,
    sort: { sortBy: 'generatedLines', sortDir: 'desc' } as ReportSort });
  const [result, setResult] = useState<CodeResult | null>(null);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<UsageRow | null>(null);
  const { groupBy, page, pageSize, sort } = view;
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setError(''); setDetail(null);
    void usageRequest<CodeResult>('code', { ...JSON.parse(key), groupBy, page, pageSize, ...sort }, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(next, String(JSON.parse(key).batchId));
      if (next.codeReportVersion !== 1) throw new Error('codeReportUnavailable');
      setResult(next);
    }).catch(caught => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError(); else setError(usageFailureKey(caught));
    });
    return () => controller.abort();
  }, [key, groupBy, page, pageSize, sort, onAccessError]);
  const scope = { from: String(params.from), to: String(params.to) };
  const label = (row: UsageRow) => reportGroupLabel(groupBy, displayReportValue(row.groupLabel), scope);
  const columns: ReportColumn[] = [
    { key: 'groupLabel', title: t(`group.${groupBy}`), sortKey: 'groupLabel', exportValue: label,
      render: row => ['user', 'workspace'].includes(groupBy) ? <ReportIdentity name={displayReportValue(row.groupLabel)} kind={groupBy} /> : label(row) },
    { key: 'generatedLines', title: t('codeReport.generated'), sortKey: 'generatedLines', numeric: true },
    { key: 'submittedLines', title: t('codeReport.realSubmitted'), sortKey: 'submittedLines', numeric: true },
    { key: 'records', title: '', render: row => <Button variant="ghost" size="sm" onClick={() => setDetail(row)}>{t('codeReport.records')}<ArrowUpRight className="h-3.5 w-3.5" /></Button> },
  ];
  const number = (value: unknown) => typeof value === 'number' ? value.toLocaleString() : '—';
  return <>
    {error && <p role="alert" className="ai-report-error">{t(error)}</p>}
    <section className="ai-report-trend" aria-label={t('codeReport.title')} aria-busy={!result && !error}>
      <div className="ai-code-metrics">{[
        [t('codeReport.generated'), number(result?.summary?.generatedLines), t('splitGeneratedHint')],
        [t('codeReport.realSubmitted'), number(result?.summary?.submittedLines), t('codeReport.realSubmittedHint')],
      ].map(([title, value, hint]) => <div key={title}><span>{title}</span><strong>{value}</strong><MetricDefinition><p>{hint}</p></MetricDefinition></div>)}</div>
      {Boolean(result?.summary?.unknownSqlRecords || result?.summary?.unknownSubmissions) && <p className="ai-report-coverage-note">{t('codeReport.unknownValues')}</p>}
      <header><h3>{t('codeReport.trend')}</h3><div className="ai-code-legend"><span><i className="secondary" />{t('codeReport.generatedShort')}</span><span><i />{t('codeReport.realSubmittedShort')}</span></div></header>
      {result?.trend.length ? <ReportTrend rows={result.trend.map(row => ({ date: String(row.date),
        generatedLines: typeof row.generatedLines === 'number' ? row.generatedLines : null,
        submittedLines: typeof row.submittedLines === 'number' ? row.submittedLines : null }))}
        series={[{ key: 'generatedLines', label: t('codeReport.generatedShort'), secondary: true }, { key: 'submittedLines', label: t('codeReport.realSubmittedShort') }]}
        unit={t('codeReport.lines')} label={t('codeReport.trend')} /> : <p className="p-10 text-center text-muted-foreground">{t(!result && !error ? 'loading' : 'empty')}</p>}
      <footer><span>{scope.from} — {scope.to} · {t('codeReport.daily')}</span></footer>
    </section>
    <section className="ai-report-panel" aria-label={t('codeReport.table')}>
      <header className="ai-report-section-head"><div><h3>{t('codeReport.table')}</h3><MetricDefinition><p className="ai-report-caption">{t('codeReport.tableHint')}</p></MetricDefinition></div>
        <div className="ai-report-local-controls"><ReportGrouping value={groupBy} options={['user', 'workspace', 'day', 'week', 'month']}
          onChange={value => setView(old => ({ ...old, groupBy: value, page: 1, sort: isTimeGroup(value) ? { sortBy: 'groupLabel', sortDir: 'asc' } : { sortBy: 'generatedLines', sortDir: 'desc' } }))} />
          </div>
      </header>
      <ReportTable columns={columns} rows={result?.items || []} empty={t(!result && !error ? 'loading' : 'empty')} sort={sort}
        onSort={key => setView(old => ({ ...old, sort: nextReportSort(sort, key), page: 1 }))} />
      <ReportPagination page={page} pageSize={pageSize} total={result?.total || 0} onPage={page => setView(old => ({ ...old, page }))}
        onPageSize={pageSize => setView(old => ({ ...old, pageSize, page: 1 }))} />
    </section>
    {detail && <Overlay title={`${label(detail)} · ${t('codeReport.records')}`} onClose={() => setDetail(null)}>
      <CodeRecords params={{ ...params, groupBy, groupKey: detail.groupKey }} onAccessError={onAccessError} />
    </Overlay>}
  </>;
}

function CodeRecords({ params, onAccessError }: { params: Record<string, unknown>; onAccessError: () => void }) {
  const { t, i18n } = useTranslation('aiUsage');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<UsageList | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(params);
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setError('');
    void usageRequest<UsageList>('code-records', { ...JSON.parse(key), page, pageSize: 20 }, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(next, String(JSON.parse(key).batchId)); setResult(next);
    }).catch(caught => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError(); else setError(usageFailureKey(caught));
    });
    return () => controller.abort();
  }, [key, page, onAccessError]);
  const timestamp = (row: UsageRow) => formatReportTimestamp(row.occurredAt, 'Asia/Shanghai', i18n.language);
  const columns: ReportColumn[] = [
    { key: 'submissionId', title: t('codeReport.submissionId') },
    { key: 'occurredAt', title: t('codeReport.mergedAt'), render: timestamp, exportValue: timestamp },
    { key: 'userName', title: t('userName') }, { key: 'workspaceName', title: t('workspaceName') },
    { key: 'repositoryUrl', title: t('codeReport.realRepository') }, { key: 'commitSha', title: t('codeReport.realCommit') },
    { key: 'submittedLines', title: t('codeReport.realSubmitted'), numeric: true },
  ];
  return <><div className="mb-4 flex items-start justify-between gap-4"><MetricDefinition><p className="text-xs text-muted-foreground">{t('codeReport.realSubmittedHint')}</p></MetricDefinition>
    </div>
    {error && <p role="alert" className="ai-report-error">{t(error)}</p>}
    <ReportTable columns={columns} rows={result?.items || []} empty={t(!result && !error ? 'loading' : 'empty')} />
    <ReportPagination page={page} pageSize={20} total={result?.total || 0} onPage={setPage} />
  </>;
}
