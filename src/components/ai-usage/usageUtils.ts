import type { Coverage } from './types';

export function displayReportValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'number') return value.toLocaleString();
  return typeof value === 'string' || typeof value === 'boolean' ? String(value) : '—';
}

function reportName(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || '—';
}

export function reportUserName(row: Record<string, unknown>): string {
  return reportName(row.user_name, row.userName, row.username, row.displayName);
}

export function reportWorkspaceName(row: Record<string, unknown>): string {
  return reportName(row.workspaceName, row.workspace_name);
}

export function coverageStatus(coverage?: Coverage): string {
  return typeof coverage === 'string' ? coverage : coverage?.status || 'unavailable';
}

export function formatUsageDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function formatExecutionDuration(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return `${Number(value.toFixed(2))} ms`;
  if (value < 60000) return `${Number((value / 1000).toFixed(2))} s`;
  return formatUsageDuration(value);
}

export function buildUsageUrl(path: string, params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  });
  return `/api/ai-usage/${path}?${query}`;
}

export function dateInZone(value: string, timeZone = 'Asia/Shanghai'): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map((name) => parts.find((part) => part.type === name)?.value).join('-');
}

export function formatReportTimestamp(value: unknown, timeZone = 'Asia/Shanghai', locale = 'zh-CN'): string {
  if (typeof value !== 'string' || !value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}

export function defaultUsageRange(lastDate: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastDate)) return { from: '', to: '' };
  const first = new Date(`${lastDate}T12:00:00Z`);
  first.setUTCDate(first.getUTCDate() - 29);
  return { from: first.toISOString().slice(0, 10), to: lastDate };
}

export function validateUsageRange(from: string, to: string, through: string): 'required' | 'order' | 'unpublished' | null {
  if (!from || !to) return 'required';
  if (from > to) return 'order';
  if (!through || to > through) return 'unpublished';
  return null;
}

export function assertPublishedBatch<T extends { batchId?: string | null }>(value: T, expected: string): T {
  if (String(value.batchId || '') !== String(expected)) throw new Error('batchMismatch');
  return value;
}

export function reportFields(value: unknown): Array<{ key: string; label: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter((field) => field && typeof field === 'object' && typeof field.key === 'string').map((field) => ({
    key: field.key, label: typeof field.label === 'string' ? field.label : field.key,
    value: typeof field.value === 'string' || typeof field.value === 'number' || typeof field.value === 'boolean' ? field.value : null,
  }));
}

export const hookNumberMetrics = [
  { key: 'sum', title: 'hookReportFields.sum' },
  { key: 'average', title: 'hookReportFields.avg' },
  { key: 'min', title: 'hookReportFields.min' },
  { key: 'max', title: 'hookReportFields.max' },
] as const;

export type HookNumberMetric = typeof hookNumberMetrics[number]['key'];

export function isHookNumberMetric(value: unknown): value is HookNumberMetric {
  return hookNumberMetrics.some(({ key }) => key === value);
}

// Preserve non-statistic sorting. If the result column was sorted, switching
// its displayed metric must also switch the server-side sort key.
export function hookStatisticSort<T extends { sortBy: string }>(sort: T, metric: HookNumberMetric): T {
  return isHookNumberMetric(sort.sortBy) && sort.sortBy !== metric ? { ...sort, sortBy: metric } : sort;
}

export function formatHookNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return displayReportValue(value);
}

export function hookRecordDetailFilters(row: Record<string, unknown>): Record<string, unknown> {
  // A Hook group covers all its actions/versions/types within the page filters.
  // Field-statistic rows still pin their exact identity below.
  if (row.allHookRecords === true) return {};
  return {
    postActionId: row.postActionId ?? '__unknown__', recordType: row.recordType ?? '__unknown__',
    hookVersion: row.hookVersion ?? '__unknown__', recordSource: row.recordSource ?? '__unknown__',
    ...(Object.prototype.hasOwnProperty.call(row, 'userId') ? { recordUserId: row.userId ?? '__unknown__' } : {}),
  };
}
