import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

test('access is tenant scoped, live, and never trusts cached platform roles', (t) => {
  const { db, accessService } = fixture(t);
  assert.equal(accessService.resolve({ tenantId: 10, userId: 2 }).scope, 'tenant');
  assert.equal(accessService.resolve({ tenantId: 10, userId: 3 }).scope, 'self');
  assert.throws(() => accessService.resolve({ tenantId: 10, userId: 3, scope: 'tenant' }), { statusCode: 403 });
  assert.throws(() => accessService.resolve({ tenantId: 20, userId: 2 }), { statusCode: 403 });
  assert.equal(accessService.resolve({ tenantId: 20, userId: 1 }).canViewTenant, true);
  db.exec("UPDATE tenant_users SET role='member' WHERE user_id=2");
  assert.throws(() => accessService.resolve({ tenantId: 10, userId: 2, scope: 'tenant' }), { statusCode: 403 });
  db.exec("UPDATE tenant_users SET status='disabled' WHERE user_id=3");
  assert.throws(() => accessService.resolve({ tenantId: 10, userId: 3 }), { statusCode: 403 });
  db.exec("UPDATE tenants SET status='disabled' WHERE id=20");
  assert.throws(() => accessService.resolve({ tenantId: 20, userId: 1 }), { statusCode: 403 });
});

test('report sums completed turn slices and deduplicates sessions across days, without raw source tables', (t) => {
  const { queryService: query, accessService, access, batch, row } = fixture(t);
  batch();
  row({ id: 'i1', dataset: 'interactions' });
  row({ id: 'i2', dataset: 'interactions', date: '2026-09-12' });
  row({ id: 't1', dataset: 'turns', value: { durationMs: 120000, status: 'completed' } });
  row({ id: 't2', dataset: 'turns', date: '2026-09-12', value: { durationMs: 180000, status: 'completed' } });
  row({ id: 't3', dataset: 'turns', value: { durationMs: 990000, status: 'pending' } });
  row({ id: 'i-other', dataset: 'interactions', userId: 4, sessionKey: 'session-other' });
  const filter = { from: '2026-09-11', to: '2026-09-12' };
  assert.equal(query.overview(access, filter).sessionCount, 2);
  assert.equal(query.overview(access, filter).activeDurationMs, 300000);
  const self = accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(query.overview(self, filter).sessionCount, 1);
  assert.deepEqual(query.trend(self, filter).items.map(({ activeDurationMs }) => activeDurationMs), [120000, 180000]);
  assert.throws(() => query.users(self, filter), { statusCode: 403 });
  assert.equal(query.status(access).dataThroughDate, '2026-09-12');
  assert.throws(() => query.overview(access, { to: '2026-09-13' }), { code: 'dataNotGenerated' });
  assert.throws(() => query.overview(access, { from: '2026-02-30' }), { code: 'invalidFilter' });
});

test('batch selection cannot reveal unpublished or other-tenant partitions; no batch/unavailable is not zero', (t) => {
  const { queryService: query, access, batch, row } = fixture(t);
  assert.equal(query.overview(access).sessionCount, null);
  batch('batch-1', 10, 'published', { duration: 'unavailable', skillInvocations: 'unavailable' });
  row({ id: 'i1', dataset: 'interactions' });
  batch('batch-running', 10, 'running');
  row({ id: 'hidden', dataset: 'interactions', batchId: 'batch-running', sessionKey: 'hidden' });
  batch('batch-foreign', 20);
  assert.equal(query.overview(access).sessionCount, 1);
  assert.equal(query.overview(access).activeDurationMs, null);
  assert.equal(query.overview(access).skillInvocationCount, null);
  assert.throws(() => query.overview(access, { batchId: 'batch-running' }), { statusCode: 404 });
  assert.throws(() => query.overview(access, { batchId: 'batch-foreign' }), { statusCode: 404 });
});

test('Skill contribution is attributed to publisher, never to unknown publisher or caller', (t) => {
  const { queryService: query, accessService, access, batch, row } = fixture(t);
  batch();
  row({ id: 'pub', dataset: 'skill_publications', subjectId: 'skill-a', value: { publisherUserId: 3 } });
  row({ id: 'call', dataset: 'skill_invocations', userId: 4, subjectId: 'skill-a', value: { callerUserId: 4, publisherUserId: 3 } });
  row({ id: 'unknown', dataset: 'skill_invocations', userId: 4, subjectId: 'skill-b', value: { callerUserId: 4, publisherUserId: null } });
  assert.equal(query.overview(access).skillInvocationCount, 1);
  assert.equal(query.overview(accessService.resolve({ tenantId: 10, userId: 3 })).skillInvocationCount, 1);
  assert.equal(query.overview(accessService.resolve({ tenantId: 10, userId: 4 })).skillInvocationCount, 0);
  assert.equal(query.users(access).items.find((item) => item.userId === 3).publishedSkillCount, 1);
});

