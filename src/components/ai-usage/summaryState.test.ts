import assert from 'node:assert/strict';
import test from 'node:test';

import { assertUsageSummary, summaryPeriods, summaryRequestParams, type UsageSummary } from './summaryState';

const snapshot: UsageSummary = { batchId: 'batch-1', summaryVersion: 1, scope: 'tenant', from: '2026-08-14', to: '2026-09-12',
  activityDate: '2026-09-12', mauFrom: '2026-08-14', sessionCount: 601, publishedSkillCount: 30, dau: 4, mau: 41 };

test('summary period labels are anchored to the published snapshot, not today', () => {
  assert.deepEqual(summaryPeriods(snapshot), {
    cutoff: '2026/09/12', sessionCount: '08/14–09/12', publishedSkillCount: '09/12', dau: '09/12', mau: '08/14–09/12',
  });
  assert.equal(summaryPeriods({ ...snapshot, from: '2026-09-01' }).mau, '08/14–09/12');
  assert.equal(summaryPeriods({ ...snapshot, activityDate: '2026-09-11' }).dau, '09/11');
});

test('summary labels preserve years across year boundaries and unknown dates stay unknown', () => {
  assert.equal(summaryPeriods({ ...snapshot, from: '2025-12-20', to: '2026-01-18', mauFrom: '2025-12-20' }).sessionCount, '2025/12/20–2026/01/18');
  assert.equal(summaryPeriods({ ...snapshot, from: '2025-12-20', to: '2026-01-18', mauFrom: '2025-12-20' }).mau, '2025/12/20–2026/01/18');
  assert.deepEqual(summaryPeriods(null), { cutoff: '—', sessionCount: '—', publishedSkillCount: '—', dau: '—', mau: '—' });
  assert.equal(summaryPeriods({ ...snapshot, to: '' }).sessionCount, '—');
});

test('summary requests pin authorization and batch, never inherit interactive filters or selected scope', () => {
  const capabilities = { canViewTenant: true, canExport: true, exportConfigured: false };
  const noisyState = { ...capabilities, from: '2026-09-01', to: '2026-09-02', userId: 9, workspaceId: 7,
    search: 'someone', scope: 'self', page: 2, groupBy: 'week', minValue: 100, metric: 'sessionCount' };
  assert.deepEqual(summaryRequestParams(10, 'batch-1', noisyState), { tenantId: 10, batchId: 'batch-1', scope: 'tenant' });
  assert.deepEqual(summaryRequestParams(10, 'batch-1', { ...noisyState, canViewTenant: false }), { tenantId: 10, batchId: 'batch-1', scope: 'self' });
  assert.notDeepEqual(summaryRequestParams(20, 'batch-2', capabilities), summaryRequestParams(10, 'batch-1', capabilities));
});

test('summary rejects an old filtered overview, mismatched batch and unauthorized scope instead of displaying its totals', () => {
  const result: UsageSummary = { batchId: 'batch-1', summaryVersion: 1, scope: 'tenant', from: '2026-08-14', to: '2026-09-12',
    activityDate: '2026-09-12', mauFrom: '2026-08-14', sessionCount: 601, publishedSkillCount: 30, dau: 4, mau: 41 };
  assert.equal(assertUsageSummary(result, 'batch-1', 'tenant'), result);
  assert.throws(() => assertUsageSummary(result, 'batch-2', 'tenant'), /batchMismatch/);
  assert.throws(() => assertUsageSummary(result, 'batch-1', 'self'), /summaryUnavailable/);
  assert.throws(() => assertUsageSummary({ ...result, summaryVersion: 0 }, 'batch-1', 'tenant'), /summaryUnavailable/);
});
