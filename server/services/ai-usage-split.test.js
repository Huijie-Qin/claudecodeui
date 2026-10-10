import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SPLIT_DETAILS, LEGACY_SPLIT_DETAILS, V2_SPLIT_DETAILS, RETIRED_SPLIT_DETAILS, SPLIT_SCHEMA_VERSION, AI_DASHBOARD_SPLIT_PUBLIC_DDL, splitTableDdl } from '../database/ai-dashboard-split-schema.js';
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { fixture } from './ai-usage-test-fixture.js';
import { backfillSplitDetails, buildSplitCandidate, projectSplitRow, migrateSplitDetails, collectSplitRows, splitWriter } from './ai-dashboard-split.js';
import { buildIntegrationCandidate } from './ai-dashboard-integration.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { seedAiUsageSimulation, simulationNight } from './ai-usage-simulation-fixture.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const coverage = { activeUsers: 'complete', generatedSql: 'partial', hooks: 'complete', duration: 'complete', skillPublications: 'complete', skillInvocations: 'complete', codeSubmissions: 'complete' };
const clock = () => new Date('2026-09-13T18:10:00Z');
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY tenant_id,id`).all();
function parity(db, stagingBatch = null) {
  const wide = stagingBatch ? db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY tenant_id,id').all(stagingBatch) : rows(db, 'ai_dashboard_integration_detail');
  for (const row of wide) assert.equal(SPLIT_DETAILS.filter(definition => definition.match(row)).length, 1);
  const projected = collectSplitRows(wide);
  for (const definition of SPLIT_DETAILS) {
    const expected = [...projected.get(definition.key).values()].sort((a, b) => a.tenant_id - b.tenant_id || a.id.localeCompare(b.id));
    const actual = stagingBatch ? db.prepare(`SELECT ${definition.columns.join(',')} FROM ${definition.staging} WHERE batch_id=? ORDER BY tenant_id,id`).all(stagingBatch) : rows(db, definition.table);
    assert.deepEqual(actual, expected, definition.key);
  }
  // Independent metric invariants: the daily merge may reduce row count but
  // never changes duration, active population or session population.
  const ai = [...projected.get('ai').values()];
  assert.equal(ai.reduce((sum, row) => sum + Math.round((row.ai_active_duration_seconds ?? 0) * 1000), 0), wide.reduce((sum, row) => sum + (row.ai_active_duration_ms ?? 0), 0));
  const active = list => [...new Set(list.filter(row => row.has_ai_interaction === 1).map(row => JSON.stringify([row.tenant_id, row.stat_date, row.user_id, row.workspace_id, row.ai_session_id])))].sort();
  assert.deepEqual(active(ai), active(wide));
}
function seedFacts(f) {
  f.batch('batch-1', 10, 'published', coverage);
  f.row({ id: 'interaction', dataset: 'interactions' });
  f.row({ id: 'duration', dataset: 'turns', date: '2026-09-12', value: { status: 'completed', durationMs: 180000 } });
  f.row({ id: 'pub', dataset: 'skill_publications', subjectId: 'skill-a', value: { skillName: 'Skill A', publisherUserId: 3 } });
  f.row({ id: 'call', dataset: 'skill_invocations', subjectId: 'skill-a', value: { skillName: 'Skill A', publisherUserId: 3, callerUserId: 4 } });
  f.row({ id: 'sql', dataset: 'sql_generations', value: { generatedLines: 0 } });
  f.row({ id: 'sql-unknown', dataset: 'sql_generations', value: { generatedLines: null } });
  f.row({ id: 'code', dataset: 'code_submissions', value: { submittedLines: 50, repositoryUrl: 'repo', commitSha: 'sha' } });
}
function unchanged(db) {
  return {
    old: db.prepare('SELECT * FROM ai_usage_report_rows ORDER BY tenant_id,dataset,stat_date,row_key').all(),
    wide: rows(db, 'ai_dashboard_integration_detail'),
    batches: db.prepare('SELECT * FROM ai_usage_batches ORDER BY id').all(),
    tenants: db.prepare('SELECT * FROM ai_usage_tenant_state ORDER BY tenant_id').all(),
  };
}
async function prepared(f) {
  const store = createAiUsageStore(f.db, { clock });
  const batch = store.claim(10, { scheduledFor: '2026-09-13T18:00:00Z', targetThrough: '2026-09-13T16:00:00Z' }, config);
  const progress = { stage: 'integration' };
  store.initializeStaging(batch, progress, config);
  f.row({ id: 'new-session', dataset: 'interactions', sessionKey: 'second', batchId: batch.id });
  await buildIntegrationCandidate({ store, batch, progress, config, checkpoint: async () => {}, checkWindow: () => {} });
  progress.integration.ready = true; progress.stage = 'publish'; store.checkpoint(batch, progress, config);
  return { store, batch, progress };
}

function downgradeTables(db, definitions, version, candidateBatch = null) {
  db.exec('DROP TRIGGER IF EXISTS ai_dashboard_split_suppress_insert');
  for (const definition of SPLIT_DETAILS) db.exec(`DROP TABLE ${definition.table}; DROP TABLE ${definition.staging}`);
  const types = new Map(db.prepare('PRAGMA table_info(ai_dashboard_integration_detail)').all().map(column => [column.name, column.type]));
  for (const definition of definitions) {
    for (const staging of [false, true]) {
      const table = staging ? definition.staging : definition.table;
      const columns = staging ? ['batch_id', ...definition.columns] : definition.columns;
      db.exec(`CREATE TABLE ${table} (${columns.map(column => `${column} ${types.get(column) || 'TEXT'}${['batch_id', 'tenant_id', 'id', 'stat_date'].includes(column) ? ' NOT NULL' : ''}`).join(',')},
        PRIMARY KEY(${staging ? 'batch_id,' : ''}tenant_id,id))`);
      const write = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(column => `@${column}`).join(',')})`);
      const source = staging ? (candidateBatch ? db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=?').all(candidateBatch) : [])
        : rows(db, 'ai_dashboard_integration_detail');
      for (const row of source.filter(definition.match)) write.run(Object.fromEntries(columns.map(column => [column, row[column]])));
    }
  }
  db.exec(`CREATE TRIGGER ai_dashboard_split_suppress_insert AFTER INSERT ON ai_usage_suppressed_rows BEGIN
    DELETE FROM ${version === 1 ? 'ai_dashboard_sql_generation_detail' : 'ai_dashboard_code_detail'} WHERE tenant_id=NEW.tenant_id AND NEW.dataset='hook_records' AND sql_record_id=NEW.row_key;
    END; UPDATE ai_dashboard_split_state SET schema_version=${version};`);
}
const downgradeToSixTables = (db, candidateBatch = null) => downgradeTables(db, LEGACY_SPLIT_DETAILS, 1, candidateBatch);
const downgradeToThreeTables = (db, candidateBatch = null) => downgradeTables(db, V2_SPLIT_DETAILS, 2, candidateBatch);

