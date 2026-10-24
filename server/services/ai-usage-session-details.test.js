import assert from 'node:assert/strict';
import test from 'node:test';

import { SESSION_SUMMARY_COLUMNS, SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { fixture } from './ai-usage-test-fixture.js';

const range = { from: '2026-09-11', to: '2026-09-12' };
const coverage = { sessionSummaryVersion: SESSION_SUMMARY_VERSION };
const batch = (f, id = 'batch-1', tenantId = 10, status = 'published') => f.batch(id, tenantId, status, coverage);
function session(f, changes = {}, batchId = null) {
  const row = { id: 'session-a', tenant_id: 10, workspace_id: 7, user_id: 3, provider: 'claude', session_id: 'original-session',
    user_name: 'Published member', total_tokens: 1234, skill_list: '["sql-helper","review"]',
    start_time: '2026-09-11 09:00:00', end_time: '2026-09-12 18:00:00', ai_active_duration_seconds: 60.123, ...changes };
  f.db.prepare(`INSERT INTO ${batchId ? 'ai_session_summary_staging' : 'ai_session_summary'}
    (${batchId ? 'batch_id,' : ''}${SESSION_SUMMARY_COLUMNS}) VALUES (${batchId ? '@batch_id,' : ''}${SESSION_SUMMARY_COLUMNS.map(column => `@${column}`)})`)
    .run({ ...row, ...(batchId ? { batch_id: batchId } : {}) });
  return row;
}

function workspaceSnapshot(f, { tenantId = 10, userId = 3, workspaceId = 7, id = 'snapshot', name = 'Published workspace', batchId = 'batch-1' } = {}) {
  f.row({ id, dataset: 'interactions', tenantId, userId, workspaceId, batchId, value: { workspaceName: name } });
}

test('session details expose the eight requested columns from published sessions without recalculating totals or duration', t => {
  const f = fixture(t); batch(f);
  f.db.exec("INSERT INTO workspaces VALUES(7,10,'Current workspace','active')");
  session(f, { skill_list: '["review", " sql-helper ", "review", "", 1, null, {"name":"unexpected"}]' });
  const before = f.db.prepare('SELECT total_changes() AS n').get().n;
  const out = f.queryService.sessionDetails(f.access, range);
  assert.equal(out.sessionDetailVersion, 1);
  assert.equal(out.dateBasis, 'session_start');
  assert.equal(out.total, 1);
  assert.deepEqual(out.items, [{ id: 'session-a', tenantId: 10, userId: 3, workspaceId: 7, userName: 'member',
    workspaceName: 'Current workspace', sessionId: 'original-session', totalTokens: 1234, skillList: ['review', 'sql-helper'],
    startTime: '2026-09-11 09:00:00', endTime: '2026-09-12 18:00:00', activeDurationSeconds: 60.123 }]);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('unknown values stay null, confirmed zero stays zero, and skill JSON is parsed safely', t => {
  const f = fixture(t); batch(f);
  f.db.exec("UPDATE users SET username=' ' WHERE id=3");
  session(f, { id: 'unknown', user_name: null, total_tokens: null, end_time: null, ai_active_duration_seconds: null, skill_list: 'not-json' });
  session(f, { id: 'zero', user_name: '  historical  ', total_tokens: 0, ai_active_duration_seconds: 0, skill_list: '{"name":"not-an-array"}' });
  const out = f.queryService.sessionDetails(f.access, { ...range, sortBy: 'totalTokens', sortDir: 'asc' });
  assert.equal(out.items[0].totalTokens, 0);
  assert.equal(out.items[0].activeDurationSeconds, 0);
  assert.equal(out.items[0].userName, 'historical');
  assert.equal(out.items[1].totalTokens, null);
  assert.equal(out.items[1].activeDurationSeconds, null);
  assert.equal(out.items[1].endTime, null);
  assert.equal(out.items[1].userName, null);
  assert.ok(out.items.every(item => item.workspaceName === null && item.skillList.length === 0));
});

test('workspace labels use a same-tenant current name then a published visible snapshot', t => {
  const f = fixture(t); batch(f); batch(f, 'foreign', 20);
  f.db.exec("INSERT INTO workspaces VALUES(7,20,'Foreign private workspace','active'),(8,10,'Current name','active')");
  workspaceSnapshot(f);
  workspaceSnapshot(f, { tenantId: 20, id: 'foreign', name: 'Foreign snapshot', batchId: 'foreign' });
  workspaceSnapshot(f, { workspaceId: 8, id: 'changed', name: 'Old name' });
  workspaceSnapshot(f, { workspaceId: 9, id: 'suppressed', name: 'Suppressed name' });
  f.db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'interactions', 'suppressed');
  session(f);
  session(f, { id: 'current', workspace_id: 8 });
  session(f, { id: 'hidden', workspace_id: 9 });
  const rows = f.queryService.sessionDetails(f.access, range).items;
  assert.equal(rows.find(item => item.id === 'session-a').workspaceName, 'Published workspace');
  assert.equal(rows.find(item => item.id === 'current').workspaceName, 'Current name');
  assert.equal(rows.find(item => item.id === 'hidden').workspaceName, null);
});

test('dates select the session start day inclusively and preserve the complete session snapshot', t => {
  const f = fixture(t); batch(f);
  session(f, { id: 'before', start_time: '2026-09-10 23:59:59', end_time: '2026-09-12 15:00:00' });
  session(f, { id: 'start', start_time: '2026-09-11 00:00:00', total_tokens: 9876, ai_active_duration_seconds: 999.125 });
  session(f, { id: 'end', start_time: '2026-09-12 23:59:59', end_time: null });
  session(f, { id: 'after', start_time: '2026-09-13 00:00:00', end_time: null });
  const out = f.queryService.sessionDetails(f.access, range);
  assert.deepEqual(out.items.map(item => item.id), ['end', 'start']);
  assert.equal(out.items[1].totalTokens, 9876);
  assert.equal(out.items[1].activeDurationSeconds, 999.125);
  const singleDay = f.queryService.sessionDetails(f.access, { from: '2026-09-11', to: '2026-09-11' });
  assert.equal(singleDay.items[0].endTime, '2026-09-12 18:00:00');
  assert.equal(singleDay.items[0].activeDurationSeconds, 999.125);
});

test('ownership and literal user/workspace filters apply before pagination and never read staged sessions', t => {
  const f = fixture(t); batch(f);
  f.db.exec("UPDATE users SET username='member%_name' WHERE id=3; INSERT INTO workspaces VALUES(7,10,'研发%_组','active'),(8,10,'研发二组','active')");
  for (let index = 0; index < 5; index++) session(f, { id: `row-${index}`, total_tokens: index });
  session(f, { id: 'another-user', user_id: 4, total_tokens: 90 });
  session(f, { id: 'another-workspace', workspace_id: 8, total_tokens: 91 });
  session(f, { id: 'deleted-user', user_id: 99, total_tokens: 92 });
  batch(f, 'pending', 10, 'running'); session(f, { id: 'candidate', total_tokens: 93 }, 'pending');
  batch(f, 'foreign', 20); session(f, { id: 'foreign', tenant_id: 20, total_tokens: 94 });
  const filters = { ...range, userId: 3, workspaceId: 7, userSearch: '%_', workspaceSearch: '%_', sortBy: 'totalTokens', sortDir: 'asc', pageSize: 2 };
  const pages = [1, 2, 3].map(page => f.queryService.sessionDetails(f.access, { ...filters, page }));
  assert.ok(pages.every(page => page.total === 5));
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.totalTokens)), [0, 1, 2, 3, 4]);
  assert.equal(f.queryService.sessionDetails(f.access, { ...range, userSearch: 'absent' }).total, 0);
  assert.equal(f.queryService.sessionDetails(f.access, { ...range, workspaceSearch: 'absent' }).total, 0);
});

