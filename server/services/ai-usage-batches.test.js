import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { readAiUsageConfig, getAiUsageSchedule, localInstant, splitTurnByDate } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { createAiUsageService } from './ai-usage-scheduler.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const night = () => new Date('2026-09-11T18:10:00Z'); // Sep 12 02:10 Shanghai
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE workspace_agent_template_snapshots(workspace_id INTEGER PRIMARY KEY,template_id INTEGER,
      template_name TEXT,template_updated_at TEXT,created_by_user_id INTEGER,created_at TEXT);
    CREATE TABLE hook_data_records(id TEXT PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,workspace_id INTEGER,
      session_id TEXT,hook_id TEXT,record_type TEXT,data_json TEXT,created_at TEXT,
      post_action_id TEXT,hook_version INTEGER,record_source TEXT);
    CREATE TABLE hooks(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,
      provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    INSERT INTO tenants VALUES(1,'active'),(2,'active');
    INSERT INTO users VALUES(1,'alice'),(2,'bob');
    INSERT INTO workspaces VALUES(10,1,'Example','active'),(20,2,'Other tenant','active');`);
  migrateAiUsageSchema(db);
  return db;
}

function turn(db, key, start, end, tenant = 1, status = 'completed') {
  db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,
    started_at,response_completed_at,terminal_status,updated_at) VALUES(?,?,?,?,?,'claude',?,?,?,?)`)
    .run(key, tenant, tenant, tenant * 10, 'session-a', start, end, status, end || start);
}

function publishedRows(db, tenant = 1) {
  return db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=?').all(tenant)
    .map((row) => ({ ...row, value: JSON.parse(row.value_json) }));
}

test('ENV validates fixed daily time, explicit timezone, and a bounded window', () => {
  assert.equal(readAiUsageConfig({}).enabled, false);
  assert.throws(() => readAiUsageConfig({ AI_USAGE_RUN_AT: '25:00' }));
  assert.throws(() => readAiUsageConfig({ AI_USAGE_ENABLED: 'yes' }));
  assert.throws(() => readAiUsageConfig({ AI_USAGE_TIMEZONE: 'Invalid/Zone' }));
  assert.throws(() => readAiUsageConfig({ AI_USAGE_MAX_CONCURRENCY: '5' }));
  assert.throws(() => readAiUsageConfig({ AI_USAGE_WINDOW_END: '02:00' }));
  assert.equal(getAiUsageSchedule(config, night()).scheduledFor, '2026-09-11T18:00:00.000Z');
  assert.equal(getAiUsageSchedule(config, night()).targetThrough, '2026-09-11T16:00:00.000Z');
  assert.equal(getAiUsageSchedule(config, new Date('2026-09-12T02:00:00Z')).inWindow, false);
  assert.equal(getAiUsageSchedule(config, new Date('2026-09-11T22:00:00Z')).inWindow, false);
});