function downgradeToMilliseconds(db) {
  const definition = SPLIT_DETAILS[0];
  for (const staging of [false, true]) {
    const table = staging ? definition.staging : definition.table;
    const saved = db.prepare(`SELECT * FROM ${table}`).all();
    db.exec(`DROP TABLE ${table}`);
    db.exec(splitTableDdl(definition, staging).replace('ai_active_duration_seconds REAL', 'ai_active_duration_ms INTEGER'));
    const columns = staging ? ['batch_id', ...V2_SPLIT_DETAILS[0].columns] : V2_SPLIT_DETAILS[0].columns;
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    for (const row of saved) insert.run(...columns.map(column => column === 'ai_active_duration_ms'
      ? row.ai_active_duration_seconds == null ? null : Math.round(row.ai_active_duration_seconds * 1000) : row[column]));
  }
  db.exec("UPDATE ai_dashboard_split_state SET schema_version=3; UPDATE ai_usage_batches SET progress_json=json_set(progress_json,'$.split.version',3) WHERE json_extract(progress_json,'$.split.version') IS NOT NULL");
}

test('documented DDL exactly matches the five runtime schemas', () => {
  const ddl = readFileSync(new URL('../../docs/ai-dashboard-split-detail.sql', import.meta.url), 'utf8');
  assert.equal(ddl.slice(ddl.indexOf('CREATE TABLE')).trim(), AI_DASHBOARD_SPLIT_PUBLIC_DDL.trim());
});

test('six-to-five schema migration preserves all facts and old metadata, retires verified tables and is idempotent', t => {
  const f = fixture(t); seedFacts(f); f.batch('empty', 20, 'published', coverage);
  const before = unchanged(f.db);
  downgradeToSixTables(f.db);
  migrateAiUsageSchema(f.db); parity(f.db);
  assert.deepEqual(unchanged(f.db), before);
  assert.ok(f.db.prepare('SELECT * FROM ai_dashboard_split_state').all().every(row => row.schema_version === SPLIT_SCHEMA_VERSION));
  for (const definition of RETIRED_SPLIT_DETAILS) for (const table of [definition.table, definition.staging]) {
    assert.equal(f.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table), undefined);
  }
  assert.deepEqual(f.db.transaction(() => migrateSplitDetails(f.db)).immediate(), []);
  parity(f.db); assert.deepEqual(unchanged(f.db), before);
  // The replaced trigger must target the new merged table, not a dropped table.
  f.db.exec("INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(10,'hook_records','sql')");
  parity(f.db);
  assert.equal(f.db.prepare("SELECT 1 FROM ai_dashboard_sql_generation_detail WHERE sql_record_id='sql'").get(), undefined);
  assert.equal(f.db.prepare('SELECT SUM(submitted_code_lines) AS n FROM ai_dashboard_code_submission_detail').get().n, 50);
});

