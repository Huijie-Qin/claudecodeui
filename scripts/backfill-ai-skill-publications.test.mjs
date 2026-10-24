import assert from 'node:assert/strict';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../server/database/ai-usage-schema.js';
import { runAiUsageWindow } from '../server/services/ai-usage-batches.js';
import { readAiUsageConfig } from '../server/services/ai-usage-config.js';
import { createAiUsageQueryService } from '../server/services/ai-usage-query.js';

import { backfillSkillPublications, historicalPublicationIdentity, normalizePublicationTime, parsePublicationInput } from './backfill-ai-skill-publications.mjs';

const now = '2026-10-23T08:00:00.000Z';
const record = (extra = {}) => ({ tenantId: 1, userId: 11, skillName: 'sql-review', firstPublishedAt: '2026-08-01 12:34:56', ...extra });

function fixture(t, databasePath = ':memory:') {
  const db = new Database(databasePath);
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER,status TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,user_id INTEGER,display_name TEXT,status TEXT);
    INSERT INTO tenants VALUES(1),(2);
    INSERT INTO users VALUES(11,'alice'),(12,'bob'),(13,'former');
    INSERT INTO tenant_users VALUES(1,11,'active'),(1,12,'disabled'),(2,12,'active');`);
  migrateAiUsageSchema(db);
  return db;
}

const publications = db => db.prepare('SELECT * FROM ai_skill_publications ORDER BY operation_id').all();
const queued = db => db.prepare('SELECT * FROM ai_usage_source_changes ORDER BY source_key').all();
function existing(db, { id = 'native', skillId = 'remote-1', userId = 11, name = 'sql-review', at = '2026-09-01T00:00:00.000Z' } = {}) {
  db.prepare(`INSERT INTO ai_skill_publications VALUES(?,1,?,?,?,?, 'confirmed',?,?)`).run(id, userId, skillId, name, at, now, now);
}

test('dry run resolves username and synthetic identity without writing any table; apply is idempotent and enqueues source', t => {
  const db = fixture(t);
  const rows = [record({ userId: undefined, username: 'alice', skillName: ' sql-review ' })];
  const preview = backfillSkillPublications(db, rows, { now });
  assert.equal(preview.mode, 'dry_run');
  assert.equal(preview.inserted, 1);
  assert.equal(preview.rows[0].firstPublishedAt, '2026-08-01T04:34:56.000Z');
  assert.equal(preview.rows[0].skillId, historicalPublicationIdentity(1, 11, 'sql-review').historicalSkillId);
  assert.deepEqual(publications(db), []);
  assert.deepEqual(queued(db), []);
  const applied = backfillSkillPublications(db, rows, { now, apply: true });
  assert.equal(applied.inserted, 1);
  assert.equal(publications(db)[0].status, 'confirmed');
  assert.equal(queued(db)[0].source_type, 'publication');
  const before = publications(db);
  const beforeQueue = queued(db);
  const repeat = backfillSkillPublications(db, rows, { now: '2026-10-24T00:00:00.000Z', apply: true });
  assert.equal(repeat.unchanged, 1);
  assert.deepEqual(publications(db), before);
  assert.deepEqual(queued(db), beforeQueue, 'no duplicate dirty generation on idempotent import');
});

test('validates entire input before writes and rolls back actual write failure atomically', t => {
  const db = fixture(t);
  assert.throws(() => backfillSkillPublications(db, [record(), record({ userId: 13 })], { now, apply: true }), { code: 'USER_NOT_IN_TENANT' });
  assert.equal(publications(db).length, 0);
  assert.equal(queued(db).length, 0);
  db.exec(`CREATE TRIGGER test_fail BEFORE INSERT ON ai_skill_publications WHEN NEW.skill_name='fail' BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
  assert.throws(() => backfillSkillPublications(db, [record(), record({ skillName: 'fail' })], { now, apply: true }), /injected failure/);
  assert.equal(publications(db).length, 0);
  assert.equal(queued(db).length, 0);
});