test('self scope only exposes the session owner and ignores client attempts to widen the scope', t => {
  const f = fixture(t); batch(f);
  session(f); session(f, { id: 'another', user_id: 4 });
  const self = f.accessService.resolve({ tenantId: 10, userId: 3 });
  const out = f.queryService.sessionDetails(self, { ...range, self: null, scope: 'tenant' });
  assert.equal(out.total, 1);
  assert.equal(out.items[0].userId, 3);
  assert.throws(() => f.queryService.sessionDetails(self, { ...range, userId: 4 }), { code: 'tenantReportDenied' });
});

test('all tenants keep identical source session IDs separate, sort globally and exclude inactive or unpublished tenants', t => {
  const f = fixture(t); batch(f); batch(f, 'foreign', 20);
  session(f, { id: 'same-id', total_tokens: 5 });
  session(f, { id: 'same-id', tenant_id: 20, total_tokens: 2 });
  session(f, { id: 'high', tenant_id: 20, total_tokens: 9 });
  f.db.exec("INSERT INTO tenants VALUES(30,'inactive'),(40,'active')");
  batch(f, 'inactive', 30); session(f, { id: 'inactive', tenant_id: 30, total_tokens: 0 });
  batch(f, 'running', 40, 'running');
  f.db.prepare('INSERT INTO ai_usage_tenant_state(tenant_id,active_batch_id) VALUES(?,?)').run(40, 'running');
  session(f, { id: 'unpublished', tenant_id: 40, total_tokens: 1 });
  const access = f.accessService.resolve({ tenantId: 'all', userId: 1 });
  const filters = { ...range, sortBy: 'totalTokens', sortDir: 'asc', pageSize: 1 };
  const pages = [1, 2, 3].map(page => f.queryService.sessionDetails(access, { ...filters, page }));
  assert.ok(pages.every(page => page.total === 3));
  assert.deepEqual(pages.flatMap(page => page.items.map(item => [item.tenantId, item.totalTokens])), [[20, 2], [10, 5], [20, 9]]);
  assert.ok(pages.every(page => page.items[0].sessionId === 'original-session'));
  assert.equal(new Set(pages.map(page => page.items[0].id)).size, 3);
  const ties = f.queryService.sessionDetails(access, { ...range, sortBy: 'sessionId', sortDir: 'asc' });
  assert.deepEqual(ties.items.map(item => [item.tenantId, item.id]), [[10, '10:same-id'], [20, '20:high'], [20, '20:same-id']]);
});