test('Hook versions/actions remain separate; only safe numeric fields aggregate; templates use frozen origin', (t) => {
  const { queryService: query, access, batch, row } = fixture(t);
  batch();
  for (const [id, postActionId, value] of [['h1', 'a', 5], ['h2', 'b', 7]]) row({ id, dataset: 'hook_records', subjectId: 'hook-1', value: { hookId: 'hook-1', hookName: '记录', postActionId, recordType: 'sql', hookVersion: 1, recordSource: 'post_action', fields: [{ key: 'n', label: '数量', type: 'number', aggregation: 'sum', value }] } });
  assert.equal(query.hooks(access).items.length, 2);
  assert.equal(query.hookRecords(access, 'hook-1', { postActionId: 'a' }).total, 1);
  assert.deepEqual(query.hookStatistics(access, 'hook-1', { postActionId: 'b' }).items.map(({ sum }) => sum), [7]);
  row({ id: 'app', dataset: 'template_applications', subjectId: 'template-1', value: { templateId: 'template-1', templateName: '模板', workspaceName: '应用工作区' } });
  row({ id: 'use', dataset: 'interactions', value: { templateId: 'template-1', templateName: '模板' } });
  assert.equal(query.templates(access).items[0].applicationCount, 1);
  assert.equal(query.templates(access).items[0].sessionCount, 1);
  assert.equal(query.templateApplications(access, 'template-1').items[0].workspaceName, '应用工作区');
});

test('immediate deletion tombstones suppress published Hook summaries, fields and details', (t) => {
  const { db, queryService: query, access, batch, row } = fixture(t);
  batch();
  row({ id: 'secret-record', dataset: 'hook_records', subjectId: 'hook-1', value: { hookId: 'hook-1', fields: [{ key: 'n', type: 'number', value: 3 }] } });
  assert.equal(query.hookRecords(access, 'hook-1').total, 1);
  db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'hook_records', 'secret-record');
  assert.equal(query.hooks(access).total, 0);
  assert.equal(query.hookRecords(access, 'hook-1').total, 0);
  assert.equal(query.hookStatistics(access, 'hook-1').items.length, 0);
});

test('filters are effective, unknown Hook groups are exact and zero-use members stay visible', (t) => {
  const { queryService: query, accessService, access, batch, row } = fixture(t);
  batch();
  row({ id: 'claude', dataset: 'interactions', value: { provider: 'claude' } });
  row({ id: 'codex', dataset: 'interactions', userId: 4, workspaceId: 8, sessionKey: 'codex-session', value: { provider: 'codex' } });
  assert.throws(() => query.overview(access, { provider: 'claude' }), { code: 'invalidFilter' });
  assert.equal(query.overview(access, { workspaceId: '8' }).sessionCount, 1);
  assert.equal(query.overview(access, { userId: '3' }).sessionCount, 1);
  assert.equal(query.users(access).items.find((item) => item.userId === 2).sessionCount, 0);
  assert.deepEqual(query.users(access, { search: 'tenant-admin' }).items.map((item) => item.userId), [2]);
  assert.throws(() => query.overview(access, { provider: 'unsupported' }), { code: 'invalidFilter' });
  assert.throws(() => query.overview(access, { workspaceId: '-1' }), { code: 'invalidFilter' });
  assert.throws(() => query.overview(accessService.resolve({ tenantId: 10, userId: 3 }), { userId: '4' }), { statusCode: 403 });
  row({ id: 'unknown-action', dataset: 'hook_records', subjectId: 'hook', value: { hookName: 'unknown hook', postActionId: null, fields: [], rawPayload: 'must not escape DTO' } });
  row({ id: 'known-action', dataset: 'hook_records', subjectId: 'hook', value: { hookName: 'known hook', postActionId: 'known', fields: [] } });
  assert.equal(query.hooks(access, { search: 'unknown' }).total, 1);
  const records = query.hookRecords(access, 'hook', { postActionId: '__unknown__' });
  assert.equal(records.total, 1);
  assert.equal(records.items[0].rawPayload, undefined);
});

test('Hook fields use nightly daily aggregates and fall back to redacted detail when revisions change', (t) => {
  const { db, queryService: query, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  const dimensions = { hookName: 'hook', postActionId: 'record', recordType: 'metrics', hookVersion: 2, recordSource: 'post_action' };
  row({ id: 'daily-1', dataset: 'hook_daily', subjectId: 'hook', value: { ...dimensions, recordCount: 2, fields: [{ key: 'n', type: 'number', aggregation: 'avg', validCount: 2, sum: 12, min: 5, max: 7 }] } });
  row({ id: 'r1', dataset: 'hook_records', subjectId: 'hook', value: { ...dimensions, fields: [{ key: 'n', type: 'number', aggregation: 'avg', value: 5 }] } });
  row({ id: 'r2', dataset: 'hook_records', subjectId: 'hook', value: { ...dimensions, fields: [{ key: 'n', type: 'number', aggregation: 'avg', value: 7 }] } });
  const daily = query.hookStatistics(access, 'hook');
  assert.equal(daily.aggregationSource, 'daily');
  assert.equal(daily.items[0].sum, 12);
  assert.equal(daily.items[0].average, 6);
  db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'hook_records', 'r1');
  db.exec('UPDATE ai_usage_tenant_state SET data_revision = 1 WHERE tenant_id = 10');
  const fallback = query.hookStatistics(access, 'hook');
  assert.equal(fallback.aggregationSource, 'records');
  assert.equal(fallback.items[0].sum, 7);
  assert.equal(fallback.items[0].validCount, 1);
});

