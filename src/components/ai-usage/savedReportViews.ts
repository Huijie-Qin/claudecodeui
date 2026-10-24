import type { ReportTenantId } from './types';
import type { UsageFilters } from './filterState';
import type { ReportViewEntry, ReportViewStore } from './reportViewState';
import { defaultUsageRange, validateUsageRange } from './usageUtils';

const keys = /^(?:usage|integration-details|session-details|skills|hooks|templates|code|demo-code|filters:(?:shared|usage|skills|hooks|templates|code)|hook:[^\s]{1,200}|template:[^\s]{1,200})$/;
const groups = ['user', 'workspace', 'day', 'week', 'month', 'skill', 'publisher', 'hook', 'template'];
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function savedFilters(value: unknown, through: string): UsageFilters {
  const fallback = { ...defaultUsageRange(through), userName: '', workspaceName: '' };
  if (!value || typeof value !== 'object') return fallback;
  const filters = value as Record<string, unknown>;
  const from = typeof filters.from === 'string' ? filters.from : '';
  const to = typeof filters.to === 'string' ? filters.to : '';
  return { ...(validateUsageRange(from, to, through) ? fallback : { from, to }),
    userName: typeof filters.userName === 'string' ? filters.userName.slice(0, 150) : '',
    workspaceName: typeof filters.workspaceName === 'string' ? filters.workspaceName.slice(0, 150) : '' };
}

const legacyFilterKeys = ['usage', 'skills', 'hooks', 'templates', 'code'].map(tab => `filters:${tab}`);

export function saveSharedReportFilters(views: ReportViewStore, next: UsageFilters): void {
  // Retire old tab snapshots so neither reload nor export can revive them.
  for (const key of legacyFilterKeys) views.delete(key);
  views.set('filters:shared', { queryKey: '', value: { filters: { ...next } } });
}

export function sharedReportFilters(views: ReportViewStore, through: string): UsageFilters {
  // Older releases have no last-applied timestamp. Prefer the landing tab,
  // then the first available tab in a deterministic order for one-time migration.
  const key = views.has('filters:shared') ? 'filters:shared' : legacyFilterKeys.find(key => views.has(key));
  const next = savedFilters(key ? views.get(key)?.value.filters : undefined, through);
  if (key !== 'filters:shared' || JSON.stringify(views.get(key)?.value.filters) !== JSON.stringify(next)
    || legacyFilterKeys.some(key => views.has(key))) saveSharedReportFilters(views, next);
  return next;
}

// Persist only applied preferences. No result rows, auth tokens or stale batches.
function preferences(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { page: 1 };
  for (const key of ['search', 'nameSearch', 'fieldKey', 'hookId', 'hookName']) {
    if (typeof value[key] === 'string') out[key] = value[key].slice(0, 200);
  }
  if (typeof value.filterScope === 'string') out.filterScope = value.filterScope.slice(0, 1000);
  if (groups.includes(String(value.groupBy))) out.groupBy = value.groupBy;
  if (['sum', 'average', 'min', 'max'].includes(String(value.metric))) out.metric = value.metric;
  if ([10, 20, 50, 100].includes(Number(value.pageSize))) out.pageSize = value.pageSize;
  for (const key of ['sort', 'statsSort', 'recordSort']) {
    const sort = value[key] as Record<string, unknown> | undefined;
    if (sort && typeof sort.sortBy === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,60}$/.test(sort.sortBy)
      && ['asc', 'desc'].includes(String(sort.sortDir))) out[key] = { sortBy: sort.sortBy, sortDir: sort.sortDir };
  }
  if (value.filters && typeof value.filters === 'object') {
    const filters = value.filters as Record<string, unknown>;
    out.filters = Object.fromEntries(['from', 'to', 'userName', 'workspaceName'].map(key => [key, typeof filters[key] === 'string' ? filters[key].slice(0, 150) : '']));
  }
  // Draft controls are restored from their applied counterparts, not unfinished input.
  if ('search' in out) out.draft = out.search;
  if ('nameSearch' in out) out.nameDraft = out.nameSearch;
  return out;
}

export class SavedReportViews extends Map<string, ReportViewEntry> {
  private storageKey = '';
  constructor(private storage?: StorageLike) { super(); }
  bind(tenantId: ReportTenantId, userId?: number) {
    const key = userId ? `ai-report-views:v1:${userId}:${tenantId}` : '';
    if (key === this.storageKey) return;
    super.clear(); this.storageKey = key;
    if (!key) return;
    try {
      const raw = this.storage?.getItem(key);
      if (!raw || raw.length > 200_000) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const [name, value] of parsed.slice(0, 100)) {
        if (typeof name === 'string' && keys.test(name) && value && typeof value === 'object') {
          super.set(name, { queryKey: '', value: preferences(value) });
        }
      }
    } catch { super.clear(); }
  }
  override set(key: string, entry: ReportViewEntry) {
    super.set(key, entry);
    this.save();
    return this;
  }
  override clear() {
    super.clear();
    try { if (this.storageKey) this.storage?.removeItem(this.storageKey); } catch { /* Restricted storage is optional. */ }
  }
  private save() {
    if (!this.storageKey) return;
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify([...this].filter(([key]) => keys.test(key)).slice(-100).map(([key, entry]) => [key, preferences(entry.value)])));
    } catch { /* In-memory preferences still work when browser storage is unavailable. */ }
  }
}

export function browserReportViews() {
  try { return new SavedReportViews(window.localStorage); } catch { return new SavedReportViews(); }
}
