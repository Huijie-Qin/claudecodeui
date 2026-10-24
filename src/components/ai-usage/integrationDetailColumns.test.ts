import assert from 'node:assert/strict';
import test from 'node:test';

import type { TFunction } from 'i18next';

import { formatIntegrationDuration, integrationDetailColumns } from './integrationDetailColumns';
import { displayReportValue } from './usageUtils';
import { workbookSpecs } from './reportWorkbook';
import { SavedReportViews } from './savedReportViews';

const t = ((key: string) => key) as TFunction;

test('detail duration preserves hours/minutes/seconds while missing and known zero remain distinct', () => {
  assert.equal(formatIntegrationDuration(3723000), '01:02:03');
  assert.equal(formatIntegrationDuration(90061000), '25:01:01');
  assert.equal(formatIntegrationDuration(0), '00:00:00');
  assert.equal(formatIntegrationDuration(null), '—');
  assert.equal(formatIntegrationDuration(-1), '—');
  assert.equal(formatIntegrationDuration(Number.NaN), '—');
  assert.equal(displayReportValue(null), '—');
  assert.equal(displayReportValue(0), '0');
  const columns = integrationDetailColumns(t);
  assert.equal(columns.length, 24);
  assert.equal(new Set(columns.map(column => column.key)).size, 24);
  assert.equal(columns.find(column => column.key === 'refreshedAt')?.title, 'integration.refreshedAt');
  assert.equal(columns.find(column => column.key === 'aiActiveDurationMs')?.render?.({ aiActiveDurationMs: 3723000 }), '01:02:03');
});

test('first workbook tab exports the same raw detail filters/order, independent of obsolete grouped-view preferences', () => {
  const views = new SavedReportViews();
  views.set('usage', { queryKey: 'old', value: { groupBy: 'month', sort: { sortBy: 'sessionCount', sortDir: 'asc' } } });
  views.set('integration-details', { queryKey: 'new', value: { sort: { sortBy: 'refreshedAt', sortDir: 'asc' }, page: 3, pageSize: 20 } });
  views.set('filters:shared', { queryKey: '', value: { filters: { from: '2026-09-01', to: '2026-09-12', userName: 'alice', workspaceName: 'work' } } });
  const [spec] = workbookSpecs({ tenantId: 10, batchId: 'published', through: '2026-09-12', views, codeAvailable: true, t });
  assert.equal(spec.endpoint, 'integration-details');
  assert.equal(spec.params.userSearch, 'alice');
  assert.equal(spec.params.workspaceSearch, 'work');
  assert.equal(spec.params.sortBy, 'refreshedAt');
  assert.equal(spec.params.sortDir, 'asc');
  assert.equal(spec.params.groupBy, undefined); assert.equal(spec.params.page, undefined);
  assert.equal(spec.columns.find(column => column.key === 'aiActiveDurationMs')?.exportValue?.({ aiActiveDurationMs: 1250 }), 1.25);
  assert.equal(spec.metrics, undefined);
});