test('six-to-five migration refuses live workers or unexpected legacy data/schema without discarding anything', t => {
  const f = fixture(t); seedFacts(f); downgradeToSixTables(f.db);
  const before = unchanged(f.db);
  f.db.exec("INSERT INTO ai_usage_worker_lock(id,lease_until) VALUES(1,'2999-01-01T00:00:00Z')");
  assert.throws(() => migrateSplitDetails(f.db), /WORKER_ACTIVE/);
  f.db.exec('DELETE FROM ai_usage_worker_lock');
  f.db.exec("UPDATE ai_dashboard_sql_generation_detail SET generated_sql_lines=9999 WHERE sql_record_id='sql'");
  assert.throws(() => migrateSplitDetails(f.db), /LEGACY_DATA_MISMATCH/);
  assert.equal(f.db.prepare("SELECT generated_sql_lines FROM ai_dashboard_sql_generation_detail WHERE sql_record_id='sql'").get().generated_sql_lines, 9999);
  assert.deepEqual(unchanged(f.db), before);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_dashboard_ai_detail'").get(), undefined);
  assert.equal(f.db.prepare('SELECT schema_version FROM ai_dashboard_split_state WHERE tenant_id=10').get().schema_version, 1);
  f.db.exec("UPDATE ai_dashboard_sql_generation_detail SET generated_sql_lines=0 WHERE sql_record_id='sql'; ALTER TABLE ai_dashboard_sql_generation_detail ADD COLUMN custom_note TEXT");
  assert.throws(() => migrateSplitDetails(f.db), /LEGACY_SCHEMA_CHANGED/);
  assert.deepEqual(unchanged(f.db), before);
});

test('failure while retiring the six tables rolls back schema, data, trigger and ready marker together', t => {
  const f = fixture(t); seedFacts(f); downgradeToSixTables(f.db);
  const before = unchanged(f.db);
  const exec = f.db.exec.bind(f.db);
  f.db.exec = sql => {
    if (sql === 'DROP TABLE ai_dashboard_duration_detail') throw new Error('retire failed');
    return exec(sql);
  };
  assert.throws(() => migrateSplitDetails(f.db), /retire failed/);
  f.db.exec = exec;
  assert.deepEqual(unchanged(f.db), before);
  for (const definition of LEGACY_SPLIT_DETAILS) for (const table of [definition.table, definition.staging]) {
    assert.ok(f.db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table));
  }
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_dashboard_ai_detail'").get(), undefined);
  assert.equal(f.db.prepare('SELECT schema_version FROM ai_dashboard_split_state WHERE tenant_id=10').get().schema_version, 1);
  assert.match(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='ai_dashboard_split_suppress_insert'").get().sql, /ai_dashboard_sql_generation_detail/);
  migrateSplitDetails(f.db); parity(f.db);
});

