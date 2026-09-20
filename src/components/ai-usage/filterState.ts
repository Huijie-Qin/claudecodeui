import type { ReportTab } from './types';

export type UsageFilters = {
  from: string; to: string;
  userName: string; workspaceName: string;
};

// All tabs and drilldowns share name filters; IDs stay internal to authorization.
export function usageFilterParams(filters: UsageFilters) {
  return {
    from: filters.from, to: filters.to,
    userSearch: filters.userName.trim(), workspaceSearch: filters.workspaceName.trim(),
  };
}

export function tableNameFilter(tab: ReportTab | 'hookFields') {
  if (tab === 'usage') return null;
  return { key: 'search' as const, label: tab === 'skills' ? 'skillNameFilter' : tab === 'templates' ? 'templateNameFilter' : 'hookNameFilter' };
}
