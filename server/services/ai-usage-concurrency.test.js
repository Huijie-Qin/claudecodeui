import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { readAiUsageConfig } from './ai-usage-config.js';
import { runAiUsageWindow } from './ai-usage-batches.js';

const night = () => new Date('2026-09-11T18:10:00.000Z');
const quietLogger = { info() {}, warn() {}, error() {} };
const configured = concurrency => ({
  ...readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_MAX_CONCURRENCY: String(concurrency) }),
  batchSize: 1,
});

function fixture(t, count = 5) {
  const db = new Database(':memory:');
  const historyRoot = mkdtempSync(path.join(os.tmpdir(), 'ai-usage-pool-history-'));
  t.after(() => { db.close(); rmSync(historyRoot, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,status TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,
      provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);`);
  for (let tenant = 1; tenant <= count; tenant++) {
    db.prepare("INSERT INTO tenants VALUES(?,'active')").run(tenant);
    db.prepare('INSERT INTO users VALUES(?,?)').run(tenant, `user-${tenant}`);
    db.prepare("INSERT INTO workspaces VALUES(?,?,?,'active')").run(tenant * 10, tenant, `workspace-${tenant}`);
    db.prepare("INSERT INTO session_index VALUES(?,?,?,'claude','shared-session','active')")
      .run(tenant, tenant * 10, tenant);
  }
  migrateAiUsageSchema(db);
  for (let tenant = 1; tenant <= count; tenant++) {
    const start = '2026-09-11T02:00:00.000Z';
    const end = new Date(Date.parse(start) + tenant * 60000).toISOString();
    db.prepare(`INSERT INTO ai_usage_turn_facts
      (turn_key,tenant_id,user_id,workspace_id,session_key,provider,started_at,response_completed_at,terminal_status,updated_at)
      VALUES(?,?,?,?,'shared-session','claude',?,?,'completed',?)`)
      .run(`turn-${tenant}`, tenant, tenant, tenant * 10, start, end, end);
    const home = path.join(historyRoot, String(tenant));
    const project = path.join(home, '.claude', 'projects', 'project');
    mkdirSync(project, { recursive: true });
    db.prepare("INSERT INTO agent_session_runtime VALUES(?,?,?,'claude','shared-session',?,?)")
      .run(tenant, tenant * 10, tenant, `runtime-${tenant}`, home);
    writeFileSync(path.join(project, 'shared-session.jsonl'), [
      { uuid: 'user', type: 'user', timestamp: start, sessionId: 'shared-session', message: { role: 'user', content: 'Request' } },
      { uuid: 'assistant', type: 'assistant', timestamp: end, sessionId: 'shared-session',
        message: { role: 'assistant', content: 'Reply', stop_reason: 'end_turn' } },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  }
  // Record observable lock releases, including whether any tenant was still
  // running. Tests never need timing sleeps or access to application databases.
  db.exec(`CREATE TABLE lock_release_audit(running_count INTEGER NOT NULL);
    CREATE TRIGGER audit_worker_lock_release AFTER DELETE ON ai_usage_worker_lock BEGIN
      INSERT INTO lock_release_audit SELECT COUNT(*) FROM ai_usage_batches WHERE status='running';
    END;`);
  return db;
}

function run(db, concurrency, options = {}) {
  return runAiUsageWindow({ database: db, config: configured(concurrency), now: night,
    logger: quietLogger, ...options });
}

function batches(db) {
  return db.prepare('SELECT tenant_id,status FROM ai_usage_batches ORDER BY tenant_id').all();
}

function runningCount(db) {
  return db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE status='running'").get().n;
}

function monitor(db, onStarted = () => {}) {
  const starts = [];
  const runningCounts = [];
  const logger = { ...quietLogger, info(message, details) {
    if (message !== '[AI usage] batch_started') return;
    starts.push(details.tenantId);
    runningCounts.push(runningCount(db));
    onStarted(details, starts);
  } };
  return { starts, runningCounts, logger };
}

function assertDrained(db, releases = 1) {
  assert.equal(runningCount(db), 0);
  assert.deepEqual(db.prepare('SELECT * FROM lock_release_audit').all(),
    Array.from({ length: releases }, () => ({ running_count: 0 })));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_worker_lock').get().n, 0);
}

function reportSnapshot(db) {
  const tables = ['ai_usage_report_rows', 'ai_dashboard_integration_detail', 'ai_dashboard_ai_detail',
    'ai_dashboard_skill_publication_detail', 'ai_dashboard_skill_invocation_detail',
    'ai_dashboard_sql_generation_detail', 'ai_dashboard_code_submission_detail', 'ai_session_summary'];
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
}

for (const concurrency of [1, 2]) {
  test(`concurrency ${concurrency} claims at most ${concurrency} tenants and processes every tenant once`, async t => {
    const db = fixture(t);
    const observed = monitor(db);
    const result = await run(db, concurrency, { logger: observed.logger });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.published, 5);
    assert.deepEqual(observed.starts, [1, 2, 3, 4, 5]);
    assert.equal(Math.max(...observed.runningCounts), concurrency,
      `expected actual overlap at configured capacity: ${observed.runningCounts}`);
    assert.ok(observed.runningCounts.every(count => count >= 1 && count <= concurrency));
    assert.deepEqual(batches(db), [1, 2, 3, 4, 5].map(tenant_id => ({ tenant_id, status: 'published' })));
    assertDrained(db);
  });
}

test('parallel and serial runs produce identical report projections and keep reused session IDs tenant-scoped', async t => {
  const serial = fixture(t);
  const parallel = fixture(t);
  assert.equal((await run(serial, 1)).published, 5);
  assert.equal((await run(parallel, 3)).published, 5);
  assert.deepEqual(reportSnapshot(parallel), reportSnapshot(serial));

  for (let tenant = 1; tenant <= 5; tenant++) {
    const turns = parallel.prepare("SELECT * FROM ai_usage_report_rows WHERE tenant_id=? AND dataset='turns'").all(tenant);
    assert.equal(turns.length, 1);
    assert.equal(JSON.parse(turns[0].value_json).durationMs, tenant * 60000);
    assert.deepEqual(JSON.parse(turns[0].session_key), [tenant, tenant * 10, tenant, 'claude', 'shared-session']);
    const summary = parallel.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=?').get(tenant);
    assert.equal(summary.user_id, tenant);
    assert.equal(summary.workspace_id, tenant * 10);
    assert.equal(summary.ai_active_duration_seconds, tenant * 60);
  }
  assertDrained(serial);
  assertDrained(parallel);
});

test('a stop request pauses every active tenant, stops claiming tenants, and drains before releasing the worker lock', async t => {
  const db = fixture(t);
  let stopped = false;
  const observed = monitor(db, (_batch, starts) => { if (starts.length === 2) stopped = true; });
  const result = await run(db, 2, { logger: observed.logger, shouldStop: () => stopped });

  assert.equal(result.status, 'paused', JSON.stringify(result));
  assert.equal(result.published, 0);
  assert.deepEqual(observed.starts, [1, 2]);
  assert.deepEqual(batches(db), [{ tenant_id: 1, status: 'paused' }, { tenant_id: 2, status: 'paused' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows').get().n, 0);
  assertDrained(db);
});

test('resuming a stopped parallel run reuses partial batches and matches a fresh serial result without duplicates', async t => {
  const db = fixture(t);
  const serial = fixture(t);
  let stopped = false;
  const paused = await run(db, 2, { shouldStop: () => {
    const partial = db.prepare("SELECT progress_json FROM ai_usage_batches WHERE status='running'").all()
      .some(batch => JSON.parse(batch.progress_json).partition?.cursor);
    if (runningCount(db) === 2 && partial) stopped = true;
    return stopped;
  } });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.published, 0);
  const pausedBatches = db.prepare("SELECT id,tenant_id FROM ai_usage_batches WHERE status='paused' ORDER BY tenant_id").all();
  assert.deepEqual(pausedBatches.map(batch => batch.tenant_id), [1, 2]);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_staging').get().n > 0,
    'stop after a persisted partial partition, not before processing begins');
  assertDrained(db);

  const observed = monitor(db);
  const resumed = await run(db, 2, { logger: observed.logger });
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(resumed.published, 5);
  assert.deepEqual(observed.starts, [1, 2, 3, 4, 5]);
  for (const batch of pausedBatches) {
    assert.equal(db.prepare('SELECT id FROM ai_usage_batches WHERE tenant_id=?').get(batch.tenant_id).id, batch.id);
  }
  assert.deepEqual(db.prepare('SELECT tenant_id,COUNT(*) n FROM ai_usage_batches GROUP BY tenant_id ORDER BY tenant_id').all(),
    [1, 2, 3, 4, 5].map(tenant_id => ({ tenant_id, n: 1 })));
  assert.equal((await run(serial, 1)).published, 5);
  assert.deepEqual(reportSnapshot(db), reportSnapshot(serial));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_staging').get().n, 0);
  assertDrained(db, 2);

  assert.equal((await run(db, 2)).published, 0);
  assert.deepEqual(reportSnapshot(db), reportSnapshot(serial));
  assertDrained(db, 3);
});

test('lease renewal extends the global lock and every concurrent active batch together', async t => {
  const db = fixture(t);
  const config = configured(2);
  let current = night();
  let expectedUntil = null;
  let renewalSnapshot = null;
  const observed = monitor(db, (_batch, starts) => {
    if (starts.length !== 2) return;
    current = new Date(current.getTime() + config.leaseMs / 4);
    expectedUntil = new Date(current.getTime() + config.leaseMs).toISOString();
  });
  const result = await run(db, 2, { logger: observed.logger, now: () => current, shouldStop: () => {
    const lock = db.prepare('SELECT lease_until FROM ai_usage_worker_lock WHERE id=1').get();
    if (!renewalSnapshot && expectedUntil && lock?.lease_until === expectedUntil) {
      renewalSnapshot = {
        global: lock.lease_until,
        batches: db.prepare("SELECT tenant_id,lease_until FROM ai_usage_batches WHERE status='running' ORDER BY tenant_id").all(),
      };
    }
    return false;
  } });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.published, 5);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(renewalSnapshot, { global: expectedUntil,
    batches: [1, 2].map(tenant_id => ({ tenant_id, lease_until: expectedUntil })) });
  assert.deepEqual(batches(db), [1, 2, 3, 4, 5].map(tenant_id => ({ tenant_id, status: 'published' })));
  assertDrained(db);
});

test('closing the statistics window pauses all active tenants without starting queued tenants', async t => {
  const db = fixture(t);
  let current = new Date('2026-09-11T21:59:59.000Z');
  const observed = monitor(db, (_batch, starts) => {
    if (starts.length === 2) current = new Date('2026-09-11T22:00:00.000Z');
  });
  const result = await run(db, 2, { logger: observed.logger, now: () => current });

  assert.equal(result.status, 'paused', JSON.stringify(result));
  assert.equal(result.published, 0);
  assert.deepEqual(observed.starts, [1, 2]);
  assert.deepEqual(batches(db), [{ tenant_id: 1, status: 'paused' }, { tenant_id: 2, status: 'paused' }]);
  assertDrained(db);
});

test('a normal tenant publication error does not prevent other active or queued tenants from completing', async t => {
  const db = fixture(t);
  db.exec(`CREATE TRIGGER fail_one_tenant BEFORE INSERT ON ai_session_summary WHEN NEW.tenant_id=2
    BEGIN SELECT RAISE(ABORT,'tenant 2 publication failed'); END;`);
  const observed = monitor(db);
  const result = await run(db, 2, { logger: observed.logger });

  assert.equal(result.status, 'partial_failure');
  assert.equal(result.published, 4);
  assert.deepEqual(result.errors, [{ tenantId: 2, message: 'tenant 2 publication failed' }]);
  assert.deepEqual(observed.starts, [1, 2, 3, 4, 5]);
  assert.ok(observed.runningCounts.every(count => count <= 2));
  assert.deepEqual(batches(db), [1, 2, 3, 4, 5].map(tenant_id => ({ tenant_id,
    status: tenant_id === 2 ? 'failed' : 'published' })));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows WHERE tenant_id=2').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 4);
  assertDrained(db);
});

test('the global worker lock still rejects a second runner while tenants are processing concurrently', async t => {
  const db = fixture(t);
  const observed = monitor(db);
  const first = run(db, 2, { logger: observed.logger });
  const firstToken = db.prepare('SELECT lease_token FROM ai_usage_worker_lock WHERE id=1').get().lease_token;
  const second = await run(db, 2);
  assert.deepEqual(second, { status: 'already_running', published: 0 });
  assert.equal(db.prepare('SELECT lease_token FROM ai_usage_worker_lock WHERE id=1').get().lease_token, firstToken);
  assert.equal((await first).published, 5);
  assert.deepEqual(observed.starts, [1, 2, 3, 4, 5]);
  assertDrained(db);
});

test('losing the global lease stops the pool before publication and preserves the replacement owner lock', async t => {
  const db = fixture(t);
  let current = night();
  const replacementToken = 'replacement-worker';
  const observed = monitor(db, (_batch, starts) => {
    if (starts.length !== 2) return;
    current = new Date(current.getTime() + configured(2).leaseMs / 4);
    db.prepare('UPDATE ai_usage_worker_lock SET lease_token=?,lease_until=? WHERE id=1')
      .run(replacementToken, new Date(current.getTime() + configured(2).leaseMs).toISOString());
  });
  await assert.rejects(run(db, 2, { logger: observed.logger, now: () => current }), /AI_USAGE_LEASE_LOST/);

  assert.deepEqual(observed.starts, [1, 2]);
  assert.equal(runningCount(db), 0, 'all active tenant promises must settle before the runner rejects');
  assert.deepEqual(batches(db), [{ tenant_id: 1, status: 'failed' }, { tenant_id: 2, status: 'failed' }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 0);
  assert.equal(db.prepare('SELECT lease_token FROM ai_usage_worker_lock WHERE id=1').get().lease_token, replacementToken);
  assert.deepEqual(db.prepare('SELECT * FROM lock_release_audit').all(), []);
});

test('an expired tenant lease stops the entire pool without leaving sibling batches running', async t => {
  const db = fixture(t);
  const observed = monitor(db, (_batch, starts) => {
    if (starts.length !== 2) return;
    db.prepare("UPDATE ai_usage_batches SET lease_until='2026-09-11T18:09:00.000Z' WHERE tenant_id=1").run();
  });
  await assert.rejects(run(db, 2, { logger: observed.logger }), /AI_USAGE_LEASE_LOST/);

  assert.deepEqual(observed.starts, [1, 2]);
  assert.equal(runningCount(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE status='published'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows').get().n, 0);
  assertDrained(db);
});

test('a global lease replacement immediately before publication is respected without waiting for renewal', async t => {
  const db = fixture(t);
  const observed = monitor(db);
  const replacementToken = 'replacement-before-publish';
  let replaced = false;
  await assert.rejects(run(db, 2, { logger: observed.logger, shouldStop: () => {
    const ready = db.prepare("SELECT progress_json FROM ai_usage_batches WHERE status='running'").all()
      .some(batch => JSON.parse(batch.progress_json).sessionSummary?.ready);
    if (!replaced && ready) {
      db.prepare('UPDATE ai_usage_worker_lock SET lease_token=? WHERE id=1').run(replacementToken);
      replaced = true;
    }
    return false;
  } }), /AI_USAGE_LEASE_LOST/);

  assert.equal(replaced, true, 'ownership must change at the prepared publication boundary');
  assert.deepEqual(observed.starts, [1, 2]);
  assert.equal(runningCount(db), 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_usage_report_rows').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary').get().n, 0);
  assert.equal(db.prepare('SELECT lease_token FROM ai_usage_worker_lock WHERE id=1').get().lease_token, replacementToken);
  assert.deepEqual(db.prepare('SELECT * FROM lock_release_audit').all(), []);
});
