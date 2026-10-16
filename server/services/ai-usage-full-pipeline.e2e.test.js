import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';

import { auditUserUsage } from '../../scripts/audit-ai-usage-user.mjs';
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { createAiUsageRouter } from '../routes/ai-usage.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { getAiUsageSchedule, readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';

const fullConfig = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false', AI_USAGE_MAX_CONCURRENCY: '1' });
const incrementalConfig = { ...fullConfig, incrementalEnabled: true };
const historicalDates = ['2026-09-01', '2026-09-05', '2026-09-10'];
const currentRun = '2026-09-15T18:10:00.000Z';
const currentTarget = getAiUsageSchedule(fullConfig, new Date(currentRun)).targetThrough;

function turn(date, seconds, sqlLines, suffix = '') {
  const timestamp = `${date}T02:00:00.000Z`;
  return [
    { uuid: `request-${date}${suffix}`, type: 'user', timestamp, message: { role: 'user', content: 'Generate SQL' } },
    { uuid: `answer-${date}${suffix}`, type: 'assistant', timestamp: new Date(Date.parse(timestamp) + seconds * 1000).toISOString(),
      message: { role: 'assistant', content: `\`\`\`sql\n${Array.from({ length: sqlLines }, (_, i) => `SELECT ${i + 1};`).join('\n')}\n\`\`\``, stop_reason: 'end_turn' } },
  ];
}

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-full-pipeline-'));
  const databasePath = path.join(home, 'usage.db');
  let db = new Database(databasePath);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
    await rm(home, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_active INTEGER,is_system_admin INTEGER);
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER,role TEXT,status TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,normalized_json TEXT,provider_timestamp TEXT,created_at TEXT);
    INSERT INTO users VALUES(99,'administrator',1,1);`);
  const files = new Map();
  async function source(tenantId, sessionId, records) {
    const runtimeHome = path.join(home, String(tenantId));
    const project = path.join(runtimeHome, '.claude', 'projects', 'project');
    await mkdir(project, { recursive: true });
    if (!files.has(`${tenantId}:${sessionId}`)) {
      db.prepare("INSERT INTO session_index VALUES(?,?,?,'claude',?)").run(tenantId, tenantId * 10, tenantId, sessionId);
      db.prepare("INSERT INTO agent_session_runtime(tenant_id,workspace_id,user_id,provider,provider_session_id,runtime_id,runtime_home_path) VALUES(?,?,?,'claude',?,?,?)")
        .run(tenantId, tenantId * 10, tenantId, sessionId, `runtime-${tenantId}-${sessionId}`, runtimeHome);
    }
    const file = path.join(project, `${sessionId}.jsonl`);
    files.set(`${tenantId}:${sessionId}`, file);
    await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }
  for (const tenantId of [1, 2]) {
    db.prepare("INSERT INTO tenants VALUES(?,'active')").run(tenantId);
    db.prepare('INSERT INTO users VALUES(?,?,1,0)').run(tenantId, `user-${tenantId}`);
    db.prepare("INSERT INTO tenant_users VALUES(?,?,'member','active')").run(tenantId, tenantId);
    db.prepare("INSERT INTO workspaces VALUES(?,?,?,'active')").run(tenantId * 10, tenantId, `workspace-${tenantId}`);
    await source(tenantId, 'history', historicalDates.flatMap((date, i) => turn(date, (i + 1) * tenantId * 60, i + 1)));
  }
  migrateAiUsageSchema(db);
  const events = [];
  async function openHttp() {
    const app = express();
    app.use((req, res, next) => { req.user = { id: 99 }; next(); });
    app.use('/api/ai-usage', createAiUsageRouter({ db }));
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  }
  await openHttp();
  async function request(resource, tenantId, date) {
    const query = new URLSearchParams({ tenantId: String(tenantId), scope: 'tenant', userId: String(tenantId) });
    if (date) { query.set('from', date); query.set('to', date); }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ai-usage/${resource}?${query}`);
    return { status: response.status, body: await response.json() };
  }
  async function run(at, { config = fullConfig, active = [1, 2], stop } = {}) {
    db.prepare("UPDATE tenants SET status='inactive'").run();
    for (const tenantId of active) db.prepare("UPDATE tenants SET status='active' WHERE id=?").run(tenantId);
    let current = new Date(at);
    const result = await runAiUsageWindow({ database: db, config, now: () => current,
      shouldStop: () => {
        if (!stop?.(db)) return false;
        current = new Date(getAiUsageSchedule(config, current).windowEndsAt);
        return true;
      },
      logger: { info(message, data) { events.push({ message, data }); }, warn() {}, error() {} },
    });
    db.prepare("UPDATE tenants SET status='active'").run();
    return result;
  }
  async function restart() {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    server = null;
    db.close();
    db = new Database(databasePath);
    await openHttp();
  }
  return { get db() { return db; }, databasePath, source, request, run, restart, events };
}