test('prepared v1 six-table candidates migrate without rescanning sources or reusing an obsolete ready marker', async t => {
  const f = fixture(t); seedFacts(f); f.db.exec("UPDATE tenants SET status='inactive' WHERE id=20");
  const { store, batch, progress } = await prepared(f);
  progress.split = { version: 1, ready: true, cursor: 'zzzz-obsolete' };
  store.checkpoint(batch, progress, config); store.finish(batch, 'paused');
  f.db.prepare('UPDATE ai_usage_tenant_state SET time_zone=?,calculation_version=? WHERE tenant_id=10').run(config.timeZone, config.calculationVersion);
  downgradeToSixTables(f.db, batch.id);
  const before = unchanged(f.db);
  const candidate = f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id);
  migrateSplitDetails(f.db); parity(f.db);
  assert.deepEqual(unchanged(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id), candidate);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_ai_staging').get().n, 0);
  const result = await runAiUsageWindow({ database: f.db, config, now: clock });
  assert.equal(result.published, 1, JSON.stringify(result)); parity(f.db);
  const saved = JSON.parse(f.db.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=?').get(batch.id).progress_json);
  assert.equal(saved.split.version, SPLIT_SCHEMA_VERSION); assert.equal(saved.split.ready, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_ai_detail WHERE tenant_id=10 AND has_ai_interaction=1').get().n, 2);
});

test('five topic tables preserve IDs, Shanghai values, NULL/zero and distinct behavior/actor roles', t => {
  const f = fixture(t); seedFacts(f); parity(f.db);
  assert.equal(SPLIT_DETAILS.length, 5);
  for (const definition of SPLIT_DETAILS) {
    const columns = f.db.prepare(`PRAGMA table_info(${definition.table})`).all().map(column => column.name);
    assert.deepEqual(columns, definition.columns);
    for (const excluded of ['dataset', 'event_type', 'partition_id', 'batch_id', 'refreshed_at']) assert.ok(!columns.includes(excluded));
  }
  const invocation = f.db.prepare('SELECT * FROM ai_dashboard_skill_invocation_detail').get();
  assert.deepEqual([invocation.user_id, invocation.user_name, invocation.publisher_user_id, invocation.publisher_user_name], [4, 'another-member', 3, 'member']);
  assert.equal(f.db.prepare('SELECT * FROM ai_dashboard_skill_publication_detail').get().publisher_user_id, 3);
  assert.equal(f.db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM ai_dashboard_ai_detail WHERE stat_date='2026-09-12' AND has_ai_interaction=1").get().n, 0);
  assert.equal(f.db.prepare("SELECT SUM(ai_active_duration_seconds) AS n FROM ai_dashboard_ai_detail WHERE stat_date='2026-09-12'").get().n, 180);
  assert.deepEqual(f.db.prepare('SELECT sql_record_id,generated_sql_lines FROM ai_dashboard_sql_generation_detail WHERE sql_record_id IS NOT NULL ORDER BY sql_record_id').all(), [
    { sql_record_id: 'sql', generated_sql_lines: 0 }, { sql_record_id: 'sql-unknown', generated_sql_lines: null },
  ]);
  assert.throws(() => projectSplitRow({ has_ai_interaction: 1, skill_publish_count: 1 }), /AMBIGUOUS/);
  assert.throws(() => projectSplitRow({ has_ai_interaction: 1, ai_active_duration_ms: 1 }), /AMBIGUOUS/);
  assert.throws(() => projectSplitRow({ skill_publish_count: 1, skill_call_count: 1 }), /AMBIGUOUS/);
  assert.throws(() => projectSplitRow({ sql_record_id: 'sql', code_submission_id: 'mr' }), /AMBIGUOUS/);
  assert.throws(() => projectSplitRow({}), /AMBIGUOUS/);
});

test('AI merges by tenant/user/workspace/session/day, preserves NULL/zero and never makes a cross-day slice active', t => {
  const f = fixture(t); seedFacts(f);
  f.row({ id: 'same-day-turn', dataset: 'turns', value: { status: 'completed', durationMs: 20 } });
  f.row({ id: 'another-turn', dataset: 'turns', value: { status: 'completed', durationMs: 30 } });
  f.row({ id: 'other-template', dataset: 'interactions', value: { templateId: 'other-template' } });
  f.row({ id: 'zero', dataset: 'turns', sessionKey: 'zero-session', value: { status: 'completed', durationMs: 0 } });
  f.row({ id: 'unknown', dataset: 'interactions', sessionKey: 'unknown-session' });
  f.row({ id: 'pending', dataset: 'turns', sessionKey: 'unknown-session', value: { status: 'pending', durationMs: null } });
  f.row({ id: 'other-user', dataset: 'interactions', userId: 4 });
  f.row({ id: 'other-workspace', dataset: 'interactions', workspaceId: 8 });
  parity(f.db);
  const first = f.db.prepare("SELECT * FROM ai_dashboard_ai_detail WHERE stat_date='2026-09-11' AND ai_active_duration_seconds=0.05").get();
  assert.equal(first.has_ai_interaction, 1);
  assert.equal(first.occurred_at, '2026-09-11 18:00:00');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_ai_detail').get().n, 6);
  assert.deepEqual(f.db.prepare("SELECT has_ai_interaction,ai_active_duration_seconds FROM ai_dashboard_ai_detail WHERE stat_date='2026-09-12'").get(),
    { has_ai_interaction: 0, ai_active_duration_seconds: 180 });
  assert.equal(f.db.prepare('SELECT has_ai_interaction FROM ai_dashboard_ai_detail WHERE ai_active_duration_seconds=0').get().has_ai_interaction, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_ai_detail WHERE ai_active_duration_seconds IS NULL').get().n, 3);
  const countBefore = rows(f.db, 'ai_dashboard_ai_detail').length;
  f.row({ id: 'late-completion', dataset: 'turns', sessionKey: 'unknown-session', value: { status: 'completed', durationMs: 10 } });
  f.row({ id: 'late-duration', dataset: 'turns', value: { status: 'completed', durationMs: 5 } });
  assert.equal(rows(f.db, 'ai_dashboard_ai_detail').length, countBefore);
  assert.equal(f.db.prepare('SELECT id FROM ai_dashboard_ai_detail WHERE ai_active_duration_seconds=0.055').get().id, first.id);
  parity(f.db);
  // A continuation may have started on the previous day. If today's user
  // actually interacts, occurred_at must describe that interaction, not yesterday.
  const write = splitWriter(f.db);
  const common = { tenant_id: 99, stat_date: '2026-09-12', user_id: null, workspace_id: null, ai_session_id: 'cross-day' };
  write({ ...common, id: 'duration', occurred_at: '2026-09-11 23:59:00', ai_active_duration_ms: 60000 });
  write({ ...common, id: 'interaction', occurred_at: '2026-09-12 10:00:00', has_ai_interaction: 1 });
  assert.deepEqual(f.db.prepare('SELECT occurred_at,has_ai_interaction,ai_active_duration_seconds FROM ai_dashboard_ai_detail WHERE tenant_id=99').get(),
    { occurred_at: '2026-09-12 10:00:00', has_ai_interaction: 1, ai_active_duration_seconds: 60 });
  assert.throws(() => projectSplitRow({ ...common, ai_active_duration_ms: -1 }), /INVALID_DURATION/);
  assert.throws(() => projectSplitRow({ ...common, ai_active_duration_ms: 1.5 }), /INVALID_DURATION/);
  write({ ...common, ai_session_id: 'overflow', ai_active_duration_ms: Number.MAX_SAFE_INTEGER - 1 });
  assert.throws(() => write({ ...common, ai_session_id: 'overflow', ai_active_duration_ms: 2 }), /OVERFLOW/);
  for (const ms of [100, 200, 1]) write({ ...common, ai_session_id: 'fraction', ai_active_duration_ms: ms });
  assert.equal(f.db.prepare("SELECT ai_active_duration_seconds FROM ai_dashboard_ai_detail WHERE ai_session_id='fraction'").get().ai_active_duration_seconds, 0.301);
});

test('three-to-five migration validates old AI IDs before merging, preserves canonical facts and replaces old tables', t => {
  const f = fixture(t); seedFacts(f);
  f.row({ id: 'same-day-turn', dataset: 'turns', value: { status: 'completed', durationMs: 50 } });
  downgradeToThreeTables(f.db);
  const before = unchanged(f.db);
  assert.equal(rows(f.db, 'ai_dashboard_ai_detail').length, 3);
  const retired = migrateSplitDetails(f.db);
  assert.deepEqual(retired.sort(), ['ai_dashboard_skill_detail', 'ai_dashboard_skill_staging', 'ai_dashboard_code_detail', 'ai_dashboard_code_staging'].sort());
  assert.equal(rows(f.db, 'ai_dashboard_ai_detail').length, 2);
  assert.deepEqual(unchanged(f.db), before); parity(f.db);
  assert.deepEqual(migrateSplitDetails(f.db), []); parity(f.db);
});

test('three-to-five upgrade rejects unexpected edits and atomically rolls back failed AI aggregation', t => {
  const f = fixture(t); seedFacts(f); downgradeToThreeTables(f.db);
  const before = unchanged(f.db); const aiBefore = rows(f.db, 'ai_dashboard_ai_detail');
  f.db.exec('UPDATE ai_dashboard_ai_detail SET ai_active_duration_ms=123 WHERE has_ai_interaction=1');
  assert.throws(() => migrateSplitDetails(f.db), /LEGACY_DATA_MISMATCH/);
  assert.deepEqual(unchanged(f.db), before);
  assert.equal(f.db.prepare('SELECT schema_version FROM ai_dashboard_split_state').get().schema_version, 2);
  f.db.exec('UPDATE ai_dashboard_ai_detail SET ai_active_duration_ms=NULL WHERE has_ai_interaction=1');
  const exec = f.db.exec.bind(f.db);
  f.db.exec = sql => { if (sql === 'ALTER TABLE ai_dashboard_ai_detail_seconds_migration RENAME TO ai_dashboard_ai_detail') throw new Error('aggregate failed'); return exec(sql); };
  assert.throws(() => migrateSplitDetails(f.db), /aggregate failed/);
  assert.deepEqual(rows(f.db, 'ai_dashboard_ai_detail'), aiBefore);
  assert.deepEqual(unchanged(f.db), before);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_dashboard_skill_detail'").get());
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_dashboard_skill_publication_detail'").get(), undefined);
  f.db.exec = exec; migrateSplitDetails(f.db); parity(f.db);
});

test('paused v2 candidates rebuild five-table output without replaying AI duration across cursor boundaries', async t => {
  const f = fixture(t); seedFacts(f); f.db.exec("UPDATE tenants SET status='inactive' WHERE id=20");
  const { store, batch, progress } = await prepared(f);
  progress.split = { version: 2, ready: true, cursor: 'zzzz' };
  store.checkpoint(batch, progress, config); store.finish(batch, 'paused');
  f.db.prepare('UPDATE ai_usage_tenant_state SET time_zone=?,calculation_version=? WHERE tenant_id=10').run(config.timeZone, config.calculationVersion);
  downgradeToThreeTables(f.db, batch.id);
  const candidate = f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id);
  migrateSplitDetails(f.db); parity(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id), candidate);
  const result = await runAiUsageWindow({ database: f.db, config: { ...config, batchSize: 1 }, now: clock });
  assert.equal(result.published, 1, JSON.stringify(result)); parity(f.db);
  const aiBefore = rows(f.db, 'ai_dashboard_ai_detail');
  migrateSplitDetails(f.db);
  assert.deepEqual(rows(f.db, 'ai_dashboard_ai_detail'), aiBefore);
});

test('v3 milliseconds migrate to REAL fractional seconds without changing AI IDs, nulls, counts or other data', t => {
  const f = fixture(t); seedFacts(f);
  f.row({ id: 'fraction', dataset: 'turns', value: { status: 'completed', durationMs: 1267 } });
  f.row({ id: 'zero', dataset: 'turns', sessionKey: 'zero', value: { status: 'completed', durationMs: 0 } });
  f.row({ id: 'unknown', dataset: 'interactions', sessionKey: 'unknown' });
  const expected = rows(f.db, 'ai_dashboard_ai_detail');
  const before = unchanged(f.db);
  const others = SPLIT_DETAILS.slice(1).map(definition => rows(f.db, definition.table));
  downgradeToMilliseconds(f.db); migrateSplitDetails(f.db); parity(f.db);
  assert.deepEqual(rows(f.db, 'ai_dashboard_ai_detail'), expected);
  assert.deepEqual(unchanged(f.db), before);
  assert.deepEqual(SPLIT_DETAILS.slice(1).map(definition => rows(f.db, definition.table)), others);
  for (const table of ['ai_dashboard_ai_detail', 'ai_dashboard_ai_staging']) {
    const columns = f.db.prepare(`PRAGMA table_info(${table})`).all();
    assert.ok(!columns.some(column => column.name === 'ai_active_duration_ms'));
    assert.equal(columns.find(column => column.name === 'ai_active_duration_seconds').type, 'REAL');
  }
  migrateSplitDetails(f.db); assert.deepEqual(rows(f.db, 'ai_dashboard_ai_detail'), expected);
});

test('v3 unit migration rejects edited aggregates and custom indexes; failed table replacement rolls back', t => {
  const f = fixture(t); seedFacts(f); downgradeToMilliseconds(f.db);
  const original = rows(f.db, 'ai_dashboard_ai_detail'); const before = unchanged(f.db);
  f.db.exec('UPDATE ai_dashboard_ai_detail SET ai_active_duration_ms=123 WHERE ai_active_duration_ms IS NOT NULL');
  assert.throws(() => migrateSplitDetails(f.db), /LEGACY_DATA_MISMATCH/);
  f.db.exec('UPDATE ai_dashboard_ai_detail SET ai_active_duration_ms=180000 WHERE ai_active_duration_ms IS NOT NULL');
  f.db.exec('CREATE INDEX user_custom_index ON ai_dashboard_ai_detail(user_id)');
  assert.throws(() => migrateSplitDetails(f.db), /custom dependency/);
  f.db.exec('DROP INDEX user_custom_index');
  const exec = f.db.exec.bind(f.db);
  f.db.exec = sql => { if (sql === 'ALTER TABLE ai_dashboard_ai_staging_seconds_migration RENAME TO ai_dashboard_ai_staging') throw new Error('unit migration failed'); return exec(sql); };
  assert.throws(() => migrateSplitDetails(f.db), /unit migration failed/); f.db.exec = exec;
  assert.deepEqual(rows(f.db, 'ai_dashboard_ai_detail'), original);
  assert.deepEqual(unchanged(f.db), before);
  assert.equal(f.db.prepare('SELECT schema_version FROM ai_dashboard_split_state').get().schema_version, 3);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE '%seconds_migration'").get(), undefined);
  migrateSplitDetails(f.db); parity(f.db);
});

test('partially accumulated v3 candidates are verified by their cursor, then rebuilt in seconds without duplicate duration', async t => {
  const f = fixture(t); seedFacts(f); f.db.exec("UPDATE tenants SET status='inactive' WHERE id=20");
  f.row({ id: 'fraction', dataset: 'turns', value: { status: 'completed', durationMs: 1267 } });
  const {store, batch, progress} = await prepared(f);
  let pages = 0;
  await assert.rejects(buildSplitCandidate({store, batch, progress, config:{...config,batchSize:1},
    checkpoint:async () => {}, checkWindow:() => { if(++pages === 4) throw new Error('window end'); }}), /window end/);
  store.finish(batch, 'paused');
  f.db.prepare('UPDATE ai_usage_tenant_state SET time_zone=?,calculation_version=? WHERE tenant_id=10').run(config.timeZone, config.calculationVersion);
  const wide = f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id);
  const partial = f.db.prepare('SELECT * FROM ai_dashboard_ai_staging WHERE batch_id=? ORDER BY id').all(batch.id);
  assert.ok(partial.length);
  downgradeToMilliseconds(f.db); migrateSplitDetails(f.db); parity(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_ai_staging WHERE batch_id=? ORDER BY id').all(batch.id), partial);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? ORDER BY id').all(batch.id), wide);
  const result = await runAiUsageWindow({database:f.db,config:{...config,batchSize:1},now:clock});
  assert.equal(result.published,1,JSON.stringify(result)); parity(f.db);
});

