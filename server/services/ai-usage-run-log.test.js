import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { getAiUsageSchedule, readAiUsageConfig } from './ai-usage-config.js';

const configured = concurrency => ({ ...readAiUsageConfig({ AI_USAGE_ENABLED: 'true',
  AI_USAGE_INCREMENTAL_ENABLED: 'false', AI_USAGE_MAX_CONCURRENCY: String(concurrency) }), batchSize: 1 });
const quiet = { info() {}, warn() {}, error() {} };
const night = '2026-09-11T18:10:00.000Z';

async function fixture(t, count = 3) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-run-log-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);`);
  for (let tenant = 1; tenant <= count; tenant++) {
    db.prepare("INSERT INTO tenants VALUES(?,'active')").run(tenant);
    db.prepare('INSERT INTO users VALUES(?,?)').run(tenant, `user-${tenant}`);
    db.prepare("INSERT INTO workspaces VALUES(?,?,?,'active')").run(tenant * 10, tenant, `workspace-${tenant}`);
    db.prepare("INSERT INTO session_index VALUES(?,?,?,'claude','history')").run(tenant, tenant * 10, tenant);
    const runtimeHome = path.join(home, String(tenant));
    const project = path.join(runtimeHome, '.claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    db.prepare("INSERT INTO agent_session_runtime VALUES(?,?,?,?,'claude','history',?,?)")
      .run(tenant, tenant, tenant * 10, tenant, `runtime-${tenant}`, runtimeHome);
    await writeFile(path.join(project, 'history.jsonl'), [
      { uuid: 'request', type: 'user', timestamp: '2026-09-01T02:00:00.000Z', message: { role: 'user', content: 'Request' } },
      { uuid: 'answer', type: 'assistant', timestamp: '2026-09-01T02:01:00.000Z', message: {
        role: 'assistant', content: '```sql\nSELECT 1;\n```', stop_reason: 'end_turn' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  migrateAiUsageSchema(db);
  const run = (at = night, options = {}) => runAiUsageWindow({ database: db, config: configured(1),
    now: () => new Date(at), logger: quiet, ...options });
  const logs = (at = night) => db.prepare('SELECT * FROM ai_usage_run_logs WHERE scheduled_for=? ORDER BY tenant_id')
    .all(getAiUsageSchedule(configured(1), new Date(at)).scheduledFor);
  return { db, run, logs };
}

test('a shortened window records every eligible tenant, including tenants that never received a batch', async t => {
  const f = await fixture(t, 4);
  f.db.prepare("UPDATE tenants SET status='inactive' WHERE id=4").run();
  let current = new Date(night);
  const result = await f.run(night, { now: () => current, logger: { ...quiet, info(message) {
    if (message === '[AI usage] batch_started') {
      assert.equal(f.logs().length, 3, 'the entire eligible queue is durably visible before the first tenant begins');
    }
    if (message === '[AI usage] batch_published') current = new Date(getAiUsageSchedule(configured(1), current).windowEndsAt);
  } } });
  assert.equal(result.published, 1);
  assert.equal(result.status, 'paused');
  const rows = f.logs();
  assert.deepEqual(rows.map(row => [row.tenant_id, row.status, row.attempt_count]), [
    [1, 'published', 1], [2, 'pending', 0], [3, 'pending', 0],
  ]);
  assert.ok(rows.every(row => row.run_date === '2026-09-12' && row.time_zone === 'Asia/Shanghai'));
  assert.equal(rows[0].published_batches, 1);
  assert.equal(rows[0].last_published_batch_id, rows[0].batch_id);
  for (const row of rows.slice(1)) {
    assert.equal(row.reason, 'window_ended');
    assert.equal(row.started_at, null);
    assert.equal(row.batch_id, null);
    assert.equal(f.db.prepare('SELECT 1 FROM ai_usage_batches WHERE tenant_id=?').get(row.tenant_id), undefined);
  }
});

test('publishing an old resumed batch keeps the new window pending until its own current batch finishes', async t => {
  const f = await fixture(t, 1);
  let stop = false;
  const paused = await f.run(night, { shouldStop: () => stop, logger: { ...quiet, info(message) {
    if (message === '[AI usage] batch_started') stop = true;
  } } });
  assert.equal(paused.status, 'paused');
  const oldLog = f.logs()[0];
  assert.equal(oldLog.status, 'paused');
  const nextNight = '2026-09-12T18:10:00.000Z';
  assert.equal((await f.run(nextNight)).published, 1);
  const backlog = f.logs(nextNight)[0];
  assert.equal(backlog.status, 'pending');
  assert.equal(backlog.reason, 'backlog_remaining');
  assert.equal(backlog.batch_id, oldLog.batch_id);
  assert.equal(backlog.last_published_batch_id, oldLog.batch_id);
  assert.equal(backlog.published_batches, 1);
  assert.equal(backlog.attempt_count, 1);
  assert.equal(backlog.finished_at, null, 'the current window remains unfinished after publishing only its backlog');
  assert.ok(backlog.last_published_at);
  assert.ok(backlog.target_through > f.db.prepare('SELECT target_through FROM ai_usage_batches WHERE id=?').get(oldLog.batch_id).target_through);
  assert.equal(f.logs()[0].status, 'paused', 'a later window cannot retroactively complete the earlier window log');
  assert.equal((await f.run(nextNight)).published, 1);
  const completed = f.logs(nextNight)[0];
  assert.equal(completed.status, 'published');
  assert.equal(completed.published_batches, 2);
  assert.equal(completed.attempt_count, 2);
  assert.notEqual(completed.batch_id, oldLog.batch_id);
  assert.equal(completed.last_published_batch_id, completed.batch_id);
  assert.equal((await f.run(nextNight)).published, 0);
  assert.deepEqual(f.logs(nextNight)[0], completed, 'a completed same-window tick neither counts nor timestamps a duplicate attempt');
});

test('pause and tenant publication failure retain the saved stage and explain why later tenants did or did not run', async t => {
  const pausedFixture = await fixture(t, 2);
  const paused = await pausedFixture.run(night, { shouldStop: () => Boolean(pausedFixture.db.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE status='running' AND json_extract(progress_json,'$.stagingInitialized')=1`).get()) });
  assert.equal(paused.status, 'paused');
  const pausedRows = pausedFixture.logs();
  assert.equal(pausedRows[0].status, 'paused');
  assert.equal(pausedRows[0].stage, 'partitions');
  assert.equal(pausedRows[0].reason, 'stop_requested');
  assert.equal(pausedRows[1].status, 'pending');
  assert.equal(pausedRows[1].reason, 'stop_requested');
  assert.equal(pausedRows[1].attempt_count, 0);
  pausedFixture.db.prepare(`UPDATE ai_usage_run_logs SET reason='worker_failed',error='previous worker failure'
    WHERE tenant_id=2 AND status='pending'`).run();
  const retry = await pausedFixture.run('2026-09-11T18:11:00.000Z', { shouldStop: () => true });
  assert.equal(retry.status, 'paused');
  const stillQueued = pausedFixture.logs()[1];
  assert.equal(stillQueued.status, 'pending');
  assert.equal(stillQueued.reason, 'stop_requested', 'an unstarted retry reports its current stop reason rather than the prior worker failure');
  assert.notEqual(stillQueued.error, 'previous worker failure', 'the obsolete attempt error cannot survive queue initialization');
  assert.equal(stillQueued.attempt_count, 0, 'an immediate retry stop does not invent a claim');

  const failedFixture = await fixture(t, 2);
  failedFixture.db.exec(`CREATE TRIGGER reject_first_publication BEFORE INSERT ON ai_session_summary WHEN NEW.tenant_id=1
    BEGIN SELECT RAISE(ABORT,'run-log publication failure'); END;`);
  const failed = await failedFixture.run();
  assert.equal(failed.status, 'partial_failure');
  assert.equal(failed.published, 1);
  const failedRows = failedFixture.logs();
  assert.equal(failedRows[0].status, 'failed');
  assert.equal(failedRows[0].stage, 'publish');
  assert.match(failedRows[0].error, /run-log publication failure/);
  assert.equal(failedRows[0].published_batches, 0, 'a rolled-back publication cannot increment the log');
  assert.equal(failedRows[1].status, 'published', 'a failed tenant does not prevent queued tenants from completing');

  const brokenLogFixture = await fixture(t, 1);
  brokenLogFixture.db.exec(`CREATE TRIGGER reject_business_publication BEFORE INSERT ON ai_session_summary
    BEGIN SELECT RAISE(ABORT,'original publication failure'); END;
    CREATE TRIGGER reject_terminal_log BEFORE UPDATE OF status ON ai_usage_run_logs WHEN NEW.status='failed'
    BEGIN SELECT RAISE(ABORT,'terminal log write failure'); END;`);
  const logErrors = [];
  const fallback = await brokenLogFixture.run(night, { logger: { ...quiet, error(message, details) {
    logErrors.push({ message, details });
  } } });
  assert.equal(fallback.status, 'partial_failure');
  assert.match(fallback.errors[0].message, /original publication failure/, 'logging cannot replace the original business error');
  assert.equal(brokenLogFixture.db.prepare('SELECT status FROM ai_usage_batches').get().status, 'failed',
    'the business batch still terminates when terminal logging fails');
  assert.ok(logErrors.some(entry => entry.message === '[AI usage] run_log_failed'
    && entry.details.error.includes('terminal log write failure')));
  assert.equal(brokenLogFixture.db.prepare('SELECT effective_status FROM ai_usage_run_log_status').get().effective_status, 'interrupted',
    'the view does not misrepresent the leftover raw log as a live running worker');
});

