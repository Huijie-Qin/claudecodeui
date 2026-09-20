import assert from 'node:assert/strict';
import test from 'node:test';

import { analysisGroups, analysisMetrics, defaultReportSort, hasAnalysisRecords, nextReportSort, reportTabOrder } from './analysisState';

test('unified tables start with their relevant entity dimension', () => {
  assert.equal(analysisGroups.usage[0], 'user');
  assert.equal(analysisGroups.hooks[0], 'hook');
  assert.equal(analysisGroups.hookExecutions[0], 'hook');
  assert.equal(analysisGroups.templates[0], 'template');
});

test('template tables retain only active users and conversations while Hook drilldowns remain', () => {
  for (const group of analysisGroups.templates) assert.equal(hasAnalysisRecords('templates', group), false);
  assert.equal(hasAnalysisRecords('hooks', 'hook'), true);
  assert.equal(hasAnalysisRecords('hookExecutions', 'hook'), true);
  for (const tab of reportTabOrder) assert.equal(hasAnalysisRecords(tab, 'user'), false);
  assert.deepEqual(analysisMetrics.templates, ['activeUserCount', 'sessionCount']);
  assert.deepEqual(defaultReportSort('templates'), { sortBy: 'activeUserCount', sortDir: 'desc' });
});

test('Skill call statistics is a peer tab with its own supported sorting, not a template or usage analysis', () => {
  assert.deepEqual(reportTabOrder, ['usage', 'skills', 'hookExecutions', 'hooks', 'templates']);
  assert.deepEqual(defaultReportSort('skills'), { sortBy: 'invocationCount', sortDir: 'desc' });
  assert.equal('skills' in analysisGroups, false);
  assert.equal('skills' in analysisMetrics, false);
});

test('table sort toggles direction and a new column starts descending', () => {
  const first = defaultReportSort('usage');
  assert.deepEqual(nextReportSort(first, 'activeDurationMs'), { sortBy: 'activeDurationMs', sortDir: 'asc' });
  assert.deepEqual(nextReportSort(first, 'sessionCount'), { sortBy: 'sessionCount', sortDir: 'desc' });
});
test('DAU and MAU cannot accidentally become summed weekly/monthly metrics', () => {
  assert.ok(analysisGroups.usage.includes('week'));
  assert.ok(analysisGroups.usage.includes('month'));
  assert.ok(!Object.values(analysisMetrics).flat().some((metric) => ['dau', 'mau'].includes(metric)));
  assert.ok(analysisMetrics.usage.includes('activeUserCount'));
});
