import { assertPublishedBatch } from './usageUtils';
import type { UsageCapabilities, UsageRow, UsageScope } from './types';

export type UsageSummary = UsageRow & {
  batchId: string; summaryVersion: number; scope: UsageScope;
  from: string; to: string; activityDate: string; mauFrom: string;
};

// Use published reporting dates, never the browser clock or interactive filters.
export function summaryPeriods(summary: UsageSummary | null) {
  const full = (date?: string) => date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, '/') : '—';
  const compact = (date?: string) => full(date) === '—' ? '—' : full(date).slice(5);
  const range = (from?: string, to?: string) => {
    if (full(from) === '—' || full(to) === '—') return '—';
    const format = from!.slice(0, 4) === to!.slice(0, 4) ? compact : full;
    return `${format(from)}–${format(to)}`;
  };
  return {
    cutoff: full(summary?.to),
    sessionCount: range(summary?.from, summary?.to),
    publishedSkillCount: compact(summary?.to),
    dau: summary?.activityDate?.slice(0, 4) === summary?.to?.slice(0, 4)
      ? compact(summary?.activityDate) : full(summary?.activityDate),
    mau: range(summary?.mauFrom, summary?.to),
  };
}

// Deliberately accept no report filters, pagination, grouping or selected scope.
export function summaryRequestParams(tenantId: number, batchId: string, capabilities: UsageCapabilities) {
  return { tenantId, batchId, scope: capabilities.canViewTenant ? 'tenant' as const : 'self' as const };
}

export function assertUsageSummary(value: UsageSummary, batchId: string, scope: UsageScope) {
  assertPublishedBatch(value, batchId);
  if (value.summaryVersion !== 1 || value.scope !== scope) throw new Error('summaryUnavailable');
  return value;
}
