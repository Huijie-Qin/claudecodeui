import type { UsageList, UsageRow } from './types';

export function isUsageAccessFailure(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'status' in error
    && (error.status === 401 || error.status === 403);
}

export function usageFailureKey(error: unknown, fallback = 'requestFailed'): string {
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'reportUpdated') return 'batchMismatch';
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'integrationNotReady') return 'integrationNotReady';
  if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'splitNotReady') return 'splitNotReady';
  return fallback;
}

export type UsageDetailData = { list: UsageList | null; statistics: UsageRow[] };
type DetailAction = { type: 'request_started' | 'request_failed' } | { type: 'succeeded'; list: UsageList; statistics: UsageRow[] };

export const emptyUsageDetailData = (): UsageDetailData => ({ list: null, statistics: [] });

export function usageDetailReducer(_state: UsageDetailData, action: DetailAction): UsageDetailData {
  if (action.type === 'succeeded') return { list: action.list, statistics: action.statistics };
  // A failed/unauthorized refresh must never leave old Hook field summaries visible.
  return emptyUsageDetailData();
}