test('cross-midnight windows and DST gap/fold are scheduled once per local day', () => {
  const crossing = { ...config, runAt: '23:00', windowEnd: '03:00' };
  const schedule = getAiUsageSchedule(crossing, new Date('2026-09-11T17:00:00Z'));
  assert.equal(schedule.inWindow, true);
  assert.equal(schedule.scheduledFor, '2026-09-11T15:00:00.000Z');
  assert.equal(localInstant('2026-03-08', '02:00', 'America/New_York'), '2026-03-08T07:00:00.000Z');
  assert.equal(localInstant('2026-11-01', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z');
});

test('per-request duration is 2+3=5 minutes, and actual midnight crossing is 2+3', () => {
  const sum = (start, end) => [...splitTurnByDate(start, end, config.timeZone)].reduce((total, row) => total + row.durationMs, 0);
  assert.equal(sum('2026-09-11T02:00:00Z', '2026-09-11T02:02:00Z')
    + sum('2026-09-11T02:30:00Z', '2026-09-11T02:33:00Z'), 300000);
  assert.deepEqual([...splitTurnByDate('2026-09-11T15:58:00Z', '2026-09-11T16:03:00Z', config.timeZone)], [
    { date: '2026-09-11', durationMs: 120000 }, { date: '2026-09-12', durationMs: 180000 },
  ]);
  assert.deepEqual([...splitTurnByDate('2026-09-11T15:58:00Z', null, config.timeZone)], []);
});

test('daytime execution does not even open a statistics store', async () => {
  const result = await runAiUsageWindow({ database: { prepare() { throw new Error('Must not query'); } },
    config, now: () => new Date('2026-09-12T02:00:00Z') });
  assert.equal(result.status, 'outside_window');
});

test('resuming an obsolete definition resets staging and realigns the old target date to the new timezone', (t) => {
  const db = fixture(t);
  const now = () => new Date('2026-09-12T02:10:00.000Z');
  const store = createAiUsageStore(db, { clock: now });
  const oldConfig = { ...config, timeZone: 'UTC', calculationVersion: 'old-definition' };
  const old = store.claim(1, getAiUsageSchedule(oldConfig, now()), oldConfig, now());
  store.checkpoint(old, { stage: 'partitions', sourceCursor: ['message', '99'] }, oldConfig, now());
  store.finish(old, 'paused');
  const resumed = store.claim(1, getAiUsageSchedule(config, now()), config, now());
  assert.equal(resumed.id, old.id);
  assert.equal(resumed.calculation_version, config.calculationVersion);
  assert.equal(resumed.time_zone, 'Asia/Shanghai');
  assert.equal(resumed.target_through, '2026-09-11T16:00:00.000Z');
  assert.equal(resumed.progress_json, '{}');
});

test('nightly batches isolate tenants, exclude idle gaps and publish once', async (t) => {
  const db = fixture(t);
  turn(db, 'first', '2026-09-11T02:00:00Z', '2026-09-11T02:02:00Z');
  turn(db, 'second', '2026-09-11T02:30:00Z', '2026-09-11T02:33:00Z');
  turn(db, 'other', '2026-09-11T02:00:00Z', '2026-09-11T03:00:00Z', 2);
  const result = await runAiUsageWindow({ database: db, config, now: night });
  assert.equal(result.published, 2, JSON.stringify(result));
  assert.equal(publishedRows(db).filter((row) => row.dataset === 'turns').reduce((sum, row) => sum + row.value.durationMs, 0), 300000);
  assert.equal(publishedRows(db, 2).filter((row) => row.dataset === 'turns').reduce((sum, row) => sum + row.value.durationMs, 0), 3600000);
  assert.deepEqual(db.prepare(`SELECT tenant_id,session_id,start_time,end_time,total_tokens,ai_active_duration_seconds
    FROM ai_session_summary ORDER BY tenant_id`).all(), [
    { tenant_id: 1, session_id: 'session-a', start_time: '2026-09-11 10:00:00', end_time: '2026-09-11 10:33:00', total_tokens: null, ai_active_duration_seconds: 300 },
    { tenant_id: 2, session_id: 'session-a', start_time: '2026-09-11 10:00:00', end_time: '2026-09-11 11:00:00', total_tokens: null, ai_active_duration_seconds: 3600 },
  ]);
  assert.equal((await runAiUsageWindow({ database: db, config, now: night })).published, 0);
});

test('future-day facts are published on the next day even when sources did not change', async (t) => {
  const db = fixture(t);
  turn(db, 'midnight', '2026-09-11T15:58:00Z', '2026-09-11T16:03:00Z');
  await runAiUsageWindow({ database: db, config, now: night });
  const before = publishedRows(db).filter((row) => row.dataset === 'turns');
  assert.equal(before.length, 1); assert.equal(before[0].value.durationMs, 120000);
  const session = db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').get();
  assert.equal(session.end_time, null);
  assert.equal(session.ai_active_duration_seconds, null);
  await runAiUsageWindow({ database: db, config, now: () => new Date('2026-09-12T18:10:00Z') });
  const after = publishedRows(db).filter((row) => row.dataset === 'turns');
  assert.equal(after.length, 2); assert.equal(after.reduce((sum, row) => sum + row.value.durationMs, 0), 300000);
  assert.deepEqual(after.find((row) => row.stat_date === '2026-09-11'), before[0]);
  const updatedSession = db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').get();
  assert.equal(updatedSession.id, session.id);
  assert.equal(updatedSession.end_time, '2026-09-12 00:03:00');
  assert.equal(updatedSession.ai_active_duration_seconds, 300);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_session_summary WHERE tenant_id=1').get().n, 1);
});

test('resumed v1 session candidate is rebuilt with actual duration before publication', async t => {
  const db = fixture(t);
  turn(db, 'first', '2026-09-11T02:00:00Z', '2026-09-11T02:02:00Z');
  db.exec(`CREATE TRIGGER fail_session_publish BEFORE INSERT ON ai_session_summary
    BEGIN SELECT RAISE(ABORT,'session publication interrupted'); END;`);
  assert.equal((await runAiUsageWindow({ database: db, config, now: night })).status, 'partial_failure');
  const failed = db.prepare("SELECT id,progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='failed'").get();
  const progress = JSON.parse(failed.progress_json);
  progress.sessionSummary.version = 1;
  db.prepare('UPDATE ai_usage_batches SET progress_json=? WHERE id=?').run(JSON.stringify(progress), failed.id);
  db.exec('UPDATE ai_session_summary_staging SET ai_active_duration_seconds=NULL; DROP TRIGGER fail_session_publish;');
  const result = await runAiUsageWindow({ database: db, config, now: night });
  assert.equal(result.status, 'completed');
  assert.equal(db.prepare('SELECT ai_active_duration_seconds FROM ai_session_summary WHERE tenant_id=1').get().ai_active_duration_seconds, 120);
});

test('original report and its session projection publish atomically, including report usage enrichment', async t => {
  const db = fixture(t);
  turn(db, 'first', '2026-09-11T02:00:00Z', '2026-09-11T02:02:00Z');
  await runAiUsageWindow({ database: db, config, now: night });
  const oldReport = publishedRows(db);
  const oldSummary = db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').all();
  assert.equal(oldReport.filter(row => row.dataset === 'session_usage').length, 1);
  const completion = oldReport.find(row => row.dataset === 'turns').value.durationByCompletion;
  assert.deepEqual(completion, { '2026-09-11T02:02:00.000Z': 120000 });
  turn(db, 'second', '2026-09-12T02:00:00Z', '2026-09-12T02:01:00Z');
  const nextNight = () => new Date('2026-09-12T18:10:00Z');
  db.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON ai_session_summary WHEN NEW.tenant_id=1
    BEGIN SELECT RAISE(ABORT,'projection failed'); END;`);
  assert.equal((await runAiUsageWindow({ database: db, config, now: nextNight })).status, 'partial_failure');
  assert.deepEqual(publishedRows(db), oldReport);
  assert.deepEqual(db.prepare('SELECT * FROM ai_session_summary WHERE tenant_id=1').all(), oldSummary);
  db.exec('DROP TRIGGER fail_projection');
  assert.equal((await runAiUsageWindow({ database: db, config, now: nextNight })).status, 'completed');
  assert.equal(db.prepare('SELECT ai_active_duration_seconds FROM ai_session_summary WHERE tenant_id=1').get().ai_active_duration_seconds, 180);
  const usage = publishedRows(db).find(row => row.dataset === 'session_usage').value;
  assert.equal(usage.through, '2026-09-12T16:00:00.000Z');
});

test('late completion repairs the old day without inferring the end from another request', async (t) => {
  const db = fixture(t);
  turn(db, 'late', '2026-09-11T15:58:00Z', null, 1, 'pending');
  await runAiUsageWindow({ database: db, config, now: night });
  assert.equal(publishedRows(db).find((row) => row.dataset === 'turns').value.durationMs, null);
  db.prepare("UPDATE ai_usage_turn_facts SET terminal_status='completed',response_completed_at='2026-09-11T18:10:00Z' WHERE turn_key='late'").run();
  await runAiUsageWindow({ database: db, config, now: () => new Date('2026-09-12T18:10:00Z') });
  const rows = publishedRows(db).filter((row) => row.dataset === 'turns');
  assert.equal(rows.find((row) => row.stat_date === '2026-09-11').value.durationMs, 120000);
  assert.equal(rows.find((row) => row.stat_date === '2026-09-12').value.durationMs, 130 * 60000);
  assert.ok(rows.every((row) => row.value.status === 'completed'));
});

test('window pause preserves the old published batch and resumes from persisted progress', async (t) => {
  const db = fixture(t);
  await runAiUsageWindow({ database: db, config, now: night });
  const old = db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id;
  turn(db, 'new', '2026-09-12T02:00:00Z', '2026-09-12T02:02:00Z');
  let checks = 0;
  const tomorrow = () => new Date('2026-09-12T18:10:00Z');
  const result = await runAiUsageWindow({ database: db, config, now: tomorrow, shouldStop: () => ++checks > 8 });
  assert.equal(result.status, 'paused');
  assert.equal(db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, old);
  assert.equal((await runAiUsageWindow({ database: db, config, now: tomorrow })).published, 2);
});

test('expired lease holders cannot commit or publish over a replacement worker', (t) => {
  const db = fixture(t);
  const store = createAiUsageStore(db, { clock: night });
  const batch = store.claim(1, getAiUsageSchedule(config, night()), config, night());
  assert.equal(store.claim(1, getAiUsageSchedule(config, night()), config, night()), null);
  db.prepare("UPDATE ai_usage_batches SET lease_until='2026-09-10T00:00:00Z' WHERE id=?").run(batch.id);
  const next = store.claim(1, getAiUsageSchedule(config, night()), config, night());
  assert.notEqual(next.lease_token, batch.lease_token);
  assert.throws(() => store.publish(batch, {}, night()), /LEASE_LOST/);
});

test('paused partially computed rows stay only in staging and resume without double counting', async (t) => {
  const db = fixture(t);
  turn(db, 'old', '2026-09-11T02:00:00Z', '2026-09-11T02:02:00Z');
  await runAiUsageWindow({ database: db, config, now: night });
  const before = publishedRows(db);
  turn(db, 'new-1', '2026-09-12T02:00:00Z', '2026-09-12T02:02:00Z');
  turn(db, 'new-2', '2026-09-12T03:00:00Z', '2026-09-12T03:03:00Z');
  const options = { database: db, config: { ...config, batchSize: 1 }, now: () => new Date('2026-09-12T18:10:00Z') };
  const paused = await runAiUsageWindow({ ...options, shouldStop: () => {
    const current = db.prepare("SELECT progress_json FROM ai_usage_batches WHERE tenant_id=1 AND status='running'").get();
    return Boolean(current && JSON.parse(current.progress_json).partition?.cursor);
  } });
  assert.equal(paused.status, 'paused');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_staging').get().n > 0);
  assert.deepEqual(publishedRows(db), before);
  assert.equal((await runAiUsageWindow(options)).published, 2);
  assert.equal(publishedRows(db).filter((row) => row.dataset === 'turns').reduce((sum, row) => sum + row.value.durationMs, 0), 420000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage_report_staging').get().n, 0);
});

test('JSONL appends use persisted complete-line offsets and never attribute unknown files', async (t) => {
  const db = fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-fixture-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const dir = path.join(root, '.claude', 'projects', 'project'); await mkdir(dir, { recursive: true });
  db.prepare("INSERT INTO agent_session_runtime VALUES(1,10,1,'claude','session-a','runtime',?)").run(root);
  db.exec("INSERT INTO session_index VALUES(1,10,1,'claude','session-a')");
  const line = (id, timestamp) => JSON.stringify({ uuid: id, type: 'user', timestamp, sessionId: 'session-a', message: { role: 'user', content: 'hello' } });
  const file = path.join(dir, 'session-a.jsonl');
  const first = `${line('one', '2026-09-11T02:00:00Z')}\n`;
  await writeFile(file, first + line('two', '2026-09-12T02:00:00Z'));
  await writeFile(path.join(dir, 'unknown.jsonl'), `${line('secret', '2026-09-11T02:00:00Z')}\n`);
  await runAiUsageWindow({ database: db, config, now: night });
  assert.equal(db.prepare('SELECT offset FROM ai_usage_source_states').get().offset, Buffer.byteLength(first));
  assert.equal(publishedRows(db).filter((row) => row.dataset === 'interactions').length, 1);
  await appendFile(file, '\n');
  await runAiUsageWindow({ database: db, config, now: () => new Date('2026-09-12T18:10:00Z') });
  assert.equal(publishedRows(db).filter((row) => row.dataset === 'interactions').length, 2);
});

test('Hook sources preserve action identity and whitelist fields; deletes suppress old snapshots immediately', async (t) => {
  const db = fixture(t);
  db.exec("INSERT INTO hooks VALUES('a','same name'),('b','same name')");
  const insert = db.prepare('INSERT INTO hook_data_records VALUES(?,1,1,10,\'s\',?,\'sql_response_metrics\',?,\'2026-09-11 01:00:00\',\'action\',1,\'post_action\')');
  insert.run('record-a', 'a', JSON.stringify({ sqlLineCount: 7, password: 'secret', sql: 'do not expose' }));
  insert.run('record-b', 'b', JSON.stringify({ sqlLineCount: 9 }));
  await runAiUsageWindow({ database: db, config, now: night });
  const rows = publishedRows(db).filter((row) => row.dataset === 'hook_records');
  assert.equal(rows.length, 2); assert.notEqual(rows[0].subject_id, rows[1].subject_id);
  assert.equal(rows[0].value.postActionId, 'action');
  assert.ok(rows.every((row) => !row.value_json.includes('secret') && !row.value_json.includes('do not expose')));
  db.prepare('DELETE FROM hook_data_records WHERE id=?').run('record-a');
  assert.equal(db.prepare('SELECT row_key FROM ai_usage_suppressed_rows').get().row_key, 'record-a');
  assert.equal(db.prepare('SELECT data_revision FROM ai_usage_tenant_state WHERE tenant_id=1').get().data_revision, 1);
});

test('scheduler startup at 10:00 never launches a worker and 03:00 only launches one', (t) => {
  const db = fixture(t);
  let timestamp = new Date('2026-09-12T02:00:00Z');
  let calls = 0;
  const service = createAiUsageService({ database: db, databasePath: '/tmp/fixture.db', env: { AI_USAGE_ENABLED: 'true' },
    now: () => timestamp, workerFactory() { calls++; return Object.assign(new EventEmitter(), { postMessage() {} }); } });
  service.start(); t.after(() => service.stop());
  assert.equal(calls, 0);
  timestamp = new Date('2026-09-11T19:00:00Z'); service.tick(); service.tick();
  assert.equal(calls, 1);
});
