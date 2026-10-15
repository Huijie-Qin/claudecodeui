import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { auditUserUsage } from '../../scripts/audit-ai-usage-user.mjs';
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { logicalSessionKey } from './ai-usage-parser.js';
import { createAiUsageSkillContextRecorder } from './ai-usage-skill-context.js';
import { createAiUsageSkillRecorder } from './ai-usage-skills.js';

const incrementalConfig = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const fullConfig = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false' });
const scope = { tenant_id: 1, workspace_id: 10, user_id: 1, provider: 'claude', provider_session_id: 'rebuild-history' };
const sessionKey = logicalSessionKey(scope);
const start = '2026-09-10T02:00:00.000Z';
const user = (id, timestamp) => ({ uuid: id, timestamp, type: 'user', message: { role: 'user', content: 'Request' } });
const reply = (id, timestamp, sql = 'SELECT 1;') => ({ uuid: id, timestamp, type: 'assistant', message: {
  role: 'assistant', content: [{ type: 'text', text: `\`\`\`sql\n${sql}\n\`\`\`` }], stop_reason: 'end_turn',
} });
const history = () => [user('request-1', start), reply('answer-1', '2026-09-10T02:01:00.000Z'),
  user('request-2', '2026-09-10T03:00:00.000Z'), reply('answer-2', '2026-09-10T03:02:00.000Z', 'SELECT 2;\nSELECT 3;')];
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-rebuild-mode-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(project, 'rebuild-history.jsonl');
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,normalized_json TEXT,provider_timestamp TEXT,created_at TEXT);
    INSERT INTO tenants VALUES(1,'active'),(2,'inactive');
    INSERT INTO users VALUES(1,'alice'),(2,'bob');
    INSERT INTO workspaces VALUES(10,1,'Example','active'),(20,2,'Other tenant','active');
    INSERT INTO session_index VALUES(1,10,1,'claude','rebuild-history');`);
  db.prepare("INSERT INTO agent_session_runtime VALUES(1,1,10,1,'claude','rebuild-history','runtime-a',?)").run(home);
  migrateAiUsageSchema(db);
  db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,
    started_at,response_completed_at,terminal_status,updated_at)
    VALUES('captured',1,1,10,'rebuild-history','claude',?,?,'completed',?)`)
    .run(start, '2026-09-10T02:10:00.000Z', start);
  // A retained database copy remains raw evidence, but native history wins for this session.
  db.prepare("INSERT INTO agent_session_messages VALUES(1,1,10,1,'claude','rebuild-history','database-copy',?,?,?)")
    .run(JSON.stringify(reply('database-copy', '2026-09-10T02:20:00.000Z', 'SELECT 99;')), start, start);
  db.prepare("INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(1,'hook_records','deleted-hook')").run();
  createAiUsageStore(db).put(2, 'other-source', [{ dataset: 'sql_generations', row_key: 'other-sql',
    stat_date: '2026-09-10', user_id: 2, workspace_id: 20, value: { generatedLines: 17 } }]);
  db.prepare("INSERT INTO ai_usage_source_states(tenant_id,source_key,offset,state_json) VALUES(2,'other-file',10,'{}')").run();
  db.prepare("INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key) VALUES(2,'message','other-message')").run();
  db.prepare("INSERT INTO ai_usage_skill_groups VALUES(2,'other-session','other-group')").run();
  db.prepare("INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key) VALUES(2,'other-session')").run();
  let day = 11;
  const info = [];
  const now = () => new Date(`2026-09-${day}T18:10:00.000Z`);
  return { db, home, file, info,
    next: () => { day++; },
    write: records => writeFile(file, lines(records)),
    run: (config = incrementalConfig, options = {}) => runAiUsageWindow({ database: db, config, now,
      logger: { info(message, data) { info.push({ message, data }); }, warn() {}, error() {} }, ...options }),
  };
}

function publishedMetrics(f) {
  return {
    aiActiveDurationSeconds: f.db.prepare(`SELECT SUM(ai_active_duration_seconds) AS value
      FROM ai_dashboard_ai_detail WHERE tenant_id=1 AND user_id=1 AND stat_date BETWEEN '2026-09-09' AND '2026-09-10'`).get().value,
    generatedSqlLines: f.db.prepare(`SELECT SUM(generated_sql_lines) AS value
      FROM ai_dashboard_sql_generation_detail WHERE tenant_id=1 AND user_id=1 AND stat_date BETWEEN '2026-09-09' AND '2026-09-10'`).get().value,
  };
}