test('concurrent runners and same-window restarts do not duplicate log rows, attempts, or publications', async t => {
  const f = await fixture(t, 3);
  let stop = false;
  let starts = 0;
  const first = f.run(night, { config: configured(2), shouldStop: () => stop, logger: { ...quiet, info(message) {
    if (message === '[AI usage] batch_started' && ++starts === 2) stop = true;
  } } });
  const rejected = await f.run(night, { config: configured(2) });
  assert.equal(rejected.status, 'already_running');
  assert.equal((await first).status, 'paused');
  assert.deepEqual(f.logs().map(row => [row.status, row.attempt_count]), [['paused', 1], ['paused', 1], ['pending', 0]]);
  assert.equal((await f.run(night, { config: configured(2) })).published, 3);
  const complete = f.logs();
  assert.deepEqual(complete.map(row => [row.status, row.attempt_count, row.published_batches]), [
    ['published', 2, 1], ['published', 2, 1], ['published', 1, 1],
  ]);
  assert.equal((await f.run(night, { config: configured(2) })).published, 0);
  assert.deepEqual(f.logs(), complete);
  f.db.prepare(`UPDATE ai_usage_run_logs SET status='pending',stage='partitions',reason='stale_log',error='stale_error',
    published_batches=0,last_published_batch_id=NULL,last_published_at=NULL WHERE tenant_id=1`).run();
  assert.equal((await f.run()).published, 0);
  const corrected = f.logs()[0];
  assert.equal(corrected.status, 'published', 'known published business state repairs an existing stale pending log');
  assert.equal(corrected.reason, 'already_published');
  assert.equal(corrected.error, null);
  assert.equal(corrected.published_batches, 1);
  assert.equal(corrected.attempt_count, complete[0].attempt_count);
  assert.equal(corrected.started_at, complete[0].started_at);
  assert.equal(corrected.last_published_batch_id, complete[0].batch_id);

  // Simulate enabling the new log feature after this window was already
  // published; recorded business completion must not turn into pending work.
  f.db.prepare("UPDATE ai_usage_batches SET coverage_json=json_remove(coverage_json,'$.incrementalEnabled') WHERE tenant_id=1").run();
  f.db.prepare('DELETE FROM ai_usage_run_logs').run();
  assert.equal((await f.run()).published, 0);
  const recovered = f.logs();
  assert.equal(recovered.length, 3);
  for (const row of recovered) {
    assert.equal(row.status, 'published');
    assert.equal(row.reason, 'already_published');
    assert.equal(row.attempt_count, 0);
    assert.equal(row.published_batches, 1, 'an existing published batch is confirmed completion even without an observed attempt');
    assert.equal(row.incremental_enabled, row.tenant_id === 1 ? null : 0, 'an older batch without a mode snapshot remains unknown');
    assert.equal(row.started_at, null, 'initialization must not invent an observed execution time');
    const batch = f.db.prepare('SELECT id,completed_at FROM ai_usage_batches WHERE tenant_id=?').get(row.tenant_id);
    assert.equal(row.last_published_batch_id, batch.id);
    assert.equal(row.last_published_at, batch.completed_at);
  }
  const laterInWindow = new Date(Date.parse(night) + 30 * 60_000).toISOString();
  assert.equal((await f.run(laterInWindow)).published, 0);
  assert.deepEqual(f.logs(), recovered, 'later polling of completed tenants must not rewrite their observed timestamps');
});

