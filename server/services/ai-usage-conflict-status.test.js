import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createAiUsageQueryService } from './ai-usage-query.js';

function fixture(t, { exclusions = true, coverage = {} } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE ai_usage_batches(id TEXT,tenant_id INTEGER,status TEXT,coverage_json TEXT,
    target_through TEXT,time_zone TEXT,completed_at TEXT,source_read_at TEXT,calculation_version TEXT);
    CREATE TABLE ai_usage_tenant_state(tenant_id INTEGER,active_batch_id TEXT);
    INSERT INTO ai_usage_tenant_state VALUES(10,'published');`);
  db.prepare('INSERT INTO ai_usage_batches VALUES(?,?,?,?,?,?,?,?,?)').run('published', 10, 'published',
    JSON.stringify(coverage), '2026-10-11T16:00:00.000Z', 'Asia/Shanghai', '2026-10-11T18:10:00.000Z', null, 'test');
  if (exclusions) db.exec(`CREATE TABLE ai_usage_batch_session_exclusions(batch_id TEXT,tenant_id INTEGER,session_key TEXT,
    PRIMARY KEY(batch_id,tenant_id,session_key));`);
  const exclude = (key, { batchId = 'published', tenantId = 10 } = {}) => db.prepare(
    'INSERT INTO ai_usage_batch_session_exclusions VALUES(?,?,?)').run(batchId, tenantId, typeof key === 'string' ? key : JSON.stringify(key));
  return { db, exclude, query: createAiUsageQueryService({ db }) };
}

test('conflict coverage reveals only the current user’s complete session identities in the published tenant batch', (t) => {
  const { query, exclude } = fixture(t, { coverage: {
    sessions: 'complete', sessionScope: 'partial', excludedSessionCount: 4,
    conflictScopes: [{ tenantId: 20, userId: 9 }],
  } });
  exclude([10, 7, 3, 'claude', 'shared-session']);
  exclude([10, 8, 3, 'codex', 'shared-session']);
  exclude([10, 7, 4, 'claude', 'shared-session']);
  exclude([10, 9, 4, 'claude', 'another-session']);
  exclude([10, 7, 3, 'claude', 'next-batch'], { batchId: 'running' });
  exclude([20, 7, 3, 'claude', 'foreign-tenant'], { tenantId: 20 });
  // Corrupt or incomplete keys must neither expose a foreign user's presence
  // nor break an otherwise usable published report.
  exclude([20, 7, 3, 'claude', 'foreign-key']);
  exclude([10, 7, 3, 'claude']);
  exclude([10, 7, '3', 'claude', 'string-user']);
  exclude('malformed-json');

  const tenant = query.status({ tenantId: 10, scope: 'tenant', userId: 2 });
  assert.equal(tenant.coverage.excludedSessionCount, 4);
  assert.equal(tenant.coverage.sessionScope, 'partial');
  assert.equal(tenant.state, 'idle');

  const self = query.status({ tenantId: 10, scope: 'self', userId: 3 });
  assert.deepEqual(self.coverage, { sessions: 'complete', excludedSessionCount: 2, sessionScope: 'partial', status: 'partial' });
  assert.equal(self.batchId, 'published');
  assert.equal(self.lastSucceededAt, '2026-10-11T18:10:00.000Z');
  assert.equal(self.state, 'idle');

  assert.deepEqual(query.status({ tenantId: 10, scope: 'self', userId: 5 }).coverage,
    { sessions: 'complete', excludedSessionCount: 0, sessionScope: 'complete', status: 'complete' });
  assert.throws(() => query.status({ tenantId: 20, scope: 'self', userId: 3 }, 'published'), { code: 'batchNotFound' });
});

test('old report coverage and old databases remain usable without leaking tenant conflict diagnostics', (t) => {
  const { query } = fixture(t, { exclusions: false, coverage: {
    duration: 'complete', sessionScope: 'partial', excludedSessionCount: 91,
  } });
  assert.deepEqual(query.status({ tenantId: 10, scope: 'self', userId: 3 }).coverage,
    { duration: 'complete', status: 'complete' });
  assert.equal(query.status({ tenantId: 10, scope: 'tenant', userId: 2 }).coverage.excludedSessionCount, 91);

  const old = fixture(t, { coverage: { duration: 'partial' } });
  assert.deepEqual(old.query.status({ tenantId: 10, scope: 'self', userId: 3 }).coverage,
    { duration: 'partial', status: 'partial' });
  assert.deepEqual(old.query.status({ tenantId: 10, scope: 'tenant', userId: 2 }).coverage,
    { duration: 'partial', status: 'partial' });
  assert.deepEqual(old.query.status({ tenantId: 20, scope: 'self', userId: 3 }).coverage,
    { status: 'unavailable' });
});

test('a repaired published batch no longer reports earlier exclusions', (t) => {
  const { query, db, exclude } = fixture(t, { coverage: { sessionScope: 'partial', excludedSessionCount: 1 } });
  exclude([10, 7, 3, 'claude', 'session']);
  db.prepare('INSERT INTO ai_usage_batches VALUES(?,?,?,?,?,?,?,?,?)').run('repaired', 10, 'published',
    JSON.stringify({ sessionScope: 'complete', excludedSessionCount: 0 }), '2026-10-12T16:00:00.000Z',
    'Asia/Shanghai', '2026-10-12T18:10:00.000Z', null, 'test');
  db.exec("UPDATE ai_usage_tenant_state SET active_batch_id='repaired' WHERE tenant_id=10");
  for (const scope of ['self', 'tenant']) {
    const status = query.status({ tenantId: 10, scope, userId: 3 });
    assert.equal(status.batchId, 'repaired');
    assert.deepEqual(status.coverage, { excludedSessionCount: 0, sessionScope: 'complete', status: 'complete' });
  }
});