async function seedWrongPublishedHistory(f) {
  assert.equal((await f.run('2026-09-10T18:10:00.000Z', { config: incrementalConfig })).published, 2);
  f.db.prepare("UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.durationMs',15000) WHERE dataset='turns'").run();
  f.db.prepare("UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.generatedLines',99) WHERE dataset='sql_generations'").run();
  f.db.prepare(`INSERT INTO ai_usage_dirty_partitions(tenant_id,dataset,stat_date)
    SELECT DISTINCT tenant_id,dataset,stat_date FROM ai_usage_fact_rows WHERE 1
    ON CONFLICT(tenant_id,dataset,stat_date) DO UPDATE SET generation=generation+1`).run();
  for (const tenantId of [1, 2]) createAiUsageStore(f.db).put(tenantId, 'retired-without-raw-source', [
    { dataset: 'sql_generations', row_key: `orphan-${tenantId}`, stat_date: '2026-09-03', user_id: tenantId,
      workspace_id: tenantId * 10, value: { provider: 'claude', generatedLines: 77 } },
  ]);
  assert.equal((await f.run('2026-09-11T18:10:00.000Z', { config: incrementalConfig })).published, 2);
  for (const tenantId of [1, 2]) {
    assert.equal((await f.request('overview', tenantId, historicalDates[0])).body.activeDurationMs, 15000);
    assert.equal((await f.request('code', tenantId, historicalDates[0])).body.summary.generatedLines, 99);
  }
}

async function changeRetainedHistory(f) {
  for (const tenantId of [1, 2]) {
    await f.source(tenantId, 'history', [
      ...historicalDates.flatMap((date, i) => turn(date, (i === 0 ? 5 : i + 1) * tenantId * 60, i === 0 ? 4 : i + 1)),
      ...turn('2026-09-14', tenantId * 240, 5),
    ]);
    await f.source(tenantId, 'new-session', turn('2026-09-13', tenantId * 120, 6));
  }
}

async function assertCurrentApiMatchesRawAudit(f, targets = {}) {
  for (const tenantId of [1, 2]) {
    const status = await f.request('status', tenantId);
    assert.equal(status.status, 200);
    assert.equal(status.body.dataThrough, targets[tenantId] || currentTarget,
      `tenant ${tenantId}: the resumed full batch must catch up to this window before publishing`);
    assert.equal(status.body.dataThroughDate, (targets[tenantId] || currentTarget).slice(0, 10));
    for (const date of [...historicalDates, '2026-09-03', '2026-09-13', '2026-09-14']) {
      const audit = await auditUserUsage({ databasePath: f.databasePath, tenantId, userId: tenantId,
        from: date, to: date, timeZone: 'Asia/Shanghai' });
      const ai = await f.request('overview', tenantId, date);
      const sql = await f.request('code', tenantId, date);
      assert.equal(ai.status, 200, `${tenantId}/${date}: AI dashboard date must be published`);
      assert.equal(sql.status, 200, `${tenantId}/${date}: SQL dashboard date must be published`);
      const expectedSeconds = tenantId * ({ '2026-09-01': 300, '2026-09-03': 0, '2026-09-05': 120, '2026-09-10': 180, '2026-09-13': 120, '2026-09-14': 240 })[date];
      assert.equal(audit.metrics.aiActiveDurationSeconds, expectedSeconds, `${tenantId}/${date}: audit sees the exact raw request/reply duration`);
      assert.equal(ai.body.activeDurationMs, audit.metrics.aiActiveDurationSeconds * 1000, `${tenantId}/${date}: AI HTTP value matches raw file audit`);
      assert.equal(sql.body.summary.generatedLines, audit.metrics.generatedSqlLines, `${tenantId}/${date}: SQL HTTP value matches raw file audit`);
      assert.equal(sql.body.summary.generatedLines, date === '2026-09-03' ? 0 : ({ '2026-09-01': 4, '2026-09-05': 2, '2026-09-10': 3, '2026-09-13': 6, '2026-09-14': 5 })[date]);
    }
  }
}

