import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { getAiUsageSchedule, readAiUsageConfig } from './ai-usage-config.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false',
  AI_USAGE_MAX_CONCURRENCY: '1' });

async function fixture(t, count = 2) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-tenant-order-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);`);
  for (let tenantId = 1; tenantId <= count; tenantId++) {
    db.prepare("INSERT INTO tenants VALUES(?,'active')").run(tenantId);
    db.prepare('INSERT INTO users VALUES(?,?)').run(tenantId, `user-${tenantId}`);
    db.prepare("INSERT INTO workspaces VALUES(?,?,?,'active')").run(tenantId * 10, tenantId, `workspace-${tenantId}`);
    db.prepare("INSERT INTO session_index VALUES(?,?,?,'claude','history')").run(tenantId, tenantId * 10, tenantId);
    const runtimeHome = path.join(home, String(tenantId));
    const project = path.join(runtimeHome, '.claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    db.prepare("INSERT INTO agent_session_runtime VALUES(?,?,?,?,'claude','history',?,?)")
      .run(tenantId, tenantId, tenantId * 10, tenantId, `runtime-${tenantId}`, runtimeHome);
    await writeFile(path.join(project, 'history.jsonl'), [
      { uuid: 'request', type: 'user', timestamp: '2026-09-01T02:00:00.000Z', message: { role: 'user', content: 'Request' } },
      { uuid: 'answer', type: 'assistant', timestamp: '2026-09-01T02:01:00.000Z', message: {
        role: 'assistant', content: '```sql\nSELECT 1;\n```', stop_reason: 'end_turn' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  migrateAiUsageSchema(db);
  async function run(at, { active, closeAfterFirstPublication = false, pauseAfterStart = false } = {}) {
    db.prepare("UPDATE tenants SET status='inactive'").run();
    for (const tenantId of active ?? Array.from({ length: count }, (_, index) => index + 1)) {
      db.prepare("UPDATE tenants SET status='active' WHERE id=?").run(tenantId);
    }
    let current = new Date(at);
    let stopped = false;
    const started = [];
    const published = [];
    const logger = { warn() {}, error() {}, info(message, details) {
      if (message === '[AI usage] batch_started') {
        started.push({ tenantId: details.tenantId, batchId: details.batchId });
        if (pauseAfterStart) stopped = true;
      }
      if (message === '[AI usage] batch_published') {
        published.push({ tenantId: details.tenantId, batchId: details.batchId });
        // The completed tenant used up the rest of this night's window. This
        // deterministic wall-clock jump needs neither timing sleeps nor mocks.
        if (closeAfterFirstPublication) current = new Date(getAiUsageSchedule(config, current).windowEndsAt);
      }
    } };
    const result = await runAiUsageWindow({ database: db, config, now: () => current,
      shouldStop: () => stopped, logger });
    return { ...result, started, publications: published };
  }
  return { db, run };
}

test('a tenant without any published snapshot gets the next full-mode night before a low-id tenant starts over', async t => {
  const f = await fixture(t);
  const first = await f.run('2026-09-11T21:59:59.000Z', { closeAfterFirstPublication: true });
  assert.equal(first.status, 'paused');
  assert.equal(first.published, 1);
  assert.deepEqual(first.started.map(entry => entry.tenantId), [1]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=2').get().n, 0);
  const second = await f.run('2026-09-12T21:59:59.000Z', { closeAfterFirstPublication: true });
  t.diagnostic(JSON.stringify({ firstNight: first.started, secondNight: second.started,
    batches: f.db.prepare('SELECT tenant_id,scheduled_for,status FROM ai_usage_batches ORDER BY scheduled_for,tenant_id').all() }));
  assert.equal(second.published, 1);
  assert.deepEqual(second.started.map(entry => entry.tenantId), [2],
    'a low-id tenant must not consume every new full-mode night while the other tenant never gets a first batch');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=1 AND status='published'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=2 AND status='published'").get().n, 1);
});

test('the oldest published coverage runs before a newer snapshot with an unfinished replacement', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('2026-09-14T18:10:00.000Z', { active: [1] })).published, 1);
  assert.equal((await f.run('2026-09-12T18:10:00.000Z', { active: [2] })).published, 1);
  const paused = await f.run('2026-09-15T18:10:00.000Z', { active: [1], pauseAfterStart: true });
  assert.equal(paused.status, 'paused');
  const pending = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get().id;
  const result = await f.run('2026-09-16T18:10:00.000Z');
  assert.equal(result.published, 2);
  assert.deepEqual(result.started.map(entry => entry.tenantId), [2, 1],
    'recently published tenants with unfinished new work must not overtake older visible snapshots');
  assert.equal(result.started[1].batchId, pending, 'the newer tenant still resumes its existing logical batch when its turn arrives');
});

test('equal published coverage resumes an unfinished full tenant first and catchup prevents a second same-window rebuild', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('2026-09-11T18:10:00.000Z')).published, 2);
  const paused = await f.run('2026-09-12T18:10:00.000Z', { active: [2], pauseAfterStart: true });
  assert.equal(paused.status, 'paused');
  const pending = f.db.prepare("SELECT id,scheduled_for FROM ai_usage_batches WHERE tenant_id=2 AND status='paused'").get();
  const at = '2026-09-13T18:10:00.000Z';
  const resumed = await f.run(at);
  assert.equal(resumed.published, 2);
  assert.deepEqual(resumed.started.map(entry => entry.tenantId), [2, 1]);
  assert.equal(resumed.started[0].batchId, pending.id);
  assert.equal(f.db.prepare('SELECT status FROM ai_usage_batches WHERE id=?').get(pending.id).status, 'published');
  const sameWindow = await f.run(at);
  assert.equal(sameWindow.published, 0);
  assert.deepEqual(sameWindow.started, [], 'the resumed full batch already covers this window after catchup');
  const current = f.db.prepare('SELECT scheduled_for,target_through,coverage_json FROM ai_usage_batches WHERE id=?').get(pending.id);
  const schedule = getAiUsageSchedule(config, new Date(at));
  assert.equal(current.scheduled_for, pending.scheduled_for);
  assert.equal(current.target_through, schedule.targetThrough);
  assert.equal(JSON.parse(current.coverage_json).completedWindowScheduledFor, schedule.scheduledFor);
  assert.equal((await f.run(at)).published, 0, 'both tenants have completed this window without another full rebuild');
});

test('equal coverage without unfinished work uses the earlier publication time before tenant id', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('2026-09-11T18:10:00.000Z', { active: [2] })).published, 1);
  assert.equal((await f.run('2026-09-11T18:20:00.000Z', { active: [1] })).published, 1);
  const result = await f.run('2026-09-12T18:10:00.000Z');
  assert.equal(result.published, 2);
  assert.deepEqual(result.started.map(entry => entry.tenantId), [2, 1],
    'coverage ties should favor the tenant whose visible result was refreshed earlier');
});

test('equal snapshots and unfinished work use the oldest scheduled batch with deterministic tenant-id ties', async t => {
  const f = await fixture(t, 3);
  assert.equal((await f.run('2026-09-11T18:10:00.000Z')).published, 3);
  assert.equal((await f.run('2026-09-14T18:10:00.000Z', { active: [1], pauseAfterStart: true })).status, 'paused');
  for (const tenantId of [2, 3]) {
    assert.equal((await f.run('2026-09-12T18:10:00.000Z', { active: [tenantId], pauseAfterStart: true })).status, 'paused');
  }
  const result = await f.run('2026-09-15T18:10:00.000Z');
  assert.equal(result.published, 3);
  assert.deepEqual(result.started.map(entry => entry.tenantId), [2, 3, 1]);
});

test('tenants without a published snapshot precede published tenants and resume their unfinished batches first', async t => {
  const f = await fixture(t, 3);
  assert.equal((await f.run('2026-09-11T18:10:00.000Z', { active: [3], pauseAfterStart: true })).status, 'paused');
  const pending = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=3 AND status='paused'").get().id;
  assert.equal((await f.run('2026-09-12T18:10:00.000Z', { active: [1] })).published, 1);
  const result = await f.run('2026-09-13T18:10:00.000Z');
  assert.equal(result.published, 3);
  assert.deepEqual(result.started.map(entry => entry.tenantId), [3, 2, 1],
    'both tenants without a snapshot precede the published tenant, with their unfinished batch resumed first');
  assert.equal(result.started[0].batchId, pending);
});