test('sorting accepts exactly the seven displayed scalar fields and keeps null values last', t => {
  const f = fixture(t); batch(f);
  session(f); session(f, { id: 'unknown', total_tokens: null, end_time: null, ai_active_duration_seconds: null });
  for (const sortBy of ['userName', 'workspaceName', 'sessionId', 'totalTokens', 'startTime', 'endTime', 'activeDurationSeconds']) {
    for (const sortDir of ['asc', 'desc']) assert.equal(f.queryService.sessionDetails(f.access, { ...range, sortBy, sortDir }).total, 2);
  }
  for (const sortBy of ['totalTokens', 'endTime', 'activeDurationSeconds']) {
    for (const sortDir of ['asc', 'desc']) assert.equal(f.queryService.sessionDetails(f.access, { ...range, sortBy, sortDir }).items[1].id, 'unknown');
  }
  for (const filters of [{ sortBy: 'skillList' }, { sortBy: 'id; DROP TABLE users' }, { sortDir: 'other' }, { groupBy: 'user' }, { provider: 'claude' },
    { page: 0 }, { pageSize: 101 }, { userId: '-1' }, { workspaceId: 'all' }, { from: '2026-02-30' }, { from: '2026-09-12', to: '2026-09-11' }, { userSearch: ['member'] }]) {
    assert.throws(() => f.queryService.sessionDetails(f.access, { ...range, ...filters }), { code: 'invalidFilter' });
  }
});