for (const stage of ['partitions', 'publish']) {
  test(`full ${stage} checkpoint survives window expiry and restart, then publishes current multi-tenant history through the real dashboard API`, async t => {
    const f = await fixture(t);
    await seedWrongPublishedHistory(f);
    const oldStatus = (await f.request('status', 2)).body;
    const paused = await f.run('2026-09-12T21:59:59.000Z', { active: [2], stop: db => Boolean(db.prepare(`SELECT 1 FROM ai_usage_batches
      WHERE tenant_id=2 AND status='running' AND json_extract(progress_json,'$.stage')=?`).get(stage)) });
    assert.equal(paused.status, 'paused');
    const pending = f.db.prepare("SELECT id,scheduled_for,target_through,progress_json FROM ai_usage_batches WHERE tenant_id=2 AND status='paused'").get();
    assert.ok(pending);
    assert.equal(JSON.parse(pending.progress_json).stage, stage);
    assert.equal((await f.request('status', 2)).body.batchId, oldStatus.batchId, 'paused candidate cannot replace the last atomic snapshot');
    assert.equal((await f.request('overview', 2, historicalDates[0])).body.activeDurationMs, 15000);
    await changeRetainedHistory(f);
    await f.restart();
    const result = await f.run(currentRun, { config: stage === 'publish' ? { ...fullConfig, concurrency: 2 } : fullConfig });
    assert.equal(result.published, 2);
    const status = (await f.request('status', 2)).body;
    const recent = await f.request('overview', 2, '2026-09-14');
    t.diagnostic(JSON.stringify({ checkpoint: stage, oldTarget: pending.target_through,
      target: status.dataThrough, generatedAt: status.generatedAt, recentHttpStatus: recent.status,
      historicalAiMs: (await f.request('overview', 2, historicalDates[0])).body.activeDurationMs,
      historicalSqlLines: (await f.request('code', 2, historicalDates[0])).body.summary.generatedLines }));
    await assertCurrentApiMatchesRawAudit(f);
    const current = f.db.prepare('SELECT id,scheduled_for FROM ai_usage_batches WHERE id=(SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=2)').get();
    assert.deepEqual(current, { id: pending.id, scheduled_for: pending.scheduled_for }, 'catch-up retains the logical batch identity');
    assert.equal(f.events.filter(event => event.message === '[AI usage] history_rebuild_started' && event.data.batchId === pending.id).length, 1,
      'catch-up preserves the full rebuild source progress instead of clearing everything again');
    assert.equal((await f.run(currentRun)).published, 0, 'a caught-up publication satisfies the current window without another full rebuild');
  });
}


test('catch-up interrupted by a second window expiry keeps the formal snapshot atomic and completes its fixed target after restart', async t => {
  const f = await fixture(t);
  await seedWrongPublishedHistory(f);
  const before = (await f.request('status', 2)).body;
  assert.equal((await f.run('2026-09-12T21:59:59.000Z', { active: [2], stop: db => Boolean(db.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE tenant_id=2 AND status='running' AND json_extract(progress_json,'$.stage')='publish'`).get()) })).status, 'paused');
  const pending = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=2 AND status='paused'").get();
  await changeRetainedHistory(f);
  const catchUpAt = '2026-09-14T21:59:59.000Z';
  const catchUpTarget = getAiUsageSchedule(fullConfig, new Date(catchUpAt)).targetThrough;
  const caughtThenPaused = await f.run(catchUpAt, { active: [2], stop: db => Boolean(db.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE id=? AND target_through=? AND json_extract(progress_json,'$.stage')='partitions'`).get(pending.id, catchUpTarget)) });
  assert.equal(caughtThenPaused.status, 'paused');
  assert.equal(caughtThenPaused.published, 0);
  const candidate = f.db.prepare('SELECT target_through,progress_json FROM ai_usage_batches WHERE id=?').get(pending.id);
  assert.equal(candidate.target_through, catchUpTarget);
  assert.equal(JSON.parse(candidate.progress_json).targetRefreshCount, 1);
  const during = (await f.request('status', 2)).body;
  assert.equal(during.batchId, before.batchId);
  assert.equal(during.dataThrough, before.dataThrough, 'a newer candidate cutoff cannot leak into the currently visible snapshot');
  assert.equal((await f.request('overview', 2, historicalDates[0])).body.activeDurationMs, 15000);
  assert.equal((await f.request('code', 2, historicalDates[0])).body.summary.generatedLines, 99);
  assert.equal((await f.request('overview', 2, '2026-09-14')).status, 400);
  assert.equal((await f.run('2026-09-15T00:10:00.000Z')).published, 0, 'outside-window invocation cannot publish unfinished work');
  await f.restart();
  assert.equal((await f.run(currentRun)).published, 2);
  await assertCurrentApiMatchesRawAudit(f, { 2: catchUpTarget });
  const resumed = f.db.prepare('SELECT target_through,coverage_json FROM ai_usage_batches WHERE id=?').get(pending.id);
  assert.equal(resumed.target_through, catchUpTarget, 'one logical full rebuild advances once so repeated short windows cannot postpone publication forever');
  const coverage = JSON.parse(resumed.coverage_json);
  assert.equal(coverage.targetRefreshCount, 1);
  assert.notEqual(coverage.completedWindowScheduledFor, getAiUsageSchedule(fullConfig, new Date(currentRun)).scheduledFor);
  const runLog = f.db.prepare('SELECT status,reason,published_batches FROM ai_usage_run_logs WHERE tenant_id=2 ORDER BY scheduled_for DESC LIMIT 1').get();
  assert.deepEqual(runLog, { status: 'pending', reason: 'backlog_remaining', published_batches: 1 },
    'publishing a fixed but older cutoff cannot falsely mark the newest scheduled window complete');
  assert.equal((await f.run(currentRun)).published, 1, 'the next tick starts a current full batch for the remaining backlog');
  await assertCurrentApiMatchesRawAudit(f);
  assert.equal((await f.run(currentRun)).published, 0);
});