test('backfill is idempotent, preserves results/status and makes the five-table dashboard ready, including empty tenants', t => {
  const f = fixture(t); seedFacts(f); f.batch('empty-tenant', 20, 'published', coverage);
  const before = unchanged(f.db); const summary = f.queryService.summary(f.access);
  f.db.exec('DELETE FROM ai_dashboard_split_state');
  for (const definition of SPLIT_DETAILS) f.db.exec(`DELETE FROM ${definition.table}`);
  // No silent wide/old-report fallback while the selected source is unready.
  assert.throws(() => f.queryService.summary(f.access), { code: 'splitNotReady' });
  assert.throws(() => f.queryService.code(f.access), { code: 'splitNotReady' });
  f.db.transaction(() => backfillSplitDetails(f.db)).immediate(); parity(f.db);
  assert.deepEqual(f.queryService.summary(f.access), summary);
  assert.equal(f.queryService.code(f.access).summary.submittedLines, 50);
  assert.deepEqual(unchanged(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_split_state ORDER BY tenant_id').all(), [
    { tenant_id: 10, batch_id: 'batch-1', schema_version: SPLIT_SCHEMA_VERSION }, { tenant_id: 20, batch_id: 'empty-tenant', schema_version: SPLIT_SCHEMA_VERSION },
  ]);
  f.db.exec("CREATE TRIGGER prevent_rebuild BEFORE DELETE ON ai_dashboard_ai_detail BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END");
  f.db.transaction(() => backfillSplitDetails(f.db)).immediate();
  f.db.exec('DROP TRIGGER prevent_rebuild');
  f.db.exec("DELETE FROM ai_dashboard_split_state; INSERT INTO ai_usage_worker_lock(id,lease_until) VALUES(1,'2999-01-01T00:00:00Z')");
  assert.throws(() => f.db.transaction(() => backfillSplitDetails(f.db)).immediate(), /WORKER_ACTIVE/);
  f.db.exec('DELETE FROM ai_usage_worker_lock');
});

