import assert from 'node:assert/strict';
import test from 'node:test';

import { fixture } from './ai-usage-test-fixture.js';

const range = { from: '2026-09-11', to: '2026-09-12' };

test('integration details preserve published sparse facts, IDs, nulls and stored times without aggregation', t => {
  const f = fixture(t);
  f.batch();
  f.row({ id: 'duration', dataset: 'turns', value: { durationMs: 3723000, status: 'completed' } });
  f.row({ id: 'sql', dataset: 'sql_generations', value: { generatedLines: 0 } });
  f.row({ id: 'sql-unknown', dataset: 'sql_generations', date: '2026-09-12', value: { generatedLines: null } });
  const out = f.queryService.integrationDetails(f.access, range);
  assert.equal(out.integrationDetailVersion, 1);
  assert.equal(out.total, 3);
  const columns = key => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  for (const item of out.items) {
    const actual = Object.fromEntries(Object.entries(item).map(([key, value]) => [columns(key), value]));
    assert.deepEqual(actual, f.db.prepare('SELECT * FROM ai_dashboard_integration_detail WHERE tenant_id=? AND id=?').get(10, item.id));
  }
  assert.equal(out.items.find(item => item.aiActiveDurationMs != null).aiActiveDurationMs, 3723000);
  assert.equal(out.items.find(item => item.sqlRecordId === 'sql').generatedSqlLines, 0);
  assert.equal(out.items.find(item => item.sqlRecordId === 'sql-unknown').generatedSqlLines, null);
  assert.equal(out.items[0].occurredAt, '2026-09-12 18:00:00');
  assert.equal(out.items[0].refreshedAt, '2026-09-13 02:10:00');
});

test('integration details filter before stable pagination and never read candidates or other tenants', t => {
  const f = fixture(t);
  f.db.exec("INSERT INTO workspaces VALUES(7,10,'数据%组','active'),(8,10,'研发','active')");
  f.batch();
  for (let index = 0; index < 4; index++) f.row({ id: `sql-${index}`, dataset: 'sql_generations', value: { generatedLines: index } });
  f.row({ id: 'another-user', dataset: 'sql_generations', userId: 4, workspaceId: 8, value: { generatedLines: 99 } });
  f.row({ id: 'outside-date', dataset: 'sql_generations', date: '2026-09-10', value: { generatedLines: 88 } });
  f.batch('pending', 10, 'running');
  f.row({ id: 'candidate', dataset: 'sql_generations', batchId: 'pending', value: { generatedLines: 77 } });
  f.batch('foreign', 20);
  f.row({ id: 'foreign', dataset: 'sql_generations', batchId: 'foreign', tenantId: 20, value: { generatedLines: 66 } });
  const filters = { ...range, userId: 3, workspaceId: 7, userSearch: 'member', workspaceSearch: '%', sortBy: 'generatedSqlLines', sortDir: 'asc', pageSize: 2 };
  const first = f.queryService.integrationDetails(f.access, filters);
  const second = f.queryService.integrationDetails(f.access, { ...filters, page: 2 });
  assert.equal(first.total, 4);
  assert.deepEqual([...first.items, ...second.items].map(item => item.generatedSqlLines), [0, 1, 2, 3]);
  assert.ok(first.items.every(item => item.tenantId === 10 && item.userId === 3 && item.workspaceId === 7));
  assert.equal(f.queryService.integrationDetails(f.access, { ...range, workspaceSearch: 'missing' }).total, 0);
});

test('self scope means raw row owner/caller, never another caller who used the user’s published skill', t => {
  const f = fixture(t); f.batch();
  f.row({ id: 'pub', dataset: 'skill_publications', subjectId: 'skill-a', userId: 3, value: { publisherUserId: 3 } });
  f.row({ id: 'call', dataset: 'skill_invocations', subjectId: 'skill-a', userId: 3, value: { callerUserId: 4, publisherUserId: 3 } });
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  const owned = f.queryService.integrationDetails(self, range);
  assert.equal(owned.total, 1); assert.equal(owned.items[0].skillPublishCount, 1);
  const caller = f.queryService.integrationDetails(f.accessService.resolve({ tenantId: 10, userId: 4 }), range);
  assert.equal(caller.total, 1); assert.equal(caller.items[0].userId, 4); assert.equal(caller.items[0].skillCallCount, 1);
  assert.throws(() => f.queryService.integrationDetails(self, { ...range, userId: 4 }), { statusCode: 403 });
  assert.equal(f.queryService.integrationDetails(self, { ...range, self: null, scope: 'tenant' }).total, 1);
});

test('integration details enforce published current batch, ready projection and validated filters', t => {
  const f = fixture(t);
  assert.equal(f.queryService.integrationDetails(f.access).total, 0);
  f.batch(); f.row({ id: 'sql', dataset: 'sql_generations', value: { generatedLines: 2 } });
  f.batch('new');
  assert.throws(() => f.queryService.integrationDetails(f.access, { batchId: 'batch-1' }), { code: 'reportUpdated' });
  f.batch('running', 10, 'running');
  assert.throws(() => f.queryService.integrationDetails(f.access, { batchId: 'running' }), { code: 'batchNotFound' });
  for (const filters of [{ pageSize: 101 }, { sortBy: 'id;DROP TABLE users' }, { sortDir: 'other' }, { userId: '-1' }, { from: '2026-02-30' }, { groupBy: 'user' }, { provider: 'claude' }]) {
    assert.throws(() => f.queryService.integrationDetails(f.access, filters), { code: 'invalidFilter' });
  }
  f.db.exec("UPDATE ai_usage_batches SET coverage_json='{}' WHERE id='new'");
  assert.throws(() => f.queryService.integrationDetails(f.access), { code: 'integrationNotReady' });
});
