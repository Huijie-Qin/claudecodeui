import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

test('server sorting is global, stable across pages, and rejects untrusted SQL fragments', (t) => {
  const f = fixture(t); f.batch();
  f.row({ id: 'a', dataset: 'turns', userId: 3, value: { status: 'completed', durationMs: 20 } });
  f.row({ id: 'b', dataset: 'turns', userId: 4, value: { status: 'completed', durationMs: 90 } });
  const query = (extra = {}) => f.queryService.users(f.access, { pageSize: 1, sortBy: 'activeDurationMs', sortDir: 'desc', ...extra });
  assert.equal(query().items[0].userId, 4);
  assert.equal(query({ page: 2 }).items[0].userId, 3);
  assert.equal(query({ sortDir: 'asc' }).items[0].userId, 2);
  assert.throws(() => query({ sortBy: 'activeDurationMs; DROP TABLE users' }), { code: 'invalidFilter' });
  assert.throws(() => query({ sortDir: 'DESC NULLS FIRST' }), { code: 'invalidFilter' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 4);
});

test('group summaries deduplicate repeated users and sessions across days, independent of pagination', (t) => {
  const f = fixture(t); f.batch();
  f.row({ id: 'one', dataset: 'interactions', date: '2026-09-11', value: { provider: 'claude' } });
  f.row({ id: 'two', dataset: 'interactions', date: '2026-09-12', value: { provider: 'claude' } });
  const result = f.queryService.analysis(f.access, { dataset: 'usage', groupBy: 'day', pageSize: 1 });
  assert.equal(result.total, 2); assert.equal(result.items.length, 1);
  assert.equal(result.summary.sessionCount, 1); assert.equal(result.summary.activeUserCount, 1);
  assert.equal(f.queryService.analysis(f.access, { dataset: 'usage', groupBy: 'day', pageSize: 1, page: 2 }).summary.sessionCount, 1);
  const week = f.queryService.analysis(f.access, { dataset: 'usage', groupBy: 'week' });
  assert.equal(week.total, 1); assert.equal(week.items[0].groupLabel, '2026-09-07');
  assert.equal(week.items[0].activeUserCount, 1);
});

test('metric bounds apply after grouping and totals include only matching groups', (t) => {
  const f = fixture(t); f.batch();
  for (let index = 0; index < 4; index++) f.row({ id: `i-${index}`, dataset: 'interactions',
    userId: index ? 4 : 3, sessionKey: `session-${index}`, value: { provider: 'claude' } });
  const filters = { dataset: 'usage', groupBy: 'user', metric: 'sessionCount', minValue: '2', maxValue: '3' };
  const result = f.queryService.analysis(f.access, filters);
  assert.equal(result.total, 1); assert.equal(result.items[0].groupLabel, 'another-member');
  assert.equal(result.summary.sessionCount, 3);
  assert.equal(f.queryService.analysis(f.access, { ...filters, minValue: 9, maxValue: 10 }).summary.sessionCount, 0);
  for (const extra of [{ minValue: -1 }, { minValue: 'NaN' }, { minValue: 4, maxValue: 3 }, { metric: 'untrusted' }, { groupBy: 'tenant' }]) {
    assert.throws(() => f.queryService.analysis(f.access, { ...filters, ...extra }), { code: 'invalidFilter' });
  }
});

test('grouping respects user/workspace/provider/name filters and self-scope authorization', (t) => {
  const f = fixture(t); f.batch();
  f.row({ id: 'first', dataset: 'interactions', value: { provider: 'claude', workspaceName: 'first' } });
  f.row({ id: 'second', dataset: 'interactions', userId: 4, workspaceId: 8, sessionKey: 'other', value: { provider: 'codex', workspaceName: 'second' } });
  assert.equal(f.queryService.analysis(f.access, { groupBy: 'workspace' }).total, 2);
  assert.throws(() => f.queryService.analysis(f.access, { groupBy: 'workspace', provider: 'claude' }), { code: 'invalidFilter' });
  assert.equal(f.queryService.analysis(f.access, { workspaceId: 8 }).summary.sessionCount, 1);
  assert.equal(f.queryService.analysis(f.access, { search: 'another-member' }).summary.sessionCount, 1);
  assert.equal(f.queryService.overview(f.access, { userSearch: 'another-member' }).sessionCount, 1);
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  assert.equal(f.queryService.analysis(self, { groupBy: 'user' }).total, 1);
  assert.equal(f.queryService.analysis(self).items[0].groupLabel, 'member');
  assert.throws(() => f.queryService.analysis(self, { userId: 4 }), { statusCode: 403 });
  f.batch('other-batch', 20);
  assert.throws(() => f.queryService.analysis(f.access, { batchId: 'other-batch' }), { statusCode: 404 });
});

test('Hook grouping preserves identity, applies source filters and suppresses deleted records', (t) => {
  const f = fixture(t); f.batch();
  for (let index = 0; index < 3; index++) f.row({ id: `hook-${index}`, dataset: 'hook_records', subjectId: index ? 'b' : 'a',
    value: { hookName: 'Same name', recordSource: 'post_action', recordType: 'conversation', fields: [] } });
  const result = f.queryService.analysis(f.access, { dataset: 'hooks', groupBy: 'hook', sortBy: 'recordCount', sortDir: 'desc' });
  assert.equal(result.total, 2); assert.equal(result.items[0].recordCount, 2);
  assert.equal(result.summary.recordCount, 3); assert.equal(result.summary.activeUserCount, 1);
  assert.equal(f.queryService.analysis(f.access, { dataset: 'hooks', recordSource: 'unknown' }).total, 0);
  f.db.prepare("INSERT INTO ai_usage_suppressed_rows VALUES(10,'hook_records','hook-1','now')").run();
  assert.equal(f.queryService.analysis(f.access, { dataset: 'hooks' }).summary.recordCount, 2);
  assert.equal(f.queryService.hooks(f.access, { sortBy: 'hookName', sortDir: 'asc' }).total, 2);
  assert.equal(f.queryService.hookRecords(f.access, 'b', { sortBy: 'occurredAt', sortDir: 'asc' }).total, 1);
});

test('template grouping keeps application and actual-usage actors distinct', (t) => {
  const f = fixture(t); f.batch();
  const value = { templateId: 'tpl', templateName: 'Template' };
  f.row({ id: 'apply', dataset: 'template_applications', subjectId: 'tpl', userId: 2, value });
  f.row({ id: 'use', dataset: 'interactions', userId: 3, value });
  f.row({ id: 'duration', dataset: 'turns', userId: 3, value: { ...value, durationMs: 120000, status: 'completed' } });
  const result = f.queryService.analysis(f.access, { dataset: 'templates', groupBy: 'template' });
  assert.equal(result.total, 1);
  assert.deepEqual([result.summary.applicationUserCount, result.summary.activeUserCount, result.summary.activeDurationMs], [1, 1, 120000]);
  const byUser = f.queryService.analysis(f.access, { dataset: 'templates', groupBy: 'user', metric: 'sessionCount', minValue: 1 });
  assert.equal(byUser.summary.applicationCount, 0);
  assert.equal(byUser.items[0].groupLabel, 'member');
  assert.equal(f.queryService.templates(f.access, { sortBy: 'sessionCount', sortDir: 'asc' }).total, 1);
});

test('calendar week boundaries and calendar month grouping do not sum daily distinct counts', (t) => {
  const f = fixture(t); f.batch();
  for (const date of ['2026-08-31', '2026-09-06', '2026-09-07']) f.row({ id: date, date, dataset: 'interactions' });
  const weeks = f.queryService.analysis(f.access, { groupBy: 'week', sortBy: 'groupLabel', sortDir: 'asc' });
  assert.deepEqual(weeks.items.map((row) => row.groupLabel), ['2026-08-31', '2026-09-07']);
  assert.equal(weeks.summary.sessionCount, 1);
  const months = f.queryService.analysis(f.access, { groupBy: 'month' });
  assert.equal(months.total, 2); assert.equal(months.summary.activeUserCount, 1);
});

test('unavailable metrics remain null and cannot silently pass a numeric threshold', (t) => {
  const f = fixture(t); f.batch('batch-1', 10, 'published', { duration: 'unavailable' });
  f.row({ id: 'use', dataset: 'interactions' });
  assert.equal(f.queryService.analysis(f.access).summary.activeDurationMs, null);
  assert.throws(() => f.queryService.analysis(f.access, { metric: 'activeDurationMs', minValue: 0 }), { code: 'invalidFilter' });
  assert.throws(() => f.queryService.analysis(f.access, { dataset: ['usage'] }), { code: 'invalidFilter' });
});