test('compressed template sessions preserve interaction boundaries and sum preaggregated duration only once', (t) => {
  const { db, queryService: query, access, batch, row } = fixture(t);
  batch();
  row({ id: 'day-1', dataset: 'interactions', value: { templateId: 'template', firstInteractionAt: '2026-09-11T10:00:00.000Z', lastInteractionAt: '2026-09-11T10:30:00.000Z' } });
  row({ id: 'day-2', dataset: 'interactions', date: '2026-09-12', value: { templateId: 'template', firstInteractionAt: '2026-09-12T08:00:00.000Z', lastInteractionAt: '2026-09-12T09:30:00.000Z' } });
  row({ id: 'turns-aggregate', dataset: 'turns', value: { templateId: 'template', status: 'completed', durationMs: 300000, turnCount: 2 } });
  db.exec("UPDATE ai_usage_report_rows SET occurred_at='2026-09-10T23:00:00.000Z' WHERE row_key='turns-aggregate'");
  row({ id: 'pending', dataset: 'turns', date: '2026-09-12', value: { templateId: 'template', status: 'pending', durationMs: null } });
  db.exec("UPDATE ai_usage_report_rows SET occurred_at='2026-09-12T23:00:00.000Z' WHERE row_key='pending'");
  const sessions = query.templateSessions(access, 'template', { from: '2026-09-11', to: '2026-09-12' });
  assert.equal(sessions.total, 1);
  assert.equal(sessions.items[0].firstInteractionAt, '2026-09-11T10:00:00.000Z');
  assert.equal(sessions.items[0].lastInteractionAt, '2026-09-12T09:30:00.000Z');
  assert.equal(sessions.items[0].activeDurationMs, 300000);
  assert.equal(query.overview(access).sessionCount, 1);
  assert.equal(query.overview(access).activeDurationMs, 300000);
});

test('self coverage never exposes tenant-wide diagnostic counters', (t) => {
  const { queryService: query, accessService, access, batch } = fixture(t);
  batch('batch-1', 10, 'published', { sessions: 'partial', duration: 'unavailable', pendingTurns: 14, incompleteTurns: 27, failedTurns: 4, cancelledTurns: 3, unsupportedTurns: 6, dataRevision: 11, reasons: ['Historical coverage is incomplete'] });
  assert.equal(query.status(access).coverage.pendingTurns, 14);
  const self = query.status(accessService.resolve({ tenantId: 10, userId: 3 })).coverage;
  assert.equal(self.duration, 'unavailable');
  assert.equal(self.status, 'partial');
  assert.deepEqual(Object.keys(self).sort(), ['duration', 'generatedSql', 'integrationVersion', 'reasons', 'sessions', 'status', 'submittedCode']);
});

test('all exposed number fields produce four statistics regardless of their legacy aggregation setting', (t) => {
  const { db, queryService: query, accessService, access, batch, row } = fixture(t);
  batch('batch-1', 10, 'published', { dataRevision: 0, hookNumericStatisticsVersion: 1 });
  const definitions = [{ key: 'sum', aggregation: 'sum' }, { key: 'display', aggregation: 'none' }, { key: 'unknown' }];
  row({ id: 'daily', dataset: 'hook_daily', subjectId: 'hook', value: { fields: definitions.map((field) => ({ ...field, type: 'number', sum: 7, min: 7, max: 7, validCount: 1 })) } });
  row({ id: 'record', dataset: 'hook_records', subjectId: 'hook', value: { fields: definitions.map((field) => ({ ...field, type: 'number', value: 7 })) } });
  assert.deepEqual(query.hookStatistics(access, 'hook').items.map((field) => field.key), ['display', 'sum', 'unknown']);
  assert.ok(query.hookStatistics(access, 'hook').items.every((field) => field.sum === 7 && field.average === 7 && field.min === 7 && field.max === 7));
  const self = accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(query.hookStatistics(self, 'hook').aggregationSource, 'daily');
  assert.equal(query.hookStatistics(self, 'hook').coverage.dataRevision, undefined);
  db.exec('UPDATE ai_usage_tenant_state SET data_revision=1 WHERE tenant_id=10');
  assert.deepEqual(query.hookStatistics(access, 'hook').items.map((field) => field.key), ['display', 'sum', 'unknown']);
  assert.equal(query.hookRecords(access, 'hook').items[0].fields.length, 3);
});
