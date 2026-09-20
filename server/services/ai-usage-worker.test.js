import assert from 'node:assert/strict';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { getAiUsageSchedule, readAiUsageConfig } from './ai-usage-config.js';

test('real statistics Worker publishes through its own SQLite connection and exits cleanly', { timeout: 20000 }, async (t) => {
  // Resolve the clock before opening the fixture. The production Worker also
  // checks its window before preparing the statistics store's statements.
  const current = new Date();
  const hour = 3600000;
  const wallTime = (offset) => new Date(current.getTime() + offset + 8 * hour).toISOString().slice(11, 16);
  const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_TIMEZONE: 'Asia/Shanghai',
    AI_USAGE_RUN_AT: wallTime(-hour), AI_USAGE_WINDOW_END: wallTime(hour) });
  const schedule = getAiUsageSchedule(config, current);
  assert.equal(schedule.inWindow, true);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-usage-worker-smoke-'));
  const databasePath = path.join(directory, 'statistics-fixture.sqlite');
  const database = new Database(databasePath);
  let worker;
  let exited = false;
  t.after(async () => {
    if (worker && !exited) await worker.terminate();
    database.close();
    // The directory is freshly created and contains only this test's database/WAL files.
    for (const filename of await readdir(directory)) await unlink(path.join(directory, filename));
    await rmdir(directory);
  });
  database.pragma('journal_mode = WAL');
  database.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY, tenant_id INTEGER, display_name TEXT, status TEXT);
    INSERT INTO tenants VALUES(1, 'active');
    INSERT INTO users VALUES(1, 'worker-smoke-user');
    INSERT INTO workspaces VALUES(10, 1, 'Worker smoke workspace', 'active');`);
  migrateAiUsageSchema(database);

  // Configure a bounded window around the actual Shanghai clock. This keeps the real
  // Worker in-window at any test time without mocking Date or reading process.env/.env.
  const started = Date.parse(schedule.targetThrough) - 12 * hour;
  const iso = (minutes) => new Date(started + minutes * 60000).toISOString();
  const insert = database.prepare(`INSERT INTO ai_usage_turn_facts
    (turn_key, tenant_id, user_id, workspace_id, session_key, provider, started_at,
      response_completed_at, terminal_status, updated_at)
    VALUES(?, 1, 1, 10, 'worker-session', 'claude', ?, ?, 'completed', ?)`);
  insert.run('worker-request-1', iso(0), iso(2), iso(2));
  insert.run('worker-request-2', iso(30), iso(33), iso(33));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ai_usage_batches').get().count, 0);

  worker = new Worker(new URL('./ai-usage-worker.js', import.meta.url), {
    workerData: { databasePath, config },
  });
  assert.ok(worker.threadId > 0);
  const messages = [];
  const exitCode = await new Promise((resolve, reject) => {
    worker.on('message', (message) => messages.push(message));
    worker.once('error', reject);
    worker.once('exit', (code) => { exited = true; resolve(code); });
  });
  assert.equal(exitCode, 0, JSON.stringify(messages));
  assert.deepEqual(messages, [{ type: 'result', result: { status: 'completed', published: 1, errors: [] } }]);

  // This is the original parent connection, still open since before the Worker started.
  const batch = database.prepare(`SELECT b.* FROM ai_usage_tenant_state s
    JOIN ai_usage_batches b ON b.id = s.active_batch_id WHERE s.tenant_id = 1`).get();
  assert.equal(batch.status, 'published');
  assert.equal(batch.target_through, schedule.targetThrough);
  assert.ok(batch.completed_at);
  const result = database.prepare(`SELECT
    COUNT(DISTINCT CASE WHEN r.dataset = 'interactions' THEN r.session_key END) AS sessions,
    SUM(CASE WHEN r.dataset = 'turns' AND json_extract(r.value_json, '$.status') = 'completed'
      THEN json_extract(r.value_json, '$.durationMs') ELSE 0 END) AS duration
    FROM ai_usage_report_rows r WHERE r.tenant_id = 1`).get();
  assert.equal(result.sessions, 1);
  assert.equal(result.duration, 300000);
  const integration = database.prepare(`SELECT COUNT(DISTINCT CASE WHEN has_ai_interaction=1 THEN ai_session_id END) AS sessions,
    SUM(ai_active_duration_ms) AS duration FROM ai_dashboard_integration_detail WHERE tenant_id=1`).get();
  assert.deepEqual(integration, result);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ai_usage_worker_lock').get().count, 0);
});