test('the status view distinguishes an owned running attempt from replaced owners and expired windows', async t => {
  const f = await fixture(t, 1);
  // The SQL view uses SQLite's real clock. Future leases make the live case
  // deterministic even though the runner receives an independent test clock.
  const at = '2100-09-11T18:10:00.000Z';
  let checked = false;
  const result = await f.run(at, { logger: { ...quiet, info(message) {
    if (message !== '[AI usage] batch_started') return;
    const row = f.logs(at)[0];
    const effective = () => f.db.prepare('SELECT effective_status FROM ai_usage_run_log_status WHERE scheduled_for=? AND tenant_id=1')
      .get(row.scheduled_for).effective_status;
    assert.equal(row.status, 'running');
    assert.ok(row.worker_lease_token);
    assert.ok(row.batch_lease_token);
    assert.equal(effective(), 'running');
    f.db.prepare("UPDATE ai_usage_worker_lock SET lease_token='replacement-owner' WHERE id=1").run();
    assert.equal(effective(), 'interrupted', 'a different live global lease does not own the old attempt');
    f.db.prepare('UPDATE ai_usage_worker_lock SET lease_token=? WHERE id=1').run(row.worker_lease_token);
    f.db.prepare("UPDATE ai_usage_batches SET lease_token='replacement-batch' WHERE id=?").run(row.batch_id);
    assert.equal(effective(), 'interrupted', 'a different batch lease cannot revive its prior attempt');
    f.db.prepare('UPDATE ai_usage_batches SET lease_token=? WHERE id=?').run(row.batch_lease_token, row.batch_id);
    f.db.prepare("UPDATE ai_usage_run_logs SET window_ends_at='1970-01-01T00:00:00.000Z' WHERE tenant_id=1").run();
    assert.equal(effective(), 'interrupted');
    f.db.prepare('UPDATE ai_usage_run_logs SET window_ends_at=? WHERE tenant_id=1').run(row.window_ends_at);
    assert.equal(effective(), 'running');
    checked = true;
  } } });
  assert.equal(result.published, 1);
  assert.equal(checked, true);
  assert.equal(f.db.prepare('SELECT effective_status FROM ai_usage_run_log_status').get().effective_status, 'published');
});

