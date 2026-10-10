import test from 'node:test';
import assert from 'node:assert/strict';

import { assertPublishedBatch, buildUsageUrl, coverageStatus, dateInZone, defaultUsageRange, formatExecutionDuration, formatReportTimestamp, formatUsageDuration, hookRecordDetailFilters, formatHookNumber, hookNumberMetrics, reportFields, reportUserName, reportWorkspaceName, validateUsageRange } from './usageUtils';

test('user and workspace cells show names, never numeric IDs or invalid labels', () => {
  assert.equal(reportUserName({ user_name: ' Alice ', userName: 'old', userId: 3 }), 'Alice');
  assert.equal(reportUserName({ userName: 'Bob', userId: 4 }), 'Bob');
  assert.equal(reportUserName({ username: 'Carol' }), 'Carol');
  assert.equal(reportUserName({ displayName: 'Dave' }), 'Dave');
  assert.equal(reportWorkspaceName({ workspaceName: '研发工作区', workspaceId: 7 }), '研发工作区');
  assert.equal(reportWorkspaceName({ workspace_name: '项目工作区' }), '项目工作区');
  assert.equal(reportUserName({ userId: 3, user_name: 3, userName: ' ' }), '—');
  assert.equal(reportWorkspaceName({ workspaceId: 7, workspaceName: null }), '—');
});

test('unknown duration and coverage are never formatted as zero', () => {
  assert.equal(formatUsageDuration(null), '—');
  assert.equal(formatUsageDuration(0), '0s');
  assert.equal(formatUsageDuration(300000), '5m 0s');
  assert.equal(coverageStatus(undefined), 'unavailable');
  assert.equal(coverageStatus({ status: 'partial', pendingTurns: 2 }), 'partial');
});
test('Hook execution durations retain sub-second precision and unknown states', () => {
  assert.equal(formatExecutionDuration(null), '—');
  assert.equal(formatExecutionDuration(0), '0 ms');
  assert.equal(formatExecutionDuration(545.678), '545.68 ms');
  assert.equal(formatExecutionDuration(1250), '1.25 s');
  assert.equal(formatExecutionDuration(65000), '1m 5s');
});
test('report URL pins explicit tenant and published batch, without relying on global tenant state', () => {
  const result = new URL(buildUsageUrl('hooks/4/records', { tenantId: 17, batchId: 'batch/x', scope: 'self', from: '2026-09-11', search: '' }), 'https://example.test');
  assert.equal(result.searchParams.get('tenantId'), '17');
  assert.equal(result.searchParams.get('batchId'), 'batch/x');
  assert.equal(result.searchParams.get('scope'), 'self');
  assert.equal(result.searchParams.has('search'), false);
});
test('business date and defaults are independent of browser local timezone', () => {
  assert.equal(dateInZone('2026-09-11T16:30:00Z', 'Asia/Shanghai'), '2026-09-12');
  assert.deepEqual(defaultUsageRange('2026-09-11'), { from: '2026-08-13', to: '2026-09-11' });
});

test('record timestamps use the reporting timezone and do not expose raw UTC as local dates', () => {
  const reportTime = formatReportTimestamp('2026-09-11T16:03:00.000Z', 'Asia/Shanghai', 'en-GB');
  assert.match(reportTime, /12\/09\/2026/);
  assert.match(reportTime, /00:03:00/);
  assert.match(formatReportTimestamp('2026-09-11T16:03:00.000Z', 'UTC', 'en-GB'), /16:03:00/);
  assert.equal(formatReportTimestamp('invalid'), '—');
});
test('today and future ungenerated data cannot be silently queried as zero', () => {
  assert.equal(validateUsageRange('2026-09-11', '2026-09-12', '2026-09-11'), 'unpublished');
  assert.equal(validateUsageRange('2026-09-12', '2026-09-11', '2026-09-11'), 'order');
  assert.equal(validateUsageRange('2026-09-01', '2026-09-11', '2026-09-11'), null);
});
test('responses from another batch are rejected', () => {
  assert.throws(() => assertPublishedBatch({ batchId: 'old' }, 'new'), /batchMismatch/);
  assert.equal(assertPublishedBatch({ batchId: 'current' }, 'current').batchId, 'current');
});

test('record details only render typed report fields, never arbitrary JSON or nested content', () => {
  assert.deepEqual(reportFields({ secret: 'raw hook payload' }), []);
  assert.deepEqual(reportFields([{ key: 'count', label: 'Records', value: 2 }, { key: 'nested', value: { secret: true } }]), [
    { key: 'count', label: 'Records', value: 2 }, { key: 'nested', label: 'nested', value: null },
  ]);
});

test('Hook number fields expose all four statistics as numbers only and preserve zero and missing values', () => {
  assert.deepEqual(hookNumberMetrics.map(({ key }) => key), ['sum', 'average', 'min', 'max']);
  assert.equal(formatHookNumber(99), '99');
  assert.equal(formatHookNumber(0), '0');
  assert.equal(formatHookNumber(-2.5), '-2.5');
  assert.equal(formatHookNumber(17800), (17800).toLocaleString());
  for (const value of [null, undefined, NaN, Infinity, '99', true]) assert.equal(formatHookNumber(value), '—');
});

test('Hook field drilldown pins the grouped user without changing ungrouped record scope', () => {
  const row = { postActionId: 'archive', recordType: 'conversation_record', hookVersion: 2, recordSource: 'post_action' };
  assert.deepEqual(hookRecordDetailFilters(row), row);
  assert.deepEqual(hookRecordDetailFilters({ ...row, userId: 3 }), { ...row, recordUserId: 3 });
  const url = new URL(buildUsageUrl('hooks/a/records', hookRecordDetailFilters({ ...row, userId: 3 })), 'https://example.test');
  assert.equal(url.searchParams.get('recordUserId'), '3');
});

test('unknown user and Hook dimensions stay explicit when drilling into field statistics', () => {
  assert.deepEqual(hookRecordDetailFilters({ userId: null }), {
    postActionId: '__unknown__', recordType: '__unknown__', hookVersion: '__unknown__', recordSource: '__unknown__', recordUserId: '__unknown__',
  });
});

test('unified Hook drilldown retains page filters while including all of the Hook versions and actions', () => {
  const filters = { tenantId: 10, batchId: 'published', userId: 3, from: '2026-09-01', to: '2026-09-12', recordSource: 'post_action' };
  const url = new URL(buildUsageUrl('hooks/a/records', { ...filters, ...hookRecordDetailFilters({ hookId: 'a', allHookRecords: true }) }), 'https://example.test');
  assert.equal(url.searchParams.get('userId'), '3');
  assert.equal(url.searchParams.get('recordSource'), 'post_action');
  assert.equal(url.searchParams.get('from'), '2026-09-01');
  assert.equal(url.searchParams.has('hookVersion'), false);
  assert.equal(url.searchParams.has('postActionId'), false);
});