test('reuses a unique confirmed remote identity and preserves the system source record', t => {
  const db = fixture(t);
  existing(db);
  const original = publications(db)[0];
  const result = backfillSkillPublications(db, [record()], { now, apply: true });
  assert.equal(result.rows[0].skillId, 'remote-1');
  assert.equal(result.rows[0].identitySource, 'confirmed_publication');
  assert.equal(publications(db).length, 2);
  assert.deepEqual(db.prepare("SELECT * FROM ai_skill_publications WHERE operation_id='native'").get(), original);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ai_dashboard_integration_detail').get().n, 0);
});

test('only explicit update mode corrects script-owned records and never rewrites native sources', t => {
  const db = fixture(t);
  existing(db);
  const original = db.prepare("SELECT * FROM ai_skill_publications WHERE operation_id='native'").get();
  backfillSkillPublications(db, [record()], { now, apply: true });
  const revised = record({ firstPublishedAt: '2026-07-01 12:34:56' });
  assert.throws(() => backfillSkillPublications(db, [revised], { now, apply: true }), { code: 'EXISTING_BACKFILL_CONFLICT' });
  const result = backfillSkillPublications(db, [revised], { now, apply: true, updateExisting: true });
  assert.equal(result.updated, 1);
  assert.deepEqual(db.prepare("SELECT * FROM ai_skill_publications WHERE operation_id='native'").get(), original);
  assert.equal(publications(db).length, 2);
});

test('same exact name owned by two publishers gets separate historical IDs without inventing a market identity', t => {
  const db = fixture(t);
  const result = backfillSkillPublications(db, [record(), record({ userId: 12 })], { now, apply: true });
  assert.equal(result.inserted, 2);
  assert.notEqual(result.rows[0].skillId, result.rows[1].skillId);
  assert.ok(result.rows.every(row => row.skillId.startsWith('historical:')));
  assert.ok(result.rows.every(row => row.operationId.startsWith('historical-skill-publication:')));
});

test('rejects identity collisions across publishers, including within one input and confirmed binding evidence', t => {
  const db = fixture(t);
  existing(db, { userId: 12 });
  assert.throws(() => backfillSkillPublications(db, [record({ skillId: 'remote-1' })], { now, apply: true }), { code: 'SKILL_PUBLISHER_CONFLICT' });
  assert.throws(() => backfillSkillPublications(db, [record({ skillId: 'x' }), record({ userId: 12, skillId: 'x' })], { now, apply: true }), { code: 'SKILL_PUBLISHER_CONFLICT' });
  db.prepare(`INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from)
    VALUES(1,1,'sql-review','bound',12,?)`).run(now);
  assert.throws(() => backfillSkillPublications(db, [record({ skillId: 'bound' })], { now, apply: true }), { code: 'SKILL_PUBLISHER_CONFLICT' });
  assert.equal(publications(db).length, 1);
});

test('tenant and user checks reject cross-tenant IDs, mismatched usernames, missing and ambiguous members', t => {
  const db = fixture(t);
  for (const [row, code] of [
    [record({ tenantId: 0 }), 'INVALID_ID'], [record({ tenantId: 2 }), 'USER_NOT_IN_TENANT'], [record({ tenantId: 3 }), 'TENANT_NOT_FOUND'],
    [record({ username: 'bob' }), 'USER_MISMATCH'], [record({ userId: 99 }), 'USER_NOT_FOUND'],
    [record({ userId: undefined, username: 'unknown' }), 'USER_NOT_UNIQUE'],
  ]) assert.throws(() => backfillSkillPublications(db, [row], { now }), { code });
  assert.throws(() => backfillSkillPublications(db, [record()], { now, tenantId: 2 }), { code: 'TENANT_MISMATCH' });
  db.exec("INSERT INTO users VALUES(14,'alice'); INSERT INTO tenant_users VALUES(1,14,'active');");
  assert.throws(() => backfillSkillPublications(db, [record({ userId: undefined, username: 'alice' })], { now }), { code: 'USER_NOT_UNIQUE' });
});

