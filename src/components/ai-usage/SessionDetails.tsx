import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { nextReportSort } from './analysisState';
import { usageRequest } from './client';
import { sessionDetailColumns, sessionDetailSort } from './sessionDetailColumns';
import { ReportPagination, ReportTable, type ReportSort } from './ReportTable';
import { useReportView } from './ReportViewContext';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import type { UsageList } from './types';
import { assertPublishedBatch } from './usageUtils';

type SessionResult = UsageList & { sessionDetailVersion: number };

export default function SessionDetails({ params, onAccessError }: { params: Record<string, unknown>; onAccessError: () => void }) {
  const { t } = useTranslation('aiUsage');
  const queryKey = JSON.stringify(params);
  const [view, setView] = useReportView('session-details', queryKey, {
    sort: { sortBy: 'startTime', sortDir: 'desc' } as ReportSort, page: 1, pageSize: 20,
  });
  const { page, pageSize } = view;
  const sort = sessionDetailSort(view.sort);
  const sortKey = JSON.stringify(sort);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const query = { ...JSON.parse(queryKey), ...JSON.parse(sortKey), page, pageSize };
    setLoading(true); setError(''); setResult(null);
    void usageRequest<SessionResult>('session-details', query, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(next, String(query.batchId));
      if (next.sessionDetailVersion !== 1) throw new Error('sessionDetailsNotReady');
      setResult(next);
    }).catch(caught => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && ['sessionDetailsNotReady', 'batchMismatch'].includes(caught.message) ? caught.message : 'requestFailed'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, sortKey, page, pageSize, onAccessError]);
  return <section className="ai-report-panel ai-report-session-details overflow-hidden rounded-xl border border-border bg-card" aria-label={t('sessionDetails.title')}>
    <header className="ai-report-section-head"><div><h3>{t('sessionDetails.title')}</h3><p className="mt-2 text-xs leading-6 text-muted-foreground">{t('sessionDetails.hint')}</p></div></header>
    {error && <p role="alert" className="p-5 text-sm text-destructive">{t(error)}</p>}
    {loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p> : !error ? <ReportTable
      columns={sessionDetailColumns(t)} rows={result?.items || []} empty={t('empty')} sort={sort}
      onSort={key => setView(old => ({ ...old, sort: nextReportSort(sessionDetailSort(old.sort), key), page: 1 }))} /> : null}
    <ReportPagination page={page} total={result?.total || 0} pageSize={pageSize} disabled={loading || Boolean(error)}
      onPage={value => setView(old => ({ ...old, page: value }))} onPageSize={value => setView(old => ({ ...old, pageSize: value, page: 1 }))} />
  </section>;
}