test('a worker that loses ownership cannot overwrite a replacement owner run log while unwinding', async t => {
  const f = await fixture(t, 1);
  const at = '2100-09-11T18:10:00.000Z';
  let replaced;
  await assert.rejects(f.run(at, { logger: { ...quiet, info(message) {
    if (message !== '[AI usage] batch_started') return;
    replaced = f.logs(at)[0];
    f.db.transaction(() => {
      f.db.prepare("UPDATE ai_usage_worker_lock SET lease_token='new-global-owner' WHERE id=1").run();
      f.db.prepare("UPDATE ai_usage_batches SET lease_token='new-batch-owner' WHERE id=?").run(replaced.batch_id);
      f.db.prepare(`UPDATE ai_usage_run_logs SET worker_lease_token='new-global-owner',batch_lease_token='new-batch-owner',
        reason='replacement_running',attempt_count=9 WHERE tenant_id=1`).run();
    })();
  } } }), /AI_USAGE_LEASE_LOST/);
  const row = f.logs(at)[0];
  assert.equal(row.status, 'running');
  assert.equal(row.reason, 'replacement_running');
  assert.equal(row.worker_lease_token, 'new-global-owner');
  assert.equal(row.batch_lease_token, 'new-batch-owner');
  assert.equal(row.attempt_count, 9);
  assert.equal(f.db.prepare('SELECT lease_token FROM ai_usage_worker_lock WHERE id=1').get().lease_token, 'new-global-owner');
  assert.equal(f.db.prepare('SELECT effective_status FROM ai_usage_run_log_status').get().effective_status, 'running');
});