test('deduplicates identical input but rejects conflicting duplicates before any write', t => {
  const db = fixture(t);
  assert.throws(() => backfillSkillPublications(db, [record(), record({ firstPublishedAt: '2026-07-01 00:00:00' })], { now, apply: true }), { code: 'DUPLICATE_INPUT_CONFLICT' });
  assert.equal(publications(db).length, 0);
  const result = backfillSkillPublications(db, [record(), record()], { now, apply: true });
  assert.equal(result.inserted, 1);
  assert.equal(result.duplicateInput, 1);
  assert.equal(publications(db).length, 1);
});

test('ambiguous existing same-name remote IDs require explicit identity and repeated import keeps the previous synthetic ID', t => {
  const db = fixture(t);
  backfillSkillPublications(db, [record()], { now, apply: true });
  const previous = publications(db)[0];
  existing(db);
  assert.equal(backfillSkillPublications(db, [record()], { now, apply: true }).unchanged, 1);
  assert.equal(db.prepare('SELECT skill_id FROM ai_skill_publications WHERE operation_id=?').get(previous.operation_id).skill_id, previous.skill_id);
  existing(db, { id: 'native-2', skillId: 'remote-2' });
  db.prepare('DELETE FROM ai_skill_publications WHERE operation_id=?').run(previous.operation_id);
  assert.throws(() => backfillSkillPublications(db, [record()], { now, apply: true }), { code: 'SKILL_ID_AMBIGUOUS' });
});

test('requires source enqueue triggers and does not migrate an old database', t => {
  const db = fixture(t);
  db.exec('DROP TRIGGER ai_usage_publication_insert');
  assert.throws(() => backfillSkillPublications(db, [record()], { now, apply: true }), { code: 'MISSING_SOURCE_TRIGGER' });
  assert.equal(publications(db).length, 0);
});

test('strict timestamps use explicit Shanghai semantics and reject rollovers and future publications', t => {
  assert.equal(normalizePublicationTime('2026-08-01 12:34:56'), '2026-08-01T04:34:56.000Z');
  assert.equal(normalizePublicationTime('2026-08-01T12:34:56.9+08:00'), '2026-08-01T04:34:56.900Z');
  assert.equal(normalizePublicationTime('2026-08-01T04:34:56Z'), '2026-08-01T04:34:56.000Z');
  for (const value of ['2026-02-30 12:00:00', '2026-08-01 24:00:00', '2026-08-01T04:34:56+14:01', '2026-08-01', 'not a date']) {
    assert.throws(() => normalizePublicationTime(value), { code: 'INVALID_PUBLICATION_TIME' });
  }
  const db = fixture(t);
  assert.throws(() => backfillSkillPublications(db, [record({ firstPublishedAt: '2027-01-01 00:00:00' })], { now }), { code: 'FUTURE_PUBLICATION' });
});

test('JSON/CSV templates parse BOM, Chinese names and quoted fields and reject unknown columns', () => {
  assert.deepEqual(parsePublicationInput('\ufeff' + JSON.stringify([record()])), [record()]);
  assert.deepEqual(parsePublicationInput(JSON.stringify({ publications: [record()] })), [record()]);
  const csv = '\ufeffusername,skillName,firstPublishedAt\r\nalice,"查询, \"\"校验\"\"",2026-08-01 12:34:56\r\n';
  assert.deepEqual(parsePublicationInput(csv, 'csv'), [{ username: 'alice', skillName: '查询, "校验"', firstPublishedAt: '2026-08-01 12:34:56' }]);
  assert.throws(() => parsePublicationInput('user,skillName\nalice,x\n', 'csv'), { code: 'INVALID_CSV' });
  assert.throws(() => parsePublicationInput('username,skillName\nalice,"oops\n', 'csv'), { code: 'INVALID_CSV' });
  assert.throws(() => parsePublicationInput('[]'), { code: 'INVALID_INPUT' });
});

