import type { ReportSort } from './ReportTable';
import type { AnalysisTab, ReportTab } from './types';

export const reportTabOrder = ['usage', 'skills', 'hookExecutions', 'hooks', 'templates'] as const satisfies readonly ReportTab[];

export const analysisGroups = {
  usage: ['user', 'workspace', 'day', 'week', 'month'],
  hooks: ['hook', 'user', 'workspace', 'day', 'week', 'month'],
  hookExecutions: ['hook', 'user', 'workspace', 'day', 'week', 'month'],
  templates: ['template'],
} as const;
export const analysisMetrics = {
  usage: ['sessionCount', 'activeDurationMs', 'activeUserCount'],
  hooks: ['recordCount', 'activeUserCount', 'workspaceCount'],
  hookExecutions: ['executionCount', 'successCount', 'failureCount', 'runningCount', 'averageDurationMs'],
  templates: ['activeUserCount', 'sessionCount'],
} as const;
export function hasAnalysisRecords(tab: ReportTab, groupBy: string): boolean {
  return groupBy === 'hook' && (tab === 'hooks' || tab === 'hookExecutions');
}
export function nextReportSort(current: ReportSort, sortBy: string): ReportSort {
  return { sortBy, sortDir: current.sortBy === sortBy && current.sortDir === 'desc' ? 'asc' : 'desc' };
}
export const defaultReportSort = (tab: ReportTab): ReportSort => ({
  sortBy: tab === 'usage' ? 'activeDurationMs' : tab === 'skills' ? 'invocationCount' : tab === 'hooks' ? 'recordCount' : tab === 'hookExecutions' ? 'executionCount' : 'activeUserCount', sortDir: 'desc',
});

// Per-person distinct counts are 0/1 indicators, not useful comparison columns.
// Keep these metrics in the deduplicated summary and in multi-person groups.
export function visibleAnalysisMetrics(tab: AnalysisTab, groupBy: string): string[] {
  return analysisMetrics[tab].filter(metric => groupBy !== 'user' || !['activeUserCount', 'applicationUserCount'].includes(metric));
}
export function visibleAnalysisSort(tab: AnalysisTab, groupBy: string, sort: ReportSort): ReportSort {
  const metrics = visibleAnalysisMetrics(tab, groupBy);
  if (sort.sortBy === 'groupLabel' || metrics.includes(sort.sortBy)) return sort;
  const fallback = defaultReportSort(tab);
  return { ...fallback, sortBy: metrics.includes(fallback.sortBy) ? fallback.sortBy : metrics[0] };
}