test('a new owner records abandoned running attempts as interrupted without inventing outside-window or historical runs', async t => {
  const f = await fixture(t, 1);
  assert.equal((await f.run('2100-09-11T03:00:00.000Z')).status, 'outside_window');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_run_logs').get().n, 0);
  const firstNight = '2100-09-11T18:10:00.000Z';
  let stop = false;
  assert.equal((await f.run(firstNight, { shouldStop: () => stop, logger: { ...quiet, info(message) {
    if (message === '[AI usage] batch_started') stop = true;
  } } })).status, 'paused');
  const abandoned = f.logs(firstNight)[0];
  f.db.transaction(() => {
    f.db.prepare(`UPDATE ai_usage_batches SET status='running',lease_token='abandoned-batch',
      lease_until='1970-01-01T00:00:00.000Z' WHERE id=?`).run(abandoned.batch_id);
    f.db.prepare(`UPDATE ai_usage_run_logs SET status='running',worker_lease_token='abandoned-worker',
      batch_lease_token='abandoned-batch',reason=NULL,error=NULL,finished_at=NULL WHERE scheduled_for=?`)
      .run(abandoned.scheduled_for);
    f.db.prepare(`INSERT INTO ai_usage_worker_lock(id,lease_token,lease_until)
      VALUES(1,'abandoned-worker','1970-01-01T00:00:00.000Z')`).run();
  })();
  assert.equal(f.db.prepare('SELECT effective_status FROM ai_usage_run_log_status').get().effective_status, 'interrupted');
  const beforeOutsideWindow = f.logs(firstNight)[0];
  assert.equal((await f.run('2100-09-12T03:00:00.000Z')).status, 'outside_window');
  assert.deepEqual(f.logs(firstNight)[0], beforeOutsideWindow, 'a daytime check does not synthesize history or mutate the abandoned attempt');

  const nextNight = '2100-09-12T18:10:00.000Z';
  assert.equal((await f.run(nextNight)).published, 1);
  const recovered = f.logs(firstNight)[0];
  assert.equal(recovered.status, 'interrupted');
  assert.equal(recovered.reason, 'lease_lost_or_process_exit');
  assert.equal(recovered.updated_at, nextNight, 'the recovery timestamp is when abandonment was detected');
  assert.equal(recovered.finished_at, null, 'recovery cannot invent the original process termination time');
  assert.equal(recovered.attempt_count, 1);
  const pending = f.logs(nextNight)[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.reason, 'backlog_remaining');
  assert.equal(pending.batch_id, abandoned.batch_id);
  assert.equal(pending.published_batches, 1);
  assert.equal((await f.run(nextNight)).published, 1);
  assert.equal(f.logs(nextNight)[0].status, 'published');
  assert.equal(f.logs(nextNight)[0].published_batches, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_run_logs').get().n, 2, 'only the two observed nightly windows receive log rows');
});