test('failed additive backfill rolls back every split table without touching the existing results', t => {
  const f = fixture(t); seedFacts(f);
  f.db.exec('DELETE FROM ai_dashboard_split_state');
  for (const definition of SPLIT_DETAILS) f.db.exec(`DELETE FROM ${definition.table}`);
  const before = unchanged(f.db);
  f.db.exec("CREATE TRIGGER backfill_failure BEFORE INSERT ON ai_dashboard_code_submission_detail BEGIN SELECT RAISE(ABORT,'backfill failed'); END");
  assert.throws(() => f.db.transaction(() => backfillSplitDetails(f.db)).immediate(), /backfill failed/);
  assert.deepEqual(unchanged(f.db), before);
  for (const definition of SPLIT_DETAILS) assert.equal(rows(f.db, definition.table).length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_split_state').get().n, 0);
  f.db.exec('DROP TRIGGER backfill_failure');
  f.db.transaction(() => backfillSplitDetails(f.db)).immediate(); parity(f.db);
});

test('an old ready-to-publish batch builds the additive split candidate when resumed', async t => {
  const f = fixture(t); seedFacts(f);
  f.db.exec("UPDATE tenants SET status='inactive' WHERE id=20");
  const { store, batch, progress } = await prepared(f);
  assert.equal(progress.stage, 'publish'); assert.equal(progress.split, undefined);
  f.db.prepare('UPDATE ai_usage_tenant_state SET time_zone=?,calculation_version=? WHERE tenant_id=10')
    .run(config.timeZone, config.calculationVersion);
  const candidate = f.db.prepare('SELECT * FROM ai_usage_report_staging WHERE batch_id=? ORDER BY dataset,stat_date,row_key').all(batch.id);
  store.finish(batch, 'paused', 'upgrade boundary');
  const result = await runAiUsageWindow({ database: f.db, config, now: clock });
  assert.equal(result.published, 1, JSON.stringify(result)); parity(f.db);
  const published = f.db.prepare('SELECT * FROM ai_usage_report_rows WHERE tenant_id=10 ORDER BY dataset,stat_date,row_key').all();
  assert.deepEqual(published, candidate.map(({ batch_id, ...row }) => row));
  const saved = JSON.parse(f.db.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=?').get(batch.id).progress_json);
  assert.equal(saved.split.version, SPLIT_SCHEMA_VERSION); assert.equal(saved.split.ready, true);
  assert.equal(f.db.prepare('SELECT batch_id FROM ai_dashboard_split_state WHERE tenant_id=10').get().batch_id, batch.id);
});

test('split staging resumes by persisted cursor; failure in the last table rolls back all seven formal tables and status', async t => {
  const f = fixture(t); seedFacts(f);
  f.row({ id: 'same-day-turn', dataset: 'turns', value: { status: 'completed', durationMs: 50 } });
  f.row({ id: 'same-day-turn-2', dataset: 'turns', value: { status: 'completed', durationMs: 20 } });
  f.batch('foreign', 20, 'published', coverage);
  f.row({ id: 'foreign', dataset: 'interactions', tenantId: 20, batchId: 'foreign' });
  const { store, batch, progress } = await prepared(f);
  assert.throws(() => store.publish(batch, coverage), /AI_SPLIT_NOT_READY/);
  const prior = unchanged(f.db);
  const splitBefore = SPLIT_DETAILS.map(definition => rows(f.db, definition.table));
  const stateBefore = f.db.prepare('SELECT * FROM ai_dashboard_split_state ORDER BY tenant_id').all();
  let checks = 0;
  await assert.rejects(buildSplitCandidate({ store, batch, progress, config: { ...config, batchSize: 2 }, checkpoint: async () => {},
    checkWindow: () => { if (++checks === 2) throw new Error('window end'); } }), /window end/);
  assert.deepEqual(unchanged(f.db), { ...prior, batches: f.db.prepare('SELECT * FROM ai_usage_batches ORDER BY id').all() });
  const resumed = JSON.parse(f.db.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=?').get(batch.id).progress_json);
  assert.ok(resumed.split.cursor); assert.ok(!resumed.split.ready);
  await buildSplitCandidate({ store, batch, progress: resumed, config: { ...config, batchSize: 2 }, checkpoint: async () => {}, checkWindow: () => {} });
  parity(f.db, batch.id);
  await buildSplitCandidate({ store, batch, progress: resumed, config, checkpoint: async () => {}, checkWindow: () => {} });
  parity(f.db, batch.id);
  resumed.stage = 'publish'; store.checkpoint(batch, resumed, config);
  const readySnapshot = unchanged(f.db);
  f.db.exec("CREATE TRIGGER split_failure BEFORE INSERT ON ai_dashboard_code_submission_detail BEGIN SELECT RAISE(ABORT,'last split failed'); END");
  assert.throws(() => store.publish(batch, coverage), /last split failed/);
  assert.deepEqual(unchanged(f.db), readySnapshot);
  assert.deepEqual(SPLIT_DETAILS.map(definition => rows(f.db, definition.table)), splitBefore);
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_dashboard_split_state ORDER BY tenant_id').all(), stateBefore);
  parity(f.db, batch.id);
  f.db.exec('DROP TRIGGER split_failure'); store.publish(batch, coverage); parity(f.db);
  for (const definition of SPLIT_DETAILS) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${definition.staging}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT batch_id FROM ai_dashboard_split_state WHERE tenant_id=10').get().batch_id, batch.id);
  assert.equal(f.db.prepare('SELECT batch_id FROM ai_dashboard_split_state WHERE tenant_id=20').get().batch_id, 'foreign');
});

test('privacy suppression removes matching formal and prepared split facts before publication', async t => {
  const f = fixture(t); seedFacts(f);
  const { store, batch, progress } = await prepared(f);
  await buildSplitCandidate({ store, batch, progress, config, checkpoint: async () => {}, checkWindow: () => {} });
  f.db.exec(`INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(10,'hook_records','sql');
    INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(10,'skill_publications','pub');
    INSERT INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(10,'code_submissions','code');`);
  parity(f.db); parity(f.db, batch.id);
  progress.stage = 'publish'; store.checkpoint(batch, progress, config);
  store.publish(batch, coverage); parity(f.db);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_skill_publication_detail').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_skill_invocation_detail').get().n, 1, 'suppressing publication must not remove calls');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_code_submission_detail WHERE code_submission_id IS NOT NULL').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_sql_generation_detail WHERE sql_record_id IS NOT NULL').get().n, 1);
});

