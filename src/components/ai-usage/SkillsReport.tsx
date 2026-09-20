import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import { nextReportSort } from './analysisState';
import { usageRequest } from './client';
import ReportExportButton from './ReportExportButton';
import ReportIdentity from './ReportIdentity';
import ReportGrouping from './ReportGrouping';
import { ReportPagination, ReportTable, type ReportColumn, type ReportSort } from './ReportTable';
import { useReportView } from './ReportViewContext';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { assertPublishedBatch, displayReportValue as display, formatReportTimestamp } from './usageUtils';
import type { UsageList, UsageRow } from './types';

const inputClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground';
type SkillResult = UsageList & { skillGroupingVersion: number; summary: UsageRow | null };

export default function SkillsReport({ params, onAccessError }: { params: Record<string, unknown>; onAccessError: () => void }) {
  const { t, i18n } = useTranslation('aiUsage');
  const queryKey = JSON.stringify(params);
  const [view, setView] = useReportView('skills', queryKey, { groupBy: 'skill', sort: { sortBy: 'invocationCount', sortDir: 'desc' } as ReportSort, page: 1, pageSize: 20, draft: '', search: '' });
  const { groupBy, sort, page, pageSize, draft, search } = view;
  const [result, setResult] = useState<SkillResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const query = { ...JSON.parse(queryKey), groupBy, ...sort, page, pageSize, search };
    setLoading(true); setError(''); setResult(null);
    void usageRequest<SkillResult>('skills', query, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      assertPublishedBatch(next, String(query.batchId));
      if (next.groupBy !== groupBy || next.skillGroupingVersion !== 1) throw new Error('skillGroupingUnavailable');
      setResult(next);
    }).catch(caught => {
      if (controller.signal.aborted) return;
      if (isUsageAccessFailure(caught)) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'skillGroupingUnavailable' ? caught.message : 'requestFailed'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, groupBy, sort, page, pageSize, search, onAccessError]);
  const timestamp = (value: unknown) => formatReportTimestamp(value, String(params.timeZone || 'Asia/Shanghai'), i18n.language);
  const columns: ReportColumn[] = [
    ...(groupBy === 'skill' ? [{ key: 'skillName', title: t('skillName'), sortKey: 'skillName', render: (row: UsageRow) => <ReportIdentity name={display(row.skillName)} kind="skill" subtitle={`#${display(row.skillId)}`} /> }] : []),
    { key: 'publisherName', title: t('publisher'), sortKey: 'publisherName', render: row => <ReportIdentity name={display(row.publisherName)} /> },
    ...(groupBy === 'skill' ? [{ key: 'firstPublishedAt', title: t('firstPublishedAt'), sortKey: 'firstPublishedAt', render: (row: UsageRow) => timestamp(row.firstPublishedAt), exportValue: (row: UsageRow) => timestamp(row.firstPublishedAt) }] : []),
    { key: 'publishedSkillCount', title: t('periodPublishedSkills'), sortKey: 'publishedSkillCount' },
    { key: 'invocationCount', title: t('skillInvocationCount'), sortKey: 'invocationCount' },
    { key: 'callerCount', title: t('callerCount'), sortKey: 'callerCount' },
    { key: 'lastInvokedAt', title: t('lastInvokedAt'), sortKey: 'lastInvokedAt', render: row => timestamp(row.lastInvokedAt), exportValue: row => timestamp(row.lastInvokedAt) },
  ];
  return <section className="ai-report-panel overflow-hidden rounded-xl border border-border bg-card" aria-label={t('skillsTitle')}>
    <header className="ai-report-section-head"><div className="ai-report-section-title"><h3>{t('skillsTitle')}</h3><details className="ai-report-help"><summary>{t('redesign.definitions')}</summary><p>{t('skillsHint')}</p></details></div>
    <form aria-label={t('tableFilters')} className="ai-report-local-controls" onSubmit={event => { event.preventDefault(); setView(old => ({ ...old, search: draft.trim(), page: 1 })); }}>
      <ReportGrouping value={groupBy} options={['skill','publisher']} labels={{ publisher: t('publisher') }} onChange={value => setView(old => ({ ...old, groupBy: value, page: 1, sort: { sortBy: 'invocationCount', sortDir: 'desc' } }))} />
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t('skillNameFilter')}<input className={inputClass} maxLength={150} placeholder={t('nameSearchPlaceholder')} value={draft} onChange={event => setView(old => ({ ...old, draft: event.target.value }))} /></label>
      <Button type="submit" variant="outline" disabled={loading}>{t('apply')}</Button><Button type="button" variant="ghost" onClick={() => setView(old => ({ ...old, draft: '', search: '', page: 1 }))}>{t('redesign.reset')}</Button>
      <ReportExportButton compact endpoint="skills" params={{ ...params, groupBy, ...sort, search }} columns={columns} total={result?.total || 0} title={t('skillsTitle')} disabled={loading || !result || Boolean(error)} onAccessError={onAccessError} />
    </form></header>
    {error && <p role="alert" className="p-5 text-sm text-destructive">{t(error)}</p>}
    {loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">{t('loading')}</p> : <>
      <div className="ai-report-totals border-b border-border"><p className="text-xs text-muted-foreground">{t('matchingSummary', { total: result?.total || 0 })}</p><div className="flex flex-wrap">{[['publishedSkillCount','periodPublishedSkills'],['invocationCount','skillInvocationCount'],['callerCount','callerCount']].map(([key,label]) => <div key={key}><p className="text-xs text-muted-foreground">{t(label)}</p><p className="mt-1 font-semibold tabular-nums">{display(result?.summary?.[key])}</p></div>)}</div></div>
      <ReportTable columns={columns} rows={result?.items || []} empty={t('empty')} sort={sort} onSort={key => setView(old => ({ ...old, sort: nextReportSort(old.sort, key), page: 1 }))} />
    </>}
    <ReportPagination page={page} total={result?.total || 0} pageSize={pageSize} disabled={loading} onPage={value => setView(old => ({ ...old, page: value }))} onPageSize={value => setView(old => ({ ...old, pageSize: value, page: 1 }))} />
  </section>;
}
