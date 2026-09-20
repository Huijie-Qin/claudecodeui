import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

const filters = { dataset: 'usage', groupBy: 'user', includeZeroUsers: true };
function populated(t) {
  const f = fixture(t); f.batch();
  f.row({ id: 'a', dataset: 'interactions', userId: 3 });
  f.row({ id: 'b', dataset: 'interactions', userId: 3, date: '2026-09-12' });
  f.row({ id: 'c', dataset: 'interactions', userId: 4, sessionKey: 'another-session', workspaceId: 8 });
  f.row({ id: 'duration', dataset: 'turns', userId: 3, value: { status: 'completed', durationMs: 300000 } });
  return f;
}

test('unified user table retains zero-use members without inflating distinct totals', (t) => {
  const f = populated(t);
  const old = f.queryService.analysis(f.access, { groupBy: 'user' });
  const full = f.queryService.analysis(f.access, { ...filters, sortBy: 'sessionCount', sortDir: 'asc' });
  assert.equal(full.includeZeroUsers, true);
  assert.equal(old.total, 2); assert.equal(full.total, 3);
  assert.equal(full.items[0].groupKey, '2');
  for (const key of ['sessionCount', 'activeDurationMs', 'activeUserCount']) assert.equal(full.items[0][key], 0);
  assert.deepEqual(full.summary, old.summary);
  assert.equal(full.summary.sessionCount, 2); assert.equal(full.summary.activeUserCount, 2);
  const pages = [1, 2, 3].flatMap((page) => f.queryService.analysis(f.access, { ...filters, sortBy: 'sessionCount', sortDir: 'asc', pageSize: 1, page }).items);
  assert.deepEqual(pages, full.items);
  assert.equal(f.queryService.analysis(f.access, { ...filters, pageSize: 1 }).summary.sessionCount, 2);
});

test('metric ranges, names and workspace filters also apply to the zero-user population', (t) => {
  const f = populated(t);
  const zero = f.queryService.analysis(f.access, { ...filters, metric: 'sessionCount', minValue: 0, maxValue: 0 });
  assert.deepEqual(zero.items.map((row) => row.groupKey), ['2']);
  assert.equal(zero.summary.sessionCount, 0); assert.equal(zero.summary.activeUserCount, 0);
  assert.equal(f.queryService.analysis(f.access, { ...filters, metric: 'sessionCount', minValue: 1 }).total, 2);
  assert.equal(f.queryService.analysis(f.access, { ...filters, search: 'tenant-admin' }).total, 1);
  assert.equal(f.queryService.analysis(f.access, { ...filters, userSearch: 'not-present' }).total, 0);
  const scoped = f.queryService.analysis(f.access, { ...filters, workspaceId: 7 });
  assert.equal(scoped.items.find((row) => row.groupKey === '4').sessionCount, 0);
  assert.equal(scoped.summary.sessionCount, 1);
});

test('zero users respect current tenant/self authorization and deleted identities', (t) => {
  const f = populated(t);
  f.db.exec("INSERT INTO users VALUES(5,'other-tenant-only',1,0); INSERT INTO tenant_users VALUES(20,5,'member','active');");
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  const result = f.queryService.analysis(self, { ...filters, workspaceId: 999 });
  assert.deepEqual(result.items.map((row) => row.groupKey), ['3']);
  assert.equal(result.items[0].sessionCount, 0);
  assert.throws(() => f.queryService.analysis(self, { ...filters, userId: 4 }), { statusCode: 403 });
  assert.ok(!f.queryService.analysis(f.access, filters).items.some((row) => ['1', '5'].includes(row.groupKey)));
  f.batch('other-batch', 20);
  assert.throws(() => f.queryService.analysis(f.access, { ...filters, batchId: 'other-batch' }), { statusCode: 404 });
  f.db.exec('DELETE FROM users WHERE id=4');
  assert.ok(!f.queryService.analysis(f.access, filters).items.some((row) => row.groupKey === '4'));
});

test('same-name members remain separate and historical groups are not silently dropped', (t) => {
  const f = populated(t);
  f.db.exec("UPDATE users SET username='same-name' WHERE id IN (2,3); DELETE FROM tenant_users WHERE tenant_id=10 AND user_id=4;");
  const result = f.queryService.analysis(f.access, filters);
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.filter((row) => row.groupLabel === 'same-name').map((row) => row.groupKey).sort(), ['2', '3']);
  assert.equal(result.summary.activeUserCount, 2);
});

test('unpublished and unavailable data never become fabricated zero usage', (t) => {
  const f = fixture(t);
  assert.equal(f.queryService.analysis(f.access, filters).total, 0);
  assert.equal(f.queryService.analysis(f.access, filters).summary, null);
  f.batch('batch-1', 10, 'published', { duration: 'unavailable', skillPublications: 'unavailable', skillInvocations: 'unavailable' });
  const result = f.queryService.analysis(f.access, filters);
  assert.equal(result.total, 3);
  assert.ok(result.items.every((row) => row.activeDurationMs === null && row.publishedSkillCount === undefined && row.skillInvocationCount === undefined));
  const skills = f.queryService.skills(f.access, { groupBy: 'publisher' });
  assert.equal(skills.summary.publishedSkillCount, null);
  assert.equal(skills.summary.invocationCount, null);
  assert.equal(skills.summary.callerCount, null);
  assert.throws(() => f.queryService.analysis(f.access, { ...filters, metric: 'activeDurationMs', maxValue: 0 }), { code: 'invalidFilter' });
});

test('zero-user option is validated and does not change other grouped reports', (t) => {
  const f = populated(t);
  assert.equal(f.queryService.analysis(f.access, { ...filters, includeZeroUsers: 'true' }).total, 3);
  assert.equal(f.queryService.analysis(f.access, { ...filters, includeZeroUsers: 'false' }).total, 2);
  for (const extra of [{ includeZeroUsers: 'anything' }, { dataset: 'hooks' }, { groupBy: 'day' }]) {
    assert.throws(() => f.queryService.analysis(f.access, { ...filters, ...extra }), { code: 'invalidFilter' });
  }
  assert.equal(f.queryService.analysis(f.access, { groupBy: 'day' }).total, 2);
});