test('copied standalone script runs outside project using --project-root, without relative server imports', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-backfill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'backfill.mjs');
  const source = fileURLToPath(new URL('./backfill-ai-skill-publications.mjs', import.meta.url));
  const projectRoot = path.dirname(path.dirname(source));
  await copyFile(source, script);
  const help = spawnSync(process.execPath, [script, '--help'], { cwd: dir, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /默认只预览/);
  const dbPath = path.join(dir, 'auth.db');
  const db = fixture(t, dbPath);
  const input = path.join(dir, 'skills.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(input, JSON.stringify([record()]));
  const child = spawnSync(process.execPath, [script, '--project-root', projectRoot, '--db', dbPath, '--input', input, '--apply', '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).inserted, 1);
  assert.equal(publications(db).length, 1);
});


test('earlier backfill of an existing remote Skill replaces its published first date once in incremental and full pipelines', async t => {
  const db = fixture(t);
  db.exec(`ALTER TABLE tenants ADD COLUMN status TEXT DEFAULT 'active'; UPDATE tenants SET status='disabled' WHERE id=2;
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,normalized_json TEXT,provider_timestamp TEXT,created_at TEXT);`);
  existing(db);
  const incremental = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'true' });
  const full = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false' });
  let night = 22;
  const run = config => runAiUsageWindow({ database: db, config, now: () => new Date(`2026-10-${night}T18:10:00.000Z`),
    logger: { info() {}, warn() {}, error() {} } });
  assert.equal((await run(incremental)).published, 1);
  assert.deepEqual(db.prepare('SELECT skill_id,stat_date FROM ai_dashboard_skill_publication_detail').all(), [{ skill_id: 'remote-1', stat_date: '2026-09-01' }]);
  backfillSkillPublications(db, [record()], { now, apply: true });
  night++;
  assert.equal((await run(incremental)).published, 1);
  const query = createAiUsageQueryService({ db });
  const access = { tenantId: 1, userId: 11, scope: 'tenant', canViewTenant: true };
  const check = () => {
    assert.deepEqual(db.prepare('SELECT skill_id,stat_date FROM ai_dashboard_skill_publication_detail').all(), [{ skill_id: 'remote-1', stat_date: '2026-08-01' }]);
    assert.equal(db.prepare('SELECT SUM(skill_publish_count) n FROM ai_dashboard_integration_detail').get().n, 1);
    const all = query.skills(access, { from: '2026-08-01', to: '2026-09-30', groupBy: 'skill' });
    assert.equal(all.items.length, 1);
    assert.equal(all.items[0].publishedSkillCount, 1);
    assert.equal(all.items[0].firstPublishedAt, '2026-08-01T12:34:56+08:00');
    assert.equal(query.skills(access, { from: '2026-09-01', to: '2026-09-30', groupBy: 'skill' }).items[0].publishedSkillCount, 0);
    assert.equal(publications(db).length, 2, 'original confirmed source is retained alongside imported history');
  };
  check();
  night++;
  assert.equal((await run(full)).published, 1);
  check();
});


