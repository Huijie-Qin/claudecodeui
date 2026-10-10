import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreReportView, type ReportViewStore } from './reportViewState';
import { analysisGroups, analysisMetrics } from './analysisState';

test('AI usage keeps its three metrics while templates show only active users and conversations', () => {
  assert.deepEqual(analysisMetrics.usage, ['sessionCount','activeDurationMs','activeUserCount']);
  assert.deepEqual(analysisGroups.templates, ['template']);
  assert.deepEqual(analysisMetrics.templates, ['activeUserCount','sessionCount']);
});

test('tabs retain independent groups, names, sorts, pages and sizes', () => {
  const store: ReportViewStore = new Map();
  const defaults = { groupBy: 'user', page: 1, pageSize: 20, search: '', sort: 'desc' };
  store.set('usage', { queryKey: 'batch-filter-a', value: { ...defaults, groupBy: 'workspace', page: 3, pageSize: 10, sort: 'asc' } });
  store.set('hooks', { queryKey: 'batch-filter-a', value: { ...defaults, search: 'SQL', page: 2 } });
  assert.deepEqual(restoreReportView(store, 'usage', 'batch-filter-a', defaults), { ...defaults, groupBy: 'workspace', page: 3, pageSize: 10, sort: 'asc' });
  assert.equal(restoreReportView(store, 'hooks', 'batch-filter-a', defaults).search, 'SQL');
  assert.deepEqual(restoreReportView(store, 'skills', 'batch-filter-a', defaults), defaults);
});

test('new filters or batch reset only pagination; clearing access discards all preferences', () => {
  const store: ReportViewStore = new Map();
  const defaults = { page: 1, groupBy: 'user', search: '' };
  store.set('usage', { queryKey: 'old', value: { page: 3, groupBy: 'month', search: 'SQL' } });
  assert.deepEqual(restoreReportView(store, 'usage', 'new', defaults), { page: 1, groupBy: 'month', search: 'SQL' });
  store.clear();
  assert.deepEqual(restoreReportView(store, 'usage', 'old', defaults), defaults);
});