test('real fixture nightly runs publish all five topics, merged additions corrections and deletes consistently', async t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedAiUsageSimulation(db);
  db.exec(`CREATE TABLE ai_mr_submissions(id INTEGER PRIMARY KEY,tenant_id,user_id,workspace_id,repository_url,commit_sha,additions,status,merged_at,created_at);
    INSERT INTO ai_mr_submissions VALUES(1,10,100,10,'repo','same',50,'merged','2026-09-11T16:01:00Z','2026-09-01'),
      (2,10,101,11,'repo','same',40,'merged','2026-09-12T01:00:00Z','2026-09-01'),
      (3,10,100,10,'repo','pending',9999,'opened',NULL,'2026-09-01');`);
  migrateAiUsageSchema(db);
  assert.equal((await runAiUsageWindow({ database: db, config, now: simulationNight })).published, 1); parity(db);
  const sums = () => ({
    sql: db.prepare('SELECT SUM(generated_sql_lines) AS n FROM ai_dashboard_sql_generation_detail').get().n,
    code: db.prepare('SELECT SUM(submitted_code_lines) AS n FROM ai_dashboard_code_submission_detail').get().n,
    publications: db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_skill_publication_detail').get().n,
    calls: db.prepare('SELECT COUNT(*) AS n FROM ai_dashboard_skill_invocation_detail').get().n,
  });
  assert.deepEqual(sums(), { sql: 3300, code: 90, publications: 30, calls: 600 });
  // Exercise six-to-five verification/backfill across multiple 500-row pages.
  const beforeMigration = unchanged(db);
  downgradeToSixTables(db); migrateSplitDetails(db); parity(db);
  assert.deepEqual(unchanged(db), beforeMigration);
  assert.deepEqual(sums(), { sql: 3300, code: 90, publications: 30, calls: 600 });
  downgradeToThreeTables(db); migrateSplitDetails(db); parity(db);
  assert.deepEqual(unchanged(db), beforeMigration);
  assert.deepEqual(sums(), { sql: 3300, code: 90, publications: 30, calls: 600 });
  db.exec('UPDATE ai_mr_submissions SET additions=40 WHERE id=1; DELETE FROM ai_mr_submissions WHERE id=2');
  assert.equal(sums().code, 90, 'ordinary corrections wait for nightly publication');
  const next = await runAiUsageWindow({ database: db, config, now: clock });
  assert.equal(next.published, 1, JSON.stringify(next)); parity(db);
  assert.equal(sums().code, 40);
  assert.equal((await runAiUsageWindow({ database: db, config, now: clock })).published, 0);
  parity(db);
});
