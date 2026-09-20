import { useEffect, useState } from 'react';
import { MessageSquare, RefreshCw, Sparkles, UserCheck, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usageRequest, UsageApiError } from './client';
import { isUsageAccessFailure, usageFailureKey } from './requestState';
import { assertUsageSummary, summaryPeriods, summaryRequestParams, type UsageSummary } from './summaryState';
import { displayReportValue } from './usageUtils';
import type { UsageCapabilities } from './types';

const cards = [
  { key: 'sessionCount', title: 'summarySessions', hint: 'summaryRange', period: 'rolling', icon: MessageSquare },
  { key: 'publishedSkillCount', title: 'summaryPublications', hint: 'summaryPublicationHint', period: 'cumulative', icon: Sparkles },
  { key: 'dau', title: 'dau', hint: 'summaryDay', period: 'day', icon: UserCheck },
  { key: 'mau', title: 'mau', hint: 'summaryRange', period: 'rolling', icon: Users },
] as const;

export default function SummaryCards({ tenantId, batchId, capabilities, onAccessError }: {
  tenantId: number; batchId: string; capabilities: UsageCapabilities; onAccessError: () => void;
}) {
  const { t } = useTranslation('aiUsage');
  const [result, setResult] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const queryKey = JSON.stringify(summaryRequestParams(tenantId, batchId, capabilities));
  const [loadedKey, setLoadedKey] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const params = JSON.parse(queryKey);
    setLoading(true); setError(''); setResult(null);
    void usageRequest<UsageSummary>('summary', params, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setResult(assertUsageSummary(value, params.batchId, params.scope)); setLoadedKey(queryKey);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setResult(null);
      if (isUsageAccessFailure(caught)) onAccessError();
      else setError(usageFailureKey(caught, caught instanceof Error && caught.message === 'batchMismatch' ? 'batchMismatch'
        : caught instanceof SyntaxError || (caught instanceof UsageApiError && caught.status === 404) || (caught instanceof Error && caught.message === 'summaryUnavailable') ? 'summaryUnavailable' : 'summaryFailed'));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [queryKey, onAccessError]);
  const current = !error && loadedKey === queryKey ? result : null;
  const periods = summaryPeriods(current);

  return <section aria-label={t('summaryTitle')} aria-busy={loading} className="ai-report-summary space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{t('summaryTitle')} · {t('tenantScope')}</h3>
        <p className="ai-report-summary-cutoff">{t('dataThrough')} <span>{periods.cutoff}</span></p>
      </div>
      <p className="text-xs text-muted-foreground">{t('summaryHint')}</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{t(error)}</p>}
    <div className="ai-report-summary-grid">
      {cards.map(({ key, title, hint, period, icon: Icon }) => <div key={key} className="ai-report-summary-card">
        <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">{t(title)}</span><Icon className="h-4 w-4 shrink-0 text-primary/70" /></div>
        <p className="ai-report-summary-value">{loading ? <RefreshCw aria-label={t('loading')} className="h-7 w-7 animate-spin text-muted-foreground" /> : displayReportValue(current?.[key])}</p>
        <p className="ai-report-summary-period" title={t(hint, { from: (key === 'mau' ? current?.mauFrom : current?.from) || '—', date: (key === 'dau' ? current?.activityDate : current?.to) || '—' })}>
          <span className="ai-report-summary-period-label">{t(`summaryPeriod.${period}`)}</span>
          <span>{key === 'publishedSkillCount' ? t('summaryThrough', { date: periods[key] }) : periods[key]}</span>
        </p>
      </div>)}
    </div>
    <p className="text-xs text-muted-foreground">{t('summaryPeriodHint')}</p>
    {!loading && current && current.dau == null && <p className="text-xs text-muted-foreground">{t('activityPending')}</p>}
  </section>;
}