async function assertAuditParity(f, seconds, sqlLines) {
  const databasePath = path.join(f.home, 'audit.db');
  await writeFile(databasePath, f.db.serialize());
  const result = await auditUserUsage({ databasePath, tenantId: 1, userId: 1,
    from: '2026-09-09', to: '2026-09-10', timeZone: 'Asia/Shanghai' });
  const expected = { aiActiveDurationSeconds: seconds, generatedSqlLines: sqlLines };
  assert.deepEqual({ aiActiveDurationSeconds: result.metrics.aiActiveDurationSeconds,
    generatedSqlLines: result.metrics.generatedSqlLines }, expected, 'the full-file audit reads the expected raw history');
  assert.deepEqual(publishedMetrics(f), expected, 'both published nightly metrics agree with the independent audit');
}

function retainedData(f) {
  const tables = ['ai_usage_turn_facts', 'agent_session_messages', 'ai_usage_suppressed_rows'];
  const otherTenantTables = ['ai_usage_fact_rows', 'ai_usage_source_states', 'ai_usage_source_changes',
    'ai_usage_skill_groups', 'ai_usage_dirty_skill_sessions', 'ai_usage_dirty_partitions'];
  return Object.fromEntries([...tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ...otherTenantTables.map(table => [`other:${table}`, f.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=2 ORDER BY rowid`).all()])]);
}

function corruptCachedMetrics(f) {
  f.db.prepare(`UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.durationMs',30000)
    WHERE tenant_id=1 AND dataset='turns'`).run();
  f.db.prepare(`UPDATE ai_usage_fact_rows SET value_json=json_set(value_json,'$.generatedLines',99)
    WHERE tenant_id=1 AND dataset='sql_generations'`).run();
  f.db.prepare(`INSERT INTO ai_usage_dirty_partitions(tenant_id,dataset,stat_date)
    SELECT DISTINCT tenant_id,dataset,stat_date FROM ai_usage_fact_rows WHERE tenant_id=1
    ON CONFLICT(tenant_id,dataset,stat_date) DO UPDATE SET generation=generation+1`).run();
}

function addOrphanedFacts(f) {
  createAiUsageStore(f.db).put(1, 'retired-source-without-raw-record', [
    { dataset: 'turns', row_key: 'orphan:2026-09-09', stat_date: '2026-09-09', user_id: 1, workspace_id: 10,
      session_key: sessionKey, occurred_at: '2026-09-09T02:00:00.000Z', value: { provider: 'claude',
        turnKey: 'orphan', status: 'completed', requestStartedAt: '2026-09-09T02:00:00.000Z',
        responseCompletedAt: '2026-09-09T02:10:00.000Z', durationMs: 600000 } },
    { dataset: 'sql_generations', row_key: 'orphan-sql', stat_date: '2026-09-09', user_id: 1, workspace_id: 10,
      session_key: sessionKey, occurred_at: '2026-09-09T02:10:00.000Z', value: { provider: 'claude', generatedLines: 77 } },
  ]);
}

test('full rebuild replaces corrupt unchanged-file caches and orphan published dates while retaining raw data and tenant isolation', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run()).published, 1);
  await assertAuditParity(f, 180, 3);
  const suppressed = f.db.prepare(`SELECT row_key FROM ai_usage_fact_rows
    WHERE tenant_id=1 AND dataset='sql_generations' AND json_extract(value_json,'$.generatedLines')=1`).get();
  assert.ok(suppressed);
  f.db.prepare("INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(1,'sql_generations',?)").run(suppressed.row_key);
  const retained = retainedData(f);
  const unchanged = await stat(f.file);
  corruptCachedMetrics(f);
  addOrphanedFacts(f);
  f.next();
  assert.equal((await f.run()).published, 1);
  assert.deepEqual(publishedMetrics(f), { aiActiveDurationSeconds: 660, generatedSqlLines: 176 },
    'an ordinary incremental batch demonstrates the persisted wrong caches and orphan date');
  assert.ok(f.db.prepare("SELECT 1 FROM ai_usage_report_rows WHERE tenant_id=1 AND stat_date='2026-09-09'").get());
  f.next();
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 180, 2);
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_fact_rows WHERE tenant_id=1 AND source_key='retired-source-without-raw-record'").get(), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_report_rows WHERE tenant_id=1 AND stat_date='2026-09-09'").get(), undefined,
    'previously published dates absent from retained raw history are removed');
  assert.deepEqual(retainedData(f), retained, 'full rebuild does not delete source messages, captures, privacy tombstones or other-tenant caches');
  const after = await stat(f.file);
  assert.equal(after.ino, unchanged.ino);
  assert.equal(after.size, unchanged.size);
  assert.equal(after.mtimeMs, unchanged.mtimeMs, 'cache recovery does not depend on any file metadata change');
});

test('every new full-mode night rereads unchanged history while the same published daily batch stays closed', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 180, 3);
  for (let night = 0; night < 2; night++) {
    corruptCachedMetrics(f);
    f.next();
    assert.equal((await f.run(fullConfig)).published, 1);
    await assertAuditParity(f, 180, 3);
    const count = f.db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=1 AND status='published'").get().n;
    assert.equal((await f.run(fullConfig)).published, 0, 'full mode does not reopen a completed same-day batch');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_batches WHERE tenant_id=1 AND status='published'").get().n, count);
  }
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE tenant_id=1 AND dataset='turns'").get().n, 2);
});

test('a full rebuild initializes once per logical batch and preserves its old published snapshot through chunked pause and resume', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run()).published, 1);
  await assertAuditParity(f, 180, 3);
  const oldPublished = publishedMetrics(f);
  const oldSize = (await stat(f.file)).size;
  const oldBatch = f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id;
  const padding = Array.from({ length: 90 }, () => ({ type: 'system', padding: 'x'.repeat(4000) }));
  await f.write([...history(), ...padding,
    user('request-3', '2026-09-10T04:00:00.000Z'), reply('answer-3', '2026-09-10T04:01:00.000Z')]);
  const size = (await stat(f.file)).size;
  f.info.length = 0;
  f.next();
  const paused = await f.run(fullConfig, { shouldStop: () => {
    const source = f.db.prepare('SELECT offset FROM ai_usage_source_states WHERE tenant_id=1').get();
    return Boolean(source && source.offset > oldSize && source.offset < size);
  } });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(publishedMetrics(f), oldPublished);
  assert.equal(f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, oldBatch);
  const pausedBatch = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get().id;
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 240, 4);
  assert.equal(f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, pausedBatch);
  assert.equal(f.info.filter(entry => entry.message === '[AI usage] history_rebuild_started' && entry.data.batchId === pausedBatch).length, 1,
    'resuming the batch must not clear and initialize its full rebuild again');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE tenant_id=1 AND dataset='turns'").get().n, 3);
});


function seedOrphanAggregates(f) {
  const insert = f.db.prepare(`INSERT INTO ai_usage_report_rows
    (tenant_id,dataset,row_key,stat_date,user_id,workspace_id,value_json) VALUES(1,?,?,?,1,10,?)`);
  for (const dataset of ['daily_active_users', 'hook_daily', 'active_users']) {
    insert.run(dataset, `orphan-${dataset}`, '2026-09-09', JSON.stringify({ orphan: true, count: 42 }));
  }
}

test('changing a paused incremental batch to full mode discards its candidate and removes orphan aggregates', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run()).published, 1);
  seedOrphanAggregates(f);
  corruptCachedMetrics(f);
  addOrphanedFacts(f);
  f.next();
  const paused = await f.run(incrementalConfig, { shouldStop: () => Boolean(f.db.prepare(`SELECT 1 FROM ai_usage_batches
    WHERE tenant_id=1 AND status='running' AND json_extract(progress_json,'$.stagingInitialized')=1`).get()) });
  assert.equal(paused.status, 'paused');
  const batch = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get();
  assert.ok(f.db.prepare('SELECT 1 FROM ai_usage_report_staging WHERE batch_id=?').get(batch.id));
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 180, 3);
  assert.equal(f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, batch.id,
    'the same logical scheduled batch restarts under the newly configured mode');
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_report_rows WHERE tenant_id=1 AND row_key LIKE 'orphan-%'").get(), undefined,
    'full staging cannot retain an orphan aggregate copied by the interrupted incremental candidate');
  const coverage = JSON.parse(f.db.prepare('SELECT coverage_json FROM ai_usage_batches WHERE id=?').get(batch.id).coverage_json);
  assert.equal(coverage.incrementalEnabled, false);
});

test('a later full rebuild removes vanished source results and cannot resurrect suppressed SQL', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run(fullConfig)).published, 1);
  const suppressed = f.db.prepare(`SELECT row_key FROM ai_usage_fact_rows
    WHERE tenant_id=1 AND dataset='sql_generations' AND json_extract(value_json,'$.generatedLines')=1`).get().row_key;
  f.db.prepare("INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(1,'sql_generations',?)").run(suppressed);
  f.next();
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 180, 2);
  assert.equal(f.db.prepare('SELECT 1 FROM ai_dashboard_sql_generation_detail WHERE tenant_id=1 AND sql_record_id=?').get(suppressed), undefined);
  seedOrphanAggregates(f);
  await unlink(f.file);
  f.db.exec('DELETE FROM agent_session_messages WHERE tenant_id=1; DELETE FROM ai_usage_turn_facts WHERE tenant_id=1;');
  f.next();
  assert.equal((await f.run(fullConfig)).published, 1);
  assert.deepEqual(publishedMetrics(f), { aiActiveDurationSeconds: null, generatedSqlLines: null },
    'removed raw sources must not leave previously published duration or SQL behind');
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_report_rows WHERE tenant_id=1 AND row_key LIKE 'orphan-%'").get(), undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_fact_rows WHERE tenant_id=1 AND dataset IN ('turns','sql_generations')").get(), undefined);
  assert.ok(f.db.prepare("SELECT 1 FROM ai_usage_suppressed_rows WHERE tenant_id=1 AND dataset='sql_generations' AND row_key=?").get(suppressed),
    'the suppression marker survives even after its raw source disappears');
});

test('changing a paused full batch back to incremental resumes rebuilt sources without retaining its abandoned candidate', async t => {
  const f = await fixture(t);
  await f.write(history());
  assert.equal((await f.run()).published, 1);
  const oldPublished = publishedMetrics(f);
  const oldSize = (await stat(f.file)).size;
  const padding = Array.from({ length: 90 }, () => ({ type: 'system', padding: 'x'.repeat(4000) }));
  await f.write([...history(), ...padding,
    user('request-3', '2026-09-10T04:00:00.000Z'), reply('answer-3', '2026-09-10T04:01:00.000Z')]);
  const size = (await stat(f.file)).size;
  f.next();
  const paused = await f.run(fullConfig, { shouldStop: () => {
    const source = f.db.prepare('SELECT offset FROM ai_usage_source_states WHERE tenant_id=1').get();
    return Boolean(source && source.offset > oldSize && source.offset < size);
  } });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(publishedMetrics(f), oldPublished);
  const batch = f.db.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=1 AND status='paused'").get();
  f.db.prepare(`INSERT INTO ai_usage_report_staging
    (batch_id,tenant_id,dataset,row_key,stat_date,user_id,workspace_id,value_json)
    VALUES(?,1,'daily_active_users','abandoned-candidate','2026-09-09',1,10,'{}')`).run(batch.id);
  assert.equal((await f.run(incrementalConfig)).published, 1);
  await assertAuditParity(f, 240, 4);
  assert.equal(f.db.prepare("SELECT 1 FROM ai_usage_report_rows WHERE tenant_id=1 AND row_key='abandoned-candidate'").get(), undefined);
  assert.equal(f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=1').get().active_batch_id, batch.id);
  const coverage = JSON.parse(f.db.prepare('SELECT coverage_json FROM ai_usage_batches WHERE id=?').get(batch.id).coverage_json);
  assert.equal(coverage.incrementalEnabled, true);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE tenant_id=1 AND dataset='turns'").get().n, 3);
});


test('full rebuild preserves published Skill and Hook metrics from real source records without mutating those sources', async t => {
  const f = await fixture(t);
  f.db.exec(`CREATE TABLE hooks(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE hook_data_records(id TEXT PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,workspace_id INTEGER,
      session_id TEXT,hook_id TEXT,record_type TEXT,data_json TEXT,created_at TEXT,
      post_action_id TEXT,hook_version INTEGER,record_source TEXT);
    CREATE TABLE hook_executions(id TEXT PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,workspace_id INTEGER,
      session_id TEXT,hook_id TEXT,hook_version INTEGER,event_name TEXT,status TEXT,duration_ms INTEGER,
      started_at TEXT,completed_at TEXT);
    INSERT INTO hooks VALUES('metrics-hook','SQL metrics');`);
  migrateAiUsageSchema(f.db);
  const insertHook = f.db.prepare(`INSERT INTO hook_data_records VALUES(?,1,1,10,'rebuild-history','metrics-hook',
    'sql_response_metrics',?,'2026-09-10T04:02:00.000Z','write-metrics',1,'post_action')`);
  insertHook.run('hook-record-a', JSON.stringify({ sqlLineCount: 7 }));
  insertHook.run('hook-record-b', JSON.stringify({ sqlLineCount: 9 }));
  f.db.exec(`INSERT INTO hook_executions VALUES('hook-execution',1,1,10,'rebuild-history','metrics-hook',1,
    'Stop','success',1500,'2026-09-10T04:01:00.000Z','2026-09-10T04:01:01.500Z')`);
  f.db.prepare(`INSERT INTO ai_skill_binding_history
    (tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from)
    VALUES(1,10,'report','market:report',1,'2026-09-01T00:00:00.000Z')`).run();
  const logger = { warn(message) { assert.fail(message); } };
  const skillRecorder = createAiUsageSkillRecorder({ database: f.db, now: () => start, logger });
  const publication = { tenantId: 1, userId: 1, workspaceId: 10, operationId: 'publish-report',
    publishKind: 'create', skillId: 'market:report', skillName: 'report', publishedAt: start };
  assert.ok(skillRecorder.beginPublishEvent(publication));
  assert.equal(skillRecorder.succeedPublishEvent(publication), true);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const context = createAiUsageSkillContextRecorder({ database: f.db, now: () => '2026-09-10T04:00:00.000Z', logger });
  const requestContext = { tenantId: 1, userId: 1, workspaceId: 10, provider: 'claude',
    sessionId: 'rebuild-history', requestId, origin: 'user', skillName: 'report' };
  assert.deepEqual(context.recordRequest({ ...requestContext, contextId: requestId }), { changed: true });
  assert.deepEqual(context.recordTool({ ...requestContext, contextId: 'report-tool', occurredAt: '2026-09-10T04:00:20.000Z' }), { changed: true });
  const request = user(requestId, '2026-09-10T04:00:00.000Z');
  request.message.content = '/report';
  await f.write([...history(), request,
    { uuid: 'skill-assistant', timestamp: '2026-09-10T04:00:20.000Z', type: 'assistant', message: {
      role: 'assistant', content: [{ type: 'tool_use', id: 'report-tool', name: 'Skill', input: { skill: 'report' } }], stop_reason: 'tool_use' } },
    { uuid: 'skill-result', timestamp: '2026-09-10T04:00:30.000Z', type: 'user', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'report-tool', content: 'Done' }] } },
    reply('skill-final', '2026-09-10T04:01:00.000Z', 'SELECT 4;')]);
  const rawTables = ['hooks', 'hook_data_records', 'hook_executions', 'ai_skill_binding_history',
    'ai_skill_publish_events', 'ai_usage_skill_context'];
  const raw = () => Object.fromEntries(rawTables.map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const originals = raw();
  const report = () => f.db.prepare(`SELECT * FROM ai_usage_report_rows WHERE tenant_id=1
    AND dataset IN ('skill_publications','skill_invocations','hook_records','hook_daily','hook_executions')
    ORDER BY dataset,row_key`).all();
  const skillDetails = () => Object.fromEntries(['ai_dashboard_skill_publication_detail', 'ai_dashboard_skill_invocation_detail']
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=1 ORDER BY id`).all()]));
  assert.equal((await f.run()).published, 1);
  await assertAuditParity(f, 240, 4);
  const before = report();
  assert.equal(before.filter(row => row.dataset === 'skill_publications').length, 1);
  assert.equal(before.filter(row => row.dataset === 'skill_invocations').length, 1, 'slash and tool evidence describe one Skill invocation');
  assert.equal(before.filter(row => row.dataset === 'hook_records').length, 2);
  assert.equal(before.filter(row => row.dataset === 'hook_executions').length, 1);
  const hookDaily = before.filter(row => row.dataset === 'hook_daily');
  assert.equal(hookDaily.length, 1);
  assert.equal(JSON.parse(hookDaily[0].value_json).recordCount, 2);
  assert.ok(f.db.prepare('SELECT 1 FROM ai_usage_skill_groups WHERE tenant_id=1').get(), 'the fixture exercises materialized Skill groups');
  const beforeSkillDetails = skillDetails();
  assert.equal(beforeSkillDetails.ai_dashboard_skill_publication_detail.length, 1);
  assert.equal(beforeSkillDetails.ai_dashboard_skill_invocation_detail.length, 1);
  f.next();
  assert.equal((await f.run(fullConfig)).published, 1);
  await assertAuditParity(f, 240, 4);
  assert.deepEqual(report(), before, 'Skill invocations, publications, Hook records, daily totals and executions are rebuilt identically');
  assert.deepEqual(skillDetails(), beforeSkillDetails, 'both formal Skill detail tables keep the same published metrics');
  assert.deepEqual(raw(), originals, 'full mode does not alter Hook inputs, Skill publication history, bindings or captured context');
});