test('current-batch pinning rejects stale or unfinished snapshots and accepts an empty unpublished tenant', t => {
  const f = fixture(t);
  assert.deepEqual(f.queryService.sessionDetails(f.access, range).items, []);
  batch(f); session(f);
  batch(f, 'new');
  assert.throws(() => f.queryService.sessionDetails(f.access, { ...range, batchId: 'batch-1' }), { code: 'reportUpdated' });
  batch(f, 'running', 10, 'running');
  assert.throws(() => f.queryService.sessionDetails(f.access, { ...range, batchId: 'running' }), { code: 'batchNotFound' });
  batch(f, 'foreign', 20);
  const all = f.accessService.resolve({ tenantId: 'all', userId: 1 });
  const snapshot = f.queryService.sessionDetails(all, range).batchId;
  batch(f, 'foreign-new', 20);
  assert.throws(() => f.queryService.sessionDetails(all, { ...range, batchId: snapshot }), { code: 'reportUpdated' });
});

test('old coverage, missing table or missing duration column are explicit not-ready errors without writes', t => {
  const f = fixture(t); f.batch();
  assert.throws(() => f.queryService.sessionDetails(f.access, range), { code: 'sessionDetailsNotReady' });
  f.db.prepare('UPDATE ai_usage_batches SET coverage_json=?').run(JSON.stringify(coverage));
  f.db.exec('ALTER TABLE ai_session_summary DROP COLUMN ai_active_duration_seconds');
  assert.throws(() => f.queryService.sessionDetails(f.access, range), { code: 'sessionDetailsNotReady' });
  f.db.exec('DROP TABLE ai_session_summary');
  assert.throws(() => f.queryService.sessionDetails(f.access, range), { code: 'sessionDetailsNotReady' });
});

test('all tenants do not silently omit a published tenant whose session projection is not ready', t => {
  const f = fixture(t); batch(f); session(f); f.batch('old-foreign', 20);
  const all = f.accessService.resolve({ tenantId: 'all', userId: 1 });
  assert.throws(() => f.queryService.sessionDetails(all, range), { code: 'sessionDetailsNotReady' });
  assert.equal(f.queryService.sessionDetails(f.access, range).total, 1);
});


test('deleted sessions disappear immediately without waiting for the next published snapshot', t => {
  const f = fixture(t); batch(f); batch(f, 'foreign', 20);
  f.db.exec(`CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT,status TEXT);
    INSERT INTO session_index VALUES(10,7,3,'claude','original-session','deleted');`);
  session(f, { id: 'deleted' });
  session(f, { id: 'workspace', workspace_id: 8 });
  session(f, { id: 'user', user_id: 4 });
  session(f, { id: 'provider', provider: 'codex' });
  session(f, { id: 'tenant', tenant_id: 20 });
  const all = f.accessService.resolve({ tenantId: 'all', userId: 1 });
  const out = f.queryService.sessionDetails(all, range);
  assert.equal(out.total, 4);
  assert.ok(out.items.every(item => item.id !== '10:deleted'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 5);
});

test('suppressed source details hide the complete session without recalculating a partial metric', t => {
  const f = fixture(t); batch(f);
  session(f, { id: 'direct' });
  session(f, { id: 'related', session_id: 'hidden-related' });
  session(f, { id: 'visible', session_id: 'visible' });
  f.row({ id: 'hidden-turn', dataset: 'turns', sessionKey: JSON.stringify([10, 7, 3, 'claude', 'hidden-related']),
    value: { status: 'completed', durationMs: 60 } });
  f.db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'session_usage', 'direct');
  f.db.prepare('INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(?,?,?)').run(10, 'turns', 'hidden-turn');
  assert.deepEqual(f.queryService.sessionDetails(f.access, range).items.map(item => item.id), ['visible']);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 3);
});