test('same-day earlier historical publication preserves the earliest time over a later captured publish event', async t => {
  const db = fixture(t);
  db.exec(`ALTER TABLE tenants ADD COLUMN status TEXT DEFAULT 'active'; UPDATE tenants SET status='disabled' WHERE id=2;
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT,runtime_home_path TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,normalized_json TEXT,provider_timestamp TEXT,created_at TEXT);
    INSERT INTO ai_skill_publish_events(id,tenant_id,user_id,workspace_id,skill_id,skill_name,publish_kind,status,requested_at,published_at)
      VALUES('later-capture',1,11,1,'remote-1','sql-review','create','succeeded','2026-08-01T06:00:00.000Z','2026-08-01T06:00:00.000Z');`);
  backfillSkillPublications(db, [record()], { now, apply: true });
  const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false' });
  const result = await runAiUsageWindow({ database: db, config, now: () => new Date('2026-10-23T18:10:00.000Z'), logger: { info() {}, warn() {}, error() {} } });
  assert.equal(result.published, 1);
  assert.deepEqual(db.prepare('SELECT skill_id,stat_date,occurred_at FROM ai_dashboard_skill_publication_detail').all(),
    [{ skill_id: 'remote-1', stat_date: '2026-08-01', occurred_at: '2026-08-01 12:34:56' }]);
});


test('reuses one exact-name remote ID from historical bindings only when the local publisher is known', t => {
  const db = fixture(t);
  const binding = db.prepare(`INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from,valid_to)
    VALUES(1,?,'sql-review','owned-remote',11,'2026-07-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`);
  binding.run(1); binding.run(2);
  const result = backfillSkillPublications(db, [record()], { now, apply: true });
  assert.equal(result.rows[0].skillId, 'owned-remote');
  assert.equal(result.rows[0].identitySource, 'trusted_binding');
  assert.equal(publications(db)[0].skill_id, 'owned-remote');
  assert.equal(backfillSkillPublications(db, [record()], { now, apply: true }).unchanged, 1);
});

test('unknown publisher, external account number, other tenant and different-case bindings cannot supply a remote ID', t => {
  const db = fixture(t);
  const binding = db.prepare(`INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,publisher_account_id,valid_from)
    VALUES(?,1,?,?,?,?, '2026-07-01T00:00:00.000Z')`);
  binding.run(1, 'sql-review', 'unknown-owner', null, '11');
  binding.run(1, 'sql-review', 'other-owner', 12, '11');
  binding.run(2, 'sql-review', 'other-tenant', 11, null);
  binding.run(1, 'SQL-review', 'other-case', 11, null);
  const result = backfillSkillPublications(db, [record()], { now, apply: true });
  assert.equal(result.rows[0].skillId, historicalPublicationIdentity(1, 11, 'sql-review').historicalSkillId);
  assert.equal(result.rows[0].identitySource, 'historical');
});

test('combined confirmed publication and owned binding IDs must be unique and agree with confirmed publishers', t => {
  const db = fixture(t);
  const binding = db.prepare(`INSERT INTO ai_skill_binding_history(tenant_id,workspace_id,local_name,remote_skill_id,publisher_user_id,valid_from)
    VALUES(1,1,'sql-review',?,11,'2026-07-01T00:00:00.000Z')`);
  binding.run('remote-1'); binding.run('remote-2');
  assert.throws(() => backfillSkillPublications(db, [record()], { now, apply: true }), { code: 'SKILL_ID_AMBIGUOUS' });
  db.exec("DELETE FROM ai_skill_binding_history WHERE remote_skill_id='remote-2'");
  existing(db, { skillId: 'remote-2' });
  assert.throws(() => backfillSkillPublications(db, [record()], { now, apply: true }), { code: 'SKILL_ID_AMBIGUOUS' });
  db.exec("DELETE FROM ai_skill_publications WHERE operation_id='native'");
  existing(db, { skillId: 'remote-1', userId: 12 });
  assert.throws(() => backfillSkillPublications(db, [record()], { now, apply: true }), { code: 'SKILL_PUBLISHER_CONFLICT' });
  db.exec("UPDATE ai_skill_publications SET user_id=11 WHERE operation_id='native'");
  const result = backfillSkillPublications(db, [record()], { now, apply: true });
  assert.equal(result.rows[0].skillId, 'remote-1');
  assert.equal(result.rows[0].identitySource, 'confirmed_publication');
});
