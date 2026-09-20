import { usageFilterParams, type UsageFilters } from './filterState';
import { hookRecordDetailFilters, reportUserName } from './usageUtils';

export type HookDetailFilters = UsageFilters & { recordUserId?: unknown };

export function initialHookDetailFilters(params: Record<string, unknown>, row: Record<string, unknown>): HookDetailFilters {
  const identity = hookRecordDetailFilters(row);
  return {
    from: String(params.from || ''), to: String(params.to || ''),
    userName: identity.recordUserId !== undefined ? reportUserName(row) : String(params.userSearch || ''),
    workspaceName: String(params.workspaceSearch || ''),
    // Keep exact identity for same-name and unknown users on initial drilldown.
    recordUserId: identity.recordUserId,
  };
}

export function hookDetailScope(params: Record<string, unknown>, row: Record<string, unknown>, filters: HookDetailFilters) {
  return {
    tenantId: params.tenantId, scope: params.scope, batchId: params.batchId,
    ...hookRecordDetailFilters(row), ...usageFilterParams(filters),
    recordUserId: filters.recordUserId,
    // An initial exact-user drilldown must not also match a fallback display label.
    userSearch: filters.recordUserId !== undefined ? '' : filters.userName.trim(),
  };
}
