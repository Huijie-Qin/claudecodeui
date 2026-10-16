import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import { parseSqlGeneration } from '../server/services/ai-usage-sql.js';

import { auditTenantUsage, auditUserUsage } from './audit-ai-usage-user.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./audit-ai-usage-user.mjs', import.meta.url));
const at = '2026-09-11T02:00:00.000Z';
const identity = { tenantId: 1, userId: 7, workspaceId: 10, provider: 'claude', sessionId: 'shared-session' };
const fence = sql => `\`\`\`sql\n${sql}\n\`\`\``;
const reply = (id, content, timestamp = at) => ({ uuid: id, timestamp, type: 'assistant', message: { role: 'assistant', content } });
const request = (id, timestamp = at) => ({ uuid: id, timestamp, type: 'user', message: { role: 'user', content: 'Start request' } });
const completedReply = (id, content, timestamp) => ({ ...reply(id, content, timestamp),
  message: { role: 'assistant', content, stop_reason: 'end_turn' } });
const historyTurn = (id, start = at, end = '2026-09-11T02:01:00.000Z', content = 'Complete') =>
  [request(`${id}-user`, start), completedReply(`${id}-assistant`, content, end)];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccui-user-usage-audit-'));
  const databasePath = path.join(directory, 'business.db');
  const db = new Database(databasePath);
  t.after(async () => {
    if (db.open) db.close();
    await rm(directory, { recursive: true, force: true });
  });
  // Deliberately omit every published/statistics table. The audit must read original records only.
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY);
  CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
  CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER);
  INSERT INTO tenants VALUES(1),(2);
  INSERT INTO users VALUES(7,'audit-user'),(8,'other-user');
  INSERT INTO workspaces VALUES(10,1),(20,2);
  CREATE TABLE ai_usage_turn_facts (
    turn_key TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    workspace_id INTEGER NOT NULL, session_key TEXT, provider TEXT NOT NULL,
    request_key TEXT, started_at TEXT NOT NULL, response_completed_at TEXT,
    terminal_at TEXT, terminal_status TEXT NOT NULL DEFAULT 'pending', source TEXT,
    generation INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
  CREATE TABLE session_index (
    id INTEGER PRIMARY KEY, tenant_id INTEGER, workspace_id INTEGER, user_id INTEGER,
    provider TEXT, provider_session_id TEXT, summary TEXT, status TEXT DEFAULT 'active',
    metadata_json TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE agent_session_runtime (
    id INTEGER PRIMARY KEY, runtime_id TEXT, tenant_id INTEGER, workspace_id INTEGER,
    user_id INTEGER, provider TEXT, provider_session_id TEXT, runtime_home_path TEXT,
    container_name TEXT, image TEXT, workspace_host_path TEXT, status TEXT DEFAULT 'active',
    created_at TEXT, last_used_at TEXT, updated_at TEXT);
  CREATE TABLE agent_session_messages (
    id INTEGER PRIMARY KEY, tenant_id INTEGER, workspace_id INTEGER, user_id INTEGER,
    runtime_id TEXT, provider TEXT, provider_session_id TEXT, message_id TEXT, kind TEXT,
    role TEXT, content_text TEXT, normalized_json TEXT, provider_timestamp TEXT,
    sequence INTEGER, created_at TEXT, updated_at TEXT);`);
  function turn(id, start = at, end = '2026-09-11T02:01:00.000Z', { status = 'completed', ...scope } = {}) {
    const { tenantId, workspaceId, userId, provider, sessionId } = { ...identity, ...scope };
    db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,
      provider,started_at,response_completed_at,terminal_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, tenantId, userId, workspaceId, sessionId, provider, start, end, status, at);
  }
  function session(scope = {}) {
    const { tenantId, workspaceId, userId, provider, sessionId } = { ...identity, ...scope };
    db.prepare(`INSERT INTO session_index(tenant_id,workspace_id,user_id,provider,provider_session_id)
      VALUES(?,?,?,?,?)`).run(tenantId, workspaceId, userId, provider, sessionId);
  }
  function message(raw, { rawJson, ...scope } = {}) {
    const { tenantId, workspaceId, userId, provider, sessionId } = { ...identity, ...scope };
    const sequence = db.prepare('SELECT COUNT(*)+1 n FROM agent_session_messages').get().n;
    db.prepare(`INSERT INTO agent_session_messages(tenant_id,workspace_id,user_id,runtime_id,provider,
      provider_session_id,message_id,kind,role,normalized_json,provider_timestamp,sequence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenantId, workspaceId, userId, `runtime-${tenantId}-${workspaceId}-${userId}`,
      provider, sessionId, raw.uuid || raw.id || `message-${sequence}`, 'text', 'assistant',
      rawJson ?? JSON.stringify(raw), raw.timestamp ?? at, sequence, at);
  }
  async function native(messages, { subagentId, ...scope } = {}) {
    const resolved = { ...identity, ...scope };
    const { tenantId, workspaceId, userId, provider, sessionId } = resolved;
    const home = path.join(directory, `home-${tenantId}-${workspaceId}-${userId}`);
    const runtimeId = `runtime-${tenantId}-${workspaceId}-${userId}-${sessionId}`;
    if (!db.prepare('SELECT 1 FROM agent_session_runtime WHERE runtime_id=?').get(runtimeId)) {
      db.prepare(`INSERT INTO agent_session_runtime(runtime_id,tenant_id,workspace_id,user_id,provider,provider_session_id,runtime_home_path)
        VALUES(?,?,?,?,?,?,?)`).run(runtimeId, tenantId, workspaceId, userId, provider, sessionId, home);
    }
    const project = path.join(home, '.claude', 'projects', 'project');
    const file = subagentId ? path.join(project, sessionId, 'subagents', `agent-${subagentId}.jsonl`)
      : path.join(project, `${sessionId}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${messages.map(raw => typeof raw === 'string' ? raw : JSON.stringify(raw)).join('\n')}\n`);
    return file;
  }
  const run = options => auditUserUsage({ databasePath, tenantId: 1, userId: 7,
    from: '2026-09-11', to: '2026-09-11', ...options });
  return { directory, databasePath, db, turn, session, message, native, run };
}


async function nightlyFixture(f) {
  const { migrateAiUsageSchema } = await import('../server/database/ai-usage-schema.js');
  const { readAiUsageConfig } = await import('../server/services/ai-usage-config.js');
  const { runAiUsageWindow } = await import('../server/services/ai-usage-batches.js');
  f.db.exec(`ALTER TABLE tenants ADD COLUMN status TEXT DEFAULT 'inactive';
    UPDATE tenants SET status='active' WHERE id=1;
    ALTER TABLE workspaces ADD COLUMN display_name TEXT DEFAULT 'Audit';
    ALTER TABLE workspaces ADD COLUMN status TEXT DEFAULT 'active';`);
  migrateAiUsageSchema(f.db);
  let night = 12;
  return async () => {
    const currentNight = night++;
    const publication = await runAiUsageWindow({ database: f.db, config: readAiUsageConfig({ AI_USAGE_ENABLED: 'true' }),
      now: () => new Date(`2026-09-${currentNight}T18:10:00.000Z`), logger: { info() {}, warn() {}, error() {} } });
    assert.equal(publication.errors?.length || 0, 0, JSON.stringify(publication));
    assert.equal(publication.published, 1);
    return publication;
  };
}

test('duration comes only from scoped main history while captured requests remain diagnostic', async t => {
  const f = await fixture(t);
  f.turn('captured', at, '2026-09-11T02:10:00.000Z');
  f.turn('captured-codex', at, '2026-09-11T02:20:00.000Z', { provider: 'codex' });
  f.turn('other-user', at, '2026-09-11T02:30:00.000Z', { userId: 8 });
  await f.native(historyTurn('wanted'));
  await f.native(historyTurn('wanted-second', at, '2026-09-11T02:02:00.000Z'), { sessionId: 'second-session' });
  await f.native(historyTurn('other-user', at, '2026-09-11T02:40:00.000Z'), { userId: 8 });
  await f.native(historyTurn('other-tenant', at, '2026-09-11T02:50:00.000Z'), { tenantId: 2, workspaceId: 20 });
  const result = await f.run();
  assert.equal(result.tenantId, 1);
  assert.equal(result.userId, 7);
  assert.equal(result.userName, 'audit-user');
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.equal(result.metrics.aiActiveDurationSeconds, 180);
  assert.equal(result.scanned.turnRecords, 2);
  assert.equal(result.scanned.capturedCompletedTurns, 2);
  assert.equal(result.scanned.historyTurns, 2);
  assert.equal(result.scanned.completedHistoryTurns, 2);
  assert.equal(result.scanned.durationFiles, 2);
  assert.equal(result.coverage.duration, 'partial');
  assert.equal(result.coverage.durationReason, 'readable_main_history_only');
});

test('cross-midnight history turns are clipped to inclusive local dates without losing turns starting outside the range', async t => {
  const f = await fixture(t);
  await f.native([
    ...historyTurn('enters-range', '2026-09-10T15:59:00.000Z', '2026-09-10T16:02:00.000Z'),
    ...historyTurn('leaves-range', '2026-09-11T15:59:00.000Z', '2026-09-11T16:03:00.000Z'),
  ]);
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.equal(result.range.fromInclusive, '2026-09-10T16:00:00.000Z');
  assert.equal(result.range.toExclusive, '2026-09-11T16:00:00.000Z');
  assert.deepEqual(result.daily.map(row => [row.date, row.aiActiveDurationMs]), [['2026-09-11', 180000]]);
  const expanded = await f.run({ from: '2026-09-10', to: '2026-09-12' });
  assert.equal(expanded.metrics.aiActiveDurationMs, 420000);
  assert.deepEqual(expanded.daily.map(row => [row.date, row.aiActiveDurationMs]),
    [['2026-09-10', 60000], ['2026-09-11', 180000], ['2026-09-12', 180000]]);
  const utc = await f.run({ timeZone: 'UTC' });
  assert.equal(utc.range.fromInclusive, '2026-09-11T00:00:00.000Z');
  assert.equal(utc.metrics.aiActiveDurationMs, 240000);
});

test('invalid and incomplete historical turns cannot erase adjacent successful duration', async t => {
  const f = await fixture(t);
  await f.native([
    ...historyTurn('good-before'),
    ...historyTurn('bad-start', 'not-a-date', '2026-09-11T02:01:00.000Z'),
    ...historyTurn('bad-end', at, 'not-a-date'),
    ...historyTurn('reversed', '2026-09-11T02:01:00.000Z', at),
    request('uncompleted-user', at), reply('uncompleted-answer', 'Still working', '2026-09-11T02:05:00.000Z'),
    ...historyTurn('good-after', '2026-09-11T03:00:00.000Z', '2026-09-11T03:02:00.000Z'),
  ]);
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.ok(result.skipped.history_duration_anomaly > 0);
  assert.ok(result.issues.length > 0);
  assert.equal(result.durationRecords.filter(row => row.status === 'counted').length, 2);
});

test('SQL database fallback isolates tenant and user and ignores nonassistant or malformed records', async t => {
  const f = await fixture(t);
  f.message(reply('wanted', fence('SELECT 1;\nSELECT 2;')));
  f.message(reply('other-user', fence('SELECT 3;')), { userId: 8 });
  f.message(reply('other-tenant', fence('SELECT 4;')), { tenantId: 2, workspaceId: 20 });
  f.message({ ...reply('user-copy', fence('SELECT 5;')), type: 'user', message: { role: 'user', content: fence('SELECT 5;') } });
  f.message({ id: 'thinking', role: 'assistant', kind: 'thinking', content: fence('SELECT 6;'), timestamp: at });
  f.message({}, { rawJson: '{broken' });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 3);
  assert.equal(result.sqlRecords.find(row => row.messageId === 'thinking').status, 'counted');
  assert.equal(result.coverage.sql, 'partial');
  assert.equal(result.metrics.aiActiveDurationMs, null);
  assert.equal(result.metrics.aiActiveDurationSeconds, null);
  assert.equal(result.coverage.duration, 'unavailable');
  assert.equal(result.coverage.durationReason, 'no_readable_main_history');
  assert.ok(result.daily.every(row => row.aiActiveDurationMs === null));
});

test('a readable native main transcript takes precedence over differently identified database copies', async t => {
  const f = await fixture(t);
  f.session();
  f.message(reply('database-copy', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')));
  await f.native([reply('native-original', fence('SELECT 4;'))]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.equal(result.scanned.nativeFiles, 1);
  const copy = result.sqlRecords.find(row => row.messageId === 'database-copy');
  assert.equal(copy.status, 'native_preferred');
  assert.equal(copy.databaseMessageId, 1);
  assert.equal(result.sqlDiagnostics.native_preferred, 1);
  assert.equal(result.sqlDiagnostics.counted, 1);
});

test('missing native history falls back to original database messages', async t => {
  const f = await fixture(t);
  f.session();
  f.message(reply('database-copy', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')));
  const file = await f.native([reply('native-original', fence('SELECT 4;'))]);
  await rm(file);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 3);
  assert.equal(result.coverage.sql, 'partial');
});

test('an empty readable native transcript still suppresses stale SQL database copies', async t => {
  const f = await fixture(t);
  f.session();
  f.message(reply('stale-copy', fence('SELECT 1;')));
  await f.native([]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 0);
  assert.equal(result.coverage.sql, 'partial');
});

test('malformed native lines do not prevent valid messages from being counted', async t => {
  const f = await fixture(t);
  f.session();
  await f.native(['{broken', reply('good-after-bad', fence('SELECT 1;')), 'null']);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.ok(Object.values(result.skipped).some(count => count > 0));
});

test('native forks exclude inherited SQL while retaining new main and subagent output', async t => {
  const f = await fixture(t);
  f.session();
  f.session({ sessionId: 'fork' });
  await f.native([reply('original', fence('SELECT 1;'))]);
  await f.native([
    { ...reply('inherited', fence('SELECT 2;\nSELECT 3;')), forkedFrom: { sessionId: identity.sessionId, messageUuid: 'original' } },
    { ...reply('inherited-flag', fence('SELECT 4;')), inherited: true },
    reply('shared-message-id', fence('SELECT 5;\nSELECT 6;')),
  ], { sessionId: 'fork' });
  await f.native([reply('shared-message-id', fence('SELECT 7;\nSELECT 8;\nSELECT 9;'))],
    { sessionId: 'fork', subagentId: 'child' });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 6);
  assert.equal(result.scanned.nativeFiles, 3);
});

test('database fork envelopes and nested inherited flags do not duplicate original SQL', async t => {
  const f = await fixture(t);
  f.message(reply('original', fence('SELECT 1;\nSELECT 2;')));
  f.message({ ...reply('copy-one', fence('SELECT 3;')), inherited: true }, { sessionId: 'fork' });
  f.message({ type: 'claude-response', data: { ...reply('copy-two', fence('SELECT 4;')), forkedFrom: {} } }, { sessionId: 'fork' });
  f.message({ ...reply('copy-three', fence('SELECT 5;')), message: {
    role: 'assistant', content: fence('SELECT 5;'), inherited: true,
  } }, { sessionId: 'fork' });
  assert.equal((await f.run()).metrics.generatedSqlLines, 2);
});

test('SQL uses provider timestamps and local inclusive dates instead of database insertion time', async t => {
  const f = await fixture(t);
  f.message(reply('before', fence('SELECT 1;'), '2026-09-10T15:59:59.999Z'));
  f.message(reply('first', fence('SELECT 2;\nSELECT 3;'), '2026-09-10T16:00:00.000Z'));
  f.message(reply('last', fence('SELECT 4;\nSELECT 5;\nSELECT 6;'), '2026-09-11T15:59:59.999Z'));
  f.message(reply('after', fence('SELECT 7;'), '2026-09-11T16:00:00.000Z'));
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 5);
  assert.deepEqual(result.daily.map(row => [row.date, row.generatedSqlLines]), [['2026-09-11', 5]]);
});

test('native discovery cannot read another tenant or user history', async t => {
  const f = await fixture(t);
  for (const scope of [{}, { userId: 8 }, { tenantId: 2, workspaceId: 20, sessionId: 'other-tenant-session' }]) f.session(scope);
  await f.native([reply('wanted', fence('SELECT 1;'))]);
  await f.native([reply('other-user', fence('SELECT 2;\nSELECT 3;'))], { userId: 8 });
  await f.native([reply('other-tenant', fence('SELECT 4;\nSELECT 5;\nSELECT 6;'))],
    { tenantId: 2, workspaceId: 20, sessionId: 'other-tenant-session' });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.equal(result.scanned.nativeFiles, 1);
});

test('ambiguous session ownership excludes only the conflicted session while valid sessions remain auditable', async t => {
  const f = await fixture(t);
  f.session();
  f.session({ tenantId: 2, workspaceId: 20 });
  f.session({ sessionId: 'healthy-session' });
  f.turn('conflicted-turn');
  f.turn('healthy-turn', at, '2026-09-11T02:02:00.000Z', { sessionId: 'healthy-session' });
  await f.native(historyTurn('conflicted', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')));
  await f.native(historyTurn('healthy', at, '2026-09-11T02:02:00.000Z', fence('SELECT 4;\nSELECT 5;')), { sessionId: 'healthy-session' });
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 120000);
  assert.equal(result.metrics.generatedSqlLines, 2);
  assert.ok(Object.values(result.skipped).some(count => count > 0));
  assert.ok(result.issues.length > 0);
});

test('repeated audits leave the original database, schema, native transcript, and directory unchanged', async t => {
  const f = await fixture(t);
  f.turn('original');
  f.session();
  const file = await f.native(historyTurn('original', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')));
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  f.db.close();
  const before = { database: await readFile(f.databasePath), native: await readFile(file),
    databaseMtime: (await stat(f.databasePath)).mtimeMs, nativeMtime: (await stat(file)).mtimeMs,
    files: (await readdir(f.directory)).sort() };
  const first = await f.run();
  const second = await f.run();
  assert.deepEqual(second.metrics, first.metrics);
  assert.deepEqual(second.daily, first.daily);
  assert.deepEqual(second.scanned, first.scanned);
  assert.deepEqual(await readFile(f.databasePath), before.database);
  assert.deepEqual(await readFile(file), before.native);
  assert.equal((await stat(f.databasePath)).mtimeMs, before.databaseMtime);
  assert.equal((await stat(file)).mtimeMs, before.nativeMtime);
  assert.deepEqual((await readdir(f.directory)).sort(), before.files);
  const inspected = new Database(f.databasePath, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(inspected.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema); }
  finally { inspected.close(); }
});

test('historical duration does not require the realtime captured turn table', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE ai_usage_turn_facts');
  await f.native(historyTurn('original', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')));
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 60000);
  assert.equal(result.metrics.aiActiveDurationSeconds, 60);
  assert.equal(result.scanned.turnRecords, 0);
  assert.equal(result.scanned.historyTurns, 1);
  assert.equal(result.coverage.duration, 'partial');
  assert.equal(result.coverage.durationReason, 'readable_main_history_only');
  assert.equal(result.metrics.generatedSqlLines, 1);
});

test('readable native history provides SQL when the database message table is absent', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE agent_session_messages');
  f.session();
  await f.native([reply('original', fence('SELECT 1;'))]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.equal(result.coverage.sql, 'partial');
});

test('missing SQL sources are reported as unavailable rather than a measured zero', async t => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE agent_session_messages');
  f.turn('original');
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, null);
  assert.equal(result.coverage.sql, 'unavailable');
  assert.equal(result.metrics.aiActiveDurationMs, null);
  assert.equal(result.coverage.durationReason, 'no_readable_main_history');
});

test('unknown tenants and users cannot silently produce a zero-valued audit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ tenantId: 999 }));
  await assert.rejects(f.run({ userId: 999 }));
});

test('a missing database is rejected without creating a file', async t => {
  const f = await fixture(t);
  const missing = path.join(f.directory, 'must-not-be-created.db');
  await assert.rejects(f.run({ databasePath: missing }));
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});

for (const [name, revised, revisionStatus] of [
  ['removes SQL', reply('amended', 'This reply no longer contains SQL.'), 'no_sql'],
  ['moves outside the date range', reply('amended', fence('SELECT 5;'), '2026-09-11T16:00:00.000Z'), 'out_of_range'],
]) {
  test(`a later native revision that ${name} replaces the earlier version before filtering`, async t => {
    const f = await fixture(t);
    f.session();
    const file = await f.native([reply('amended', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')), revised,
      reply('unaffected', fence('SELECT 6;\nSELECT 7;'))]);
    const result = await f.run();
    assert.equal(result.metrics.generatedSqlLines, 2);
    const revisions = result.sqlRecords.filter(row => row.messageId === 'amended');
    assert.deepEqual(revisions.map(row => [row.path, row.line, row.status]),
      [[file, 1, 'superseded'], [file, 2, revisionStatus]]);
    assert.equal(result.sqlDiagnostics.superseded, 1);
    assert.equal(result.sqlDiagnostics[revisionStatus], 1);
    assert.equal(result.sqlDiagnostics.counted, 1);
    assert.equal(result.sources.find(source => source.path === file).countedSqlLines, 2);
  });
}

test('an unterminated native tail is excluded while preceding complete lines remain countable', async t => {
  const f = await fixture(t);
  f.session();
  const file = await f.native([]);
  await writeFile(file, `${JSON.stringify(reply('complete', fence('SELECT 1;')))}\n${JSON.stringify(reply('in-flight', fence('SELECT 2;\nSELECT 3;')))}`);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.equal(result.skipped.unterminated_jsonl_tail, 1);
});

test('an oversized native line is skipped without consuming the next valid assistant reply', async t => {
  const f = await fixture(t);
  f.session();
  await f.native([reply('before', fence('SELECT 1;')),
    reply('oversized', `${'x'.repeat(2 * 1024 * 1024)}\n${fence('SELECT 2;\nSELECT 3;\nSELECT 4;')}`),
    reply('after', fence('SELECT 5;\nSELECT 6;'))]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 3);
  assert.equal(result.skipped.oversized_jsonl_line, 1);
});

test('suppressed SQL rows stay excluded while suppression from other tenants and datasets cannot hide valid output', async t => {
  const f = await fixture(t);
  const excluded = reply('suppressed', fence('SELECT 1;\nSELECT 2;\nSELECT 3;'));
  const retained = reply('retained', fence('SELECT 4;\nSELECT 5;'));
  f.message(excluded);
  f.message(retained);
  const scope = { tenant_id: 1, workspace_id: 10, user_id: 7, provider: 'claude', provider_session_id: identity.sessionId };
  const excludedKey = parseSqlGeneration(scope, excluded)[0].row_key;
  const retainedKey = parseSqlGeneration(scope, retained)[0].row_key;
  f.db.exec('CREATE TABLE ai_usage_suppressed_rows(tenant_id INTEGER,dataset TEXT,row_key TEXT)');
  const suppress = f.db.prepare('INSERT INTO ai_usage_suppressed_rows VALUES(?,?,?)');
  suppress.run(1, 'sql_generations', excludedKey);
  suppress.run(2, 'sql_generations', retainedKey);
  suppress.run(1, 'interactions', retainedKey);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 2);
  assert.equal(result.skipped.sql_suppressed, 1);
});

test('an invalid nonempty provider timestamp rejects the database source even when its raw message timestamp is valid', async t => {
  const f = await fixture(t);
  f.message(reply('bad-provider-time', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')));
  f.db.prepare("UPDATE agent_session_messages SET provider_timestamp='invalid-time' WHERE message_id='bad-provider-time'").run();
  f.message(reply('good-provider-time', fence('SELECT 4;\nSELECT 5;')));
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 2);
  assert.ok(Object.values(result.skipped).some(count => count > 0));
});

test('database creation time cannot substitute for missing raw and provider business timestamps', async t => {
  const f = await fixture(t);
  const raw = reply('missing-business-time', fence('SELECT 1;\nSELECT 2;'));
  delete raw.timestamp;
  f.message(raw);
  f.db.prepare("UPDATE agent_session_messages SET provider_timestamp=NULL WHERE message_id='missing-business-time'").run();
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 0);
  assert.equal(result.skipped.missing_sql_identity_or_time, 1);
  assert.ok(result.issues.some(issue => issue.reason === 'missing_sql_identity_or_time'));
});

test('CLI help succeeds without opening a business database', async () => {
  const { stdout, stderr } = await execute(process.execPath, [script, '--help'], { timeout: 10000 });
  assert.match(stdout, /--tenant-id/);
  assert.match(stdout, /--user-id/);
  assert.match(stdout, /--json/);
  assert.equal(stderr, '');
});

test('CLI JSON audits an explicit temporary database and returns parseable metrics', async t => {
  const f = await fixture(t);
  f.turn('wanted');
  await f.native(historyTurn('wanted', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;\nSELECT 2;')));
  f.db.close();
  const before = await readFile(f.databasePath);
  const { stdout, stderr } = await execute(process.execPath, [script, '--db', f.databasePath,
    '--tenant-id', '1', '--user-id', '7', '--from', '2026-09-11', '--to', '2026-09-11',
    '--time-zone', 'Asia/Shanghai', '--json'], { timeout: 10000 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.metrics, { aiActiveDurationMs: 60000, aiActiveDurationSeconds: 60, generatedSqlLines: 2 });
  assert.equal(result.tenantId, 1);
  assert.equal(result.userId, 7);
  assert.equal(stderr, '');
  assert.deepEqual(await readFile(f.databasePath), before);
});

test('turns belonging only to other users or tenants do not imply duration coverage for the requested user', async t => {
  const f = await fixture(t);
  f.turn('other-user', at, '2026-09-11T02:01:00.000Z', { userId: 8 });
  f.turn('other-tenant', at, '2026-09-11T02:01:00.000Z', { tenantId: 2, workspaceId: 20 });
  f.message(reply('sql-without-turn-facts', fence('SELECT 1;')));
  const result = await f.run();
  assert.equal(result.scanned.turnRecords, 0);
  assert.equal(result.metrics.aiActiveDurationMs, null);
  assert.equal(result.metrics.aiActiveDurationSeconds, null);
  assert.equal(result.coverage.duration, 'unavailable');
  assert.equal(result.coverage.durationReason, 'no_readable_main_history');
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.equal(result.daily[0].aiActiveDurationMs, null);
});

test('captured requests alone never imply historical duration coverage', async t => {
  const f = await fixture(t);
  for (const status of ['pending', 'unsupported', 'failed', 'completed']) f.turn(status, at, null, { status });
  const result = await f.run();
  assert.equal(result.scanned.turnRecords, 4);
  assert.equal(result.scanned.capturedCompletedTurns, 1);
  assert.equal(result.scanned.historyTurns, 0);
  assert.equal(result.metrics.aiActiveDurationMs, null);
  assert.equal(result.metrics.aiActiveDurationSeconds, null);
  assert.equal(result.coverage.duration, 'unavailable');
  assert.equal(result.coverage.durationReason, 'no_readable_main_history');
});

for (const [name, start, end] of [
  ['has a zero-length successful interval', at, at],
  ['has a successful interval entirely outside the requested dates', '2026-09-10T02:00:00.000Z', '2026-09-10T02:01:00.000Z'],
]) {
  test(`available duration remains zero when the original history ${name}`, async t => {
    const f = await fixture(t);
    await f.native(historyTurn('historical', start, end));
    const result = await f.run();
    assert.equal(result.scanned.turnRecords, 0);
    assert.equal(result.scanned.completedHistoryTurns, 1);
    assert.equal(result.metrics.aiActiveDurationMs, 0);
    assert.equal(result.metrics.aiActiveDurationSeconds, 0);
    assert.equal(result.coverage.duration, 'partial');
  });
}

test('native source diagnostics expose file counts and exact SQL reply locations without message bodies', async t => {
  const f = await fixture(t);
  f.session();
  const user = { uuid: 'user-request', timestamp: at, type: 'user', message: { role: 'user', content: 'private-user-request' } };
  const file = await f.native(['', '{broken', 'null', user,
    reply('sql-answer', fence('SELECT *\nFROM private_diagnostic_test_table;')),
    reply('plain-answer', 'private-nonsql-answer')]);
  const result = await f.run();
  const source = result.sources.find(row => row.path === file);
  assert.equal(source.status, 'read');
  assert.equal(source.linesRead, 6);
  assert.equal(source.parsedRecords, 4);
  assert.equal(source.assistantMessages, 2);
  assert.equal(source.sqlMessages, 1);
  assert.equal(source.countedSqlLines, 2);
  assert.equal(source.bytesRead, (await stat(file)).size);
  assert.equal(source.sessionKey, JSON.stringify([1, 10, 7, 'claude', identity.sessionId]));
  assert.equal(source.subagentId, null);
  const sql = result.sqlRecords.find(row => row.messageId === 'sql-answer');
  assert.equal(sql.path, file);
  assert.equal(sql.line, 5);
  assert.equal(sql.date, '2026-09-11');
  assert.equal(sql.generatedSqlLines, 2);
  assert.equal(sql.sqlBlockCount, 1);
  assert.equal(sql.status, 'counted');
  assert.equal(result.sqlRecords.find(row => row.messageId === 'plain-answer').status, 'no_sql');
  assert.ok(!result.sqlRecords.some(row => row.messageId === 'user-request'));
  assert.equal(result.sqlDiagnostics.counted, 1);
  assert.equal(result.sqlDiagnostics.no_sql, 1);
  assert.equal(result.metrics.generatedSqlLines, 2);
  for (const privateText of ['private-user-request', 'private_diagnostic_test_table', 'private-nonsql-answer']) {
    assert.ok(!JSON.stringify(result).includes(privateText), privateText);
  }
});

test('SQL diagnostic sampling limits output without truncating metric or final status totals', async t => {
  const f = await fixture(t);
  f.session();
  await f.native(Array.from({ length: 1005 }, (_, index) => reply(`reply-${index}`, fence('SELECT 1;'))));
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1005);
  assert.equal(result.sqlDiagnostics.counted, 1005);
  assert.equal(result.sqlRecords.length, 1000);
  assert.equal(result.sqlRecordsTruncated, true);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sourcesTruncated, false);
  assert.equal(result.sources[0].sqlMessages, 1005);
  assert.equal(result.sources[0].countedSqlLines, 1005);
});

test('native SQL accounting combines assistant text, thinking, and tool parameters with cross-block deduplication', async t => {
  const f = await fixture(t);
  f.session();
  const file = await f.native([reply('all-assistant-blocks', [
    { type: 'text', text: fence('SELECT 1;') },
    { type: 'thinking', thinking: `${fence('SELECT 1;')}\n${fence('SELECT 2;')}` },
    { type: 'reasoning', text: fence('SELECT 2;') },
    { type: 'tool_use', id: 'sql-tool', name: 'run_query', input: { query: 'SELECT 3;\nSELECT 4;' } },
    { type: 'function_call', name: 'run_query', arguments: JSON.stringify({ sql: 'SELECT 5;' }) },
    { type: 'tool_result', tool_use_id: 'sql-tool', content: fence('SELECT 100;') },
    { type: 'text_delta', text: fence('SELECT 200;') },
    { type: 'thinking_delta', thinking: fence('SELECT 300;') },
  ])]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 5);
  const record = result.sqlRecords.find(row => row.messageId === 'all-assistant-blocks');
  assert.equal(record.status, 'counted');
  assert.equal(record.generatedSqlLines, 5);
  assert.equal(record.sqlBlockCount, 4);
  assert.equal(record.path, file);
  assert.equal(result.sources[0].sqlMessages, 1);
  assert.equal(result.sources[0].countedSqlLines, 5);
  assert.equal(result.sqlDiagnostics.non_text_kind || 0, 0);
  assert.equal(result.sqlDiagnostics.non_generated_kind || 0, 0);
});

test('normalized thinking, reasoning, and tool inputs count SQL without being rejected as non-text kinds', async t => {
  const f = await fixture(t);
  const normalized = (id, kind, fields) => ({ id, role: 'assistant', kind, timestamp: at, ...fields });
  f.message(normalized('thinking-sql', 'thinking', { content: fence('SELECT 1;\nSELECT 2;') }));
  f.message(normalized('reasoning-sql', 'reasoning', { content: 'SELECT 3;' }));
  f.message(normalized('tool-input-sql', 'tool_use', { toolInput: { sql: 'SELECT 4;' }, input: { query: 'SELECT 4;' } }));
  f.message(normalized('function-input-sql', 'function_call', { input: { query: 'SELECT 5;\nSELECT 6;' } }));
  f.message(normalized('other-user', 'reasoning', { content: fence('SELECT 100;') }), { userId: 8 });
  f.message(normalized('other-tenant', 'tool_use', { toolInput: { sql: 'SELECT 200;' } }), { tenantId: 2, workspaceId: 20 });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 6);
  assert.equal(result.sqlDiagnostics.counted, 4);
  assert.equal(result.sqlDiagnostics.non_text_kind || 0, 0);
  assert.equal(result.sqlDiagnostics.non_generated_kind || 0, 0);
  assert.deepEqual(result.sqlRecords.map(row => [row.messageId, row.generatedSqlLines, row.status]), [
    ['thinking-sql', 2, 'counted'], ['reasoning-sql', 1, 'counted'],
    ['tool-input-sql', 1, 'counted'], ['function-input-sql', 2, 'counted'],
  ]);
});

test('expanding assistant SQL formats still excludes tool results, stream fragments, meta, and inherited messages', async t => {
  const f = await fixture(t);
  const normalized = (id, kind, fields = {}) => ({ id, role: 'assistant', kind, timestamp: at,
    content: fence('SELECT 100;'), toolInput: { sql: 'SELECT 200;' }, ...fields });
  f.message(normalized('tool-output', 'tool_result'));
  f.message(normalized('partial-output', 'stream_delta'));
  f.message(normalized('meta-thinking', 'thinking', { isMeta: true }));
  f.message(normalized('inherited-tool', 'tool_use', { inherited: true }));
  f.message(normalized('user-tool-copy', 'tool_use', { role: 'user' }));
  f.message({ id: 'valid-thinking', role: 'assistant', kind: 'thinking', timestamp: at, content: fence('SELECT 1;') });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 1);
  assert.deepEqual(result.sqlRecords.filter(row => row.status === 'counted').map(row => row.messageId), ['valid-thinking']);
  assert.equal(result.sqlRecords.find(row => row.messageId === 'tool-output').status, 'non_generated_kind');
  assert.equal(result.sqlRecords.find(row => row.messageId === 'partial-output').status, 'non_generated_kind');
  assert.equal(result.sqlRecords.find(row => row.messageId === 'meta-thinking').status, 'meta');
  assert.equal(result.sqlRecords.find(row => row.messageId === 'inherited-tool').status, 'inherited');
  assert.ok(!result.sqlRecords.some(row => row.messageId === 'user-tool-copy'));
});

test('a revised assistant message replaces SQL across thinking and function-call formats', async t => {
  const f = await fixture(t);
  f.session();
  await f.native([
    { id: 'revised', role: 'assistant', kind: 'thinking', timestamp: at, content: fence('SELECT 1;\nSELECT 2;\nSELECT 3;') },
    { id: 'revised', role: 'assistant', kind: 'function_call', timestamp: at, input: { sql: 'SELECT 4;\nSELECT 5;' } },
  ]);
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 2);
  assert.deepEqual(result.sqlRecords.map(row => [row.line, row.generatedSqlLines, row.status]),
    [[1, 3, 'superseded'], [2, 2, 'counted']]);
  assert.equal(result.sources[0].sqlMessages, 2);
  assert.equal(result.sources[0].countedSqlLines, 2);
  assert.equal(result.sqlDiagnostics.non_text_kind || 0, 0);
  assert.equal(result.sqlDiagnostics.non_generated_kind || 0, 0);
});

test('role-less normalized assistant kinds remain countable while an explicit user role stays excluded', async t => {
  const f = await fixture(t);
  f.message({ id: 'roleless-thinking', kind: 'thinking', timestamp: at, content: fence('SELECT 1;') });
  f.message({ id: 'roleless-reasoning', kind: 'reasoning', timestamp: at, content: fence('SELECT 2;') });
  f.message({ id: 'roleless-tool', kind: 'tool_use', timestamp: at, toolInput: { query: 'SELECT 3;' } });
  f.message({ id: 'roleless-function', kind: 'function_call', timestamp: at,
    arguments: JSON.stringify({ query: 'SELECT 4;\nSELECT 5;' }) });
  f.message({ id: 'explicit-user', role: 'user', kind: 'reasoning', timestamp: at, content: fence('SELECT 100;') });
  const result = await f.run();
  assert.equal(result.metrics.generatedSqlLines, 5);
  assert.equal(result.sqlDiagnostics.counted, 4);
  assert.equal(result.sqlDiagnostics.non_text_kind || 0, 0);
  assert.equal(result.sqlDiagnostics.non_generated_kind || 0, 0);
  assert.deepEqual(result.sqlRecords.map(row => row.messageId),
    ['roleless-thinking', 'roleless-reasoning', 'roleless-tool', 'roleless-function']);
});


for (const [name, marker] of [
  ['successful result', { type: 'result', subtype: 'success', is_error: false }],
  ['turn-duration marker', { type: 'system', subtype: 'turn_duration', durationMs: 99999999 }],
]) {
  test(`historical ${name} confirms completion without replacing the last assistant timestamp`, async t => {
    const f = await fixture(t);
    const file = await f.native([
      request('request'),
      reply('first', 'Thinking', '2026-09-11T02:01:00.000Z'),
      reply('final', 'Answer', '2026-09-11T02:02:00.000Z'),
      { ...marker, timestamp: '2026-09-11T03:00:00.000Z' },
    ]);
    const result = await f.run();
    assert.equal(result.metrics.aiActiveDurationMs, 120000);
    assert.equal(result.scanned.completedHistoryTurns, 1);
    const source = result.sources.find(source => source.path === file);
    assert.equal(source.durationStatus, 'read');
    assert.equal(source.historyTurns, 1);
    assert.equal(source.completedHistoryTurns, 1);
    assert.equal(source.countedDurationMs, 120000);
    const record = result.durationRecords.find(record => record.status === 'counted');
    assert.equal(record.path, file);
    assert.equal(record.requestStartedAt, at);
    assert.equal(record.responseCompletedAt, '2026-09-11T02:02:00.000Z');
    assert.equal(record.durationMs, 120000);
    assert.equal(record.countedDurationMs, 120000);
    assert.ok(['result', 'turn_duration'].includes(record.completionEvidence));
    assert.equal(result.durationDiagnostics.counted, 1);
  });
}

test('completed-reply sidecars supply identity evidence without using marker write time or changing files', async t => {
  const f = await fixture(t);
  const file = await f.native([
    request('original-request'), reply('original-answer', 'Complete', '2026-09-11T02:03:00.000Z'),
  ]);
  const markerDirectory = path.join(path.dirname(file), identity.sessionId);
  await mkdir(markerDirectory, { recursive: true });
  const markerFile = path.join(markerDirectory, 'completed-replies.jsonl');
  const marker = `${JSON.stringify({ version: 1, sourceMessageUuid: 'original-answer', completedAt: '2026-10-01T00:00:00.000Z' })}\n`;
  await writeFile(markerFile, marker);
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.equal(result.durationRecords[0].completionEvidence, 'completed_reply');
  assert.equal(result.sources[0].completionMarkersStatus, 'read');
  assert.equal(await readFile(markerFile, 'utf8'), marker);
});

test('main history includes tool work without treating results, inherited copies or subagents as additional user turns', async t => {
  const f = await fixture(t);
  const tool = { ...reply('tool', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }], '2026-09-11T02:01:00.000Z'),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } };
  await f.native([
    ...historyTurn('inherited', '2026-09-11T01:00:00.000Z', at).map(record => ({ ...record, inherited: true })),
    request('main-user'), tool,
    { type: 'user', uuid: 'tool-result', timestamp: '2026-09-11T02:02:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done' }] } },
    completedReply('main-final', 'Complete', '2026-09-11T02:03:00.000Z'),
  ]);
  const child = await f.native(historyTurn('child', at, '2026-09-11T02:02:00.000Z'), { subagentId: 'worker' });
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.equal(result.scanned.historyTurns, 1);
  assert.equal(result.scanned.durationFiles, 1);
  assert.equal(result.scanned.nativeFiles, 2);
  assert.equal(result.sources.find(source => source.path === child).durationStatus, 'subagent_excluded');
  assert.equal(result.sources.find(source => source.path === child).countedDurationMs, 0);
});

test('malformed records invalidate only their current history turn and readable incomplete history measures zero', async t => {
  const f = await fixture(t);
  await f.native([
    ...historyTurn('good-before'), request('broken-request', '2026-09-11T02:02:00.000Z'),
    '{bad-json', completedReply('untrusted-answer', 'Cannot close missing history', '2026-09-11T02:05:00.000Z'),
    ...historyTurn('good-after', '2026-09-11T03:00:00.000Z', '2026-09-11T03:02:00.000Z'),
  ]);
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 180000);
  assert.equal(result.scanned.historyTurns, 3);
  assert.equal(result.scanned.completedHistoryTurns, 2);
  assert.equal(result.durationDiagnostics.incomplete, 1);
  assert.equal(result.skipped.malformed_jsonl, 1);
  await f.native([request('unfinished-request'), reply('unfinished-answer', 'Work in progress', '2026-09-11T02:03:00.000Z')]);
  const unfinished = await f.run();
  assert.equal(unfinished.metrics.aiActiveDurationMs, 0);
  assert.equal(unfinished.coverage.duration, 'partial');
  assert.equal(unfinished.scanned.historyTurns, 1);
  assert.equal(unfinished.scanned.completedHistoryTurns, 0);
  assert.equal(unfinished.durationDiagnostics.incomplete, 1);
});

test('duplicate original history files do not double count duration and retain source diagnostics', async t => {
  const f = await fixture(t);
  const file = await f.native(historyTurn('original'));
  const secondDirectory = path.join(path.dirname(path.dirname(file)), 'second-project');
  await mkdir(secondDirectory, { recursive: true });
  const copy = path.join(secondDirectory, path.basename(file));
  await writeFile(copy, await readFile(file));
  const result = await f.run();
  assert.equal(result.metrics.aiActiveDurationMs, 60000);
  assert.equal(result.scanned.historyTurns, 2);
  assert.equal(result.durationDiagnostics.counted, 1);
  assert.equal(result.durationDiagnostics.duplicate_source, 1);
  assert.equal(result.sources.reduce((total, source) => total + source.countedDurationMs, 0), 60000);
});


test('read-only audit and nightly publication agree on captures, foreign records, partial tails, cross-day damage and completion evidence', async t => {
  const f = await fixture(t);
  const runNightly = await nightlyFixture(f);
  f.session();
  f.turn('captured-ten-minutes', at, '2026-09-11T02:10:00.000Z');
  const file = await f.native(historyTurn('one-minute', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')));
  const compare = async expected => {
    await runNightly();
    const before = await readFile(f.databasePath);
    const result = await f.run();
    assert.equal(result.metrics.aiActiveDurationMs, expected);
    const published = f.db.prepare(`SELECT COALESCE(SUM(json_extract(value_json,'$.durationMs')),0) duration
      FROM ai_usage_report_rows WHERE tenant_id=1 AND user_id=7 AND dataset='turns' AND stat_date='2026-09-11'`).get().duration;
    assert.equal(result.metrics.aiActiveDurationMs, published);
    const sql = f.db.prepare(`SELECT COALESCE(SUM(json_extract(value_json,'$.generatedLines')),0) lines
      FROM ai_usage_report_rows WHERE tenant_id=1 AND user_id=7 AND dataset='sql_generations' AND stat_date='2026-09-11'`).get().lines;
    assert.equal(result.metrics.generatedSqlLines, sql);
    assert.deepEqual(await readFile(f.databasePath), before);
    return result;
  };
  await compare(60000); // The 600-second capture contributes no duration.
  await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify({ ...request('foreign-request'), sessionId: 'foreign-session' })}\n`);
  const foreign = await compare(60000);
  assert.equal(foreign.skipped.native_session_mismatch, 1);
  assert.equal(foreign.durationDiagnostics.counted, 1);
  await writeFile(file, `${await readFile(file, 'utf8')}{"type":"user","uuid":"unfinished`);
  const partial = await compare(60000);
  assert.equal(partial.skipped.unterminated_jsonl_tail, 1);
  assert.equal(partial.durationDiagnostics.counted, 1);
  await f.native([
    ...historyTurn('cross-day', '2026-09-10T15:59:00.000Z', '2026-09-10T16:02:00.000Z', fence('SELECT 2;')),
    request('broken', at), '{broken', completedReply('untrusted', fence('SELECT 3;'), '2026-09-11T02:01:00.000Z'),
    ...historyTurn('healthy', '2026-09-11T03:00:00.000Z', '2026-09-11T03:02:00.000Z', fence('SELECT 4;')),
    request('sidecar-user', '2026-09-11T04:00:00.000Z'), reply('sidecar-final', fence('SELECT 5;'), '2026-09-11T04:01:00.000Z'),
  ]);
  const incomplete = await compare(240000);
  assert.equal(incomplete.skipped.malformed_jsonl, 1);
  const markerDirectory = path.join(path.dirname(file), identity.sessionId);
  await mkdir(markerDirectory, { recursive: true });
  await writeFile(path.join(markerDirectory, 'completed-replies.jsonl'),
    `${JSON.stringify({ version: 1, sourceMessageUuid: 'sidecar-final', completedAt: '2026-10-01T00:00:00Z' })}\n`);
  const completed = await compare(300000);
  assert.ok(completed.durationRecords.some(record => record.completionEvidence === 'completed_reply'));
  assert.equal(f.db.prepare("SELECT terminal_status FROM ai_usage_turn_facts WHERE turn_key='captured-ten-minutes'").get().terminal_status, 'completed');
});


test('audit and nightly choose one whole turn source before status and dates, then recover the fallback after deletion', async t => {
  const f = await fixture(t);
  const runNightly = await nightlyFixture(f);
  f.session();
  const start = '2026-09-10T15:59:00.000Z';
  const fallback = await f.native(historyTurn('shared-turn', start, '2026-09-10T16:02:00.000Z'));
  const preferredDirectory = path.join(path.dirname(path.dirname(fallback)), 'a-preferred-project');
  await mkdir(preferredDirectory, { recursive: true });
  const preferred = path.join(preferredDirectory, path.basename(fallback));
  const writePreferred = entries => writeFile(preferred, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const compare = async (expected, range = { from: '2026-09-10', to: '2026-09-11' }) => {
    const before = await readFile(f.databasePath);
    const result = await f.run(range);
    const published = f.db.prepare(`SELECT COALESCE(SUM(json_extract(value_json,'$.durationMs')),0) duration
      FROM ai_usage_report_rows WHERE tenant_id=1 AND user_id=7 AND dataset='turns' AND stat_date BETWEEN ? AND ?`)
      .get(range.from, range.to).duration;
    assert.equal(result.metrics.aiActiveDurationMs, expected);
    assert.equal(published, expected);
    assert.deepEqual(await readFile(f.databasePath), before);
    return result;
  };
  const pending = [request('shared-turn-user', start), reply('shared-turn-assistant', 'Still working', '2026-09-10T16:01:00.000Z')];
  for (const [expectedStatus, entries] of [
    ['failed', [...pending, { type: 'result', subtype: 'error', is_error: true }]],
    ['incomplete', pending],
  ]) {
    await writePreferred(entries);
    await runNightly();
    const result = await compare(0);
    assert.equal(result.durationDiagnostics[expectedStatus], 1);
    assert.equal(result.durationDiagnostics.duplicate_source, 2, 'both old date slices lose to the noncompleted source');
    assert.equal(result.durationRecords.find(record => record.path === preferred).status, expectedStatus);
    assert.ok(result.durationRecords.filter(record => record.path === fallback).every(record => record.status === 'duplicate_source'));
  }
  await writePreferred(historyTurn('shared-turn', start, '2026-09-10T16:00:00.000Z'));
  await runNightly();
  const shortened = await compare(60000);
  assert.equal(shortened.durationDiagnostics.counted, 1);
  assert.equal(shortened.durationDiagnostics.duplicate_source, 2);
  assert.equal(shortened.sources.find(source => source.path === preferred).countedDurationMs, 60000);
  assert.equal(shortened.sources.find(source => source.path === fallback).countedDurationMs, 0);
  const nextDay = await compare(0, { from: '2026-09-11', to: '2026-09-11' });
  assert.equal(nextDay.durationDiagnostics.out_of_range, 1, 'source choice is made before range filtering');
  await rm(preferred);
  await runNightly();
  const restored = await compare(180000);
  assert.equal(restored.durationDiagnostics.counted, 2);
  assert.equal(restored.sources.find(source => source.path === fallback).countedDurationMs, 180000);
  await compare(120000, { from: '2026-09-11', to: '2026-09-11' });
});


const runTenant = (f, options = {}) => auditTenantUsage({ databasePath: f.databasePath, tenantId: 1,
  from: '2026-09-11', to: '2026-09-11', ...options });
const tenantArguments = f => [script, '--db', f.databasePath, '--tenant-id', '1',
  '--from', '2026-09-11', '--to', '2026-09-11', '--time-zone', 'Asia/Shanghai'];

test('tenant audit unions current members and original historical owners without scanning unrelated users or tenants', async t => {
  const f = await fixture(t);
  f.db.exec(`CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER,status TEXT);
    INSERT INTO users VALUES(9,'no-records'),(10,'foreign-only'),(11,'unrelated'),(12,'database-history'),
      (13,'session-history'),(14,'capture-history'),(15,'empty-history'),(18,'disabled-member'),(19,'pending-member');
    INSERT INTO tenant_users VALUES(1,7,'active'),(1,9,'active'),(1,18,'disabled'),(1,19,'pending'),(2,10,'active');`);
  f.session(); f.turn('captured');
  await f.native(historyTurn('member', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;\nSELECT 2;')));
  await f.native(historyTurn('former-member', at, '2026-09-11T02:02:00.000Z', fence('SELECT 1;\nSELECT 2;\nSELECT 3;')), { userId: 8 });
  await f.native(historyTurn('foreign-copy', at, '2026-09-11T02:30:00.000Z', fence('SELECT 99;')),
    { tenantId: 2, workspaceId: 20, userId: 7, sessionId: 'foreign-session' });
  f.message(reply('database-only', fence('SELECT 1;')), { userId: 12, provider: 'codex' });
  f.message(reply('foreign-only', fence('SELECT 99;')), { tenantId: 2, workspaceId: 20, userId: 10 });
  f.session({ userId: 13 });
  f.turn('only-capture', at, '2026-09-11T02:20:00.000Z', { userId: 14 });
  await f.native([], { userId: 15 });
  const result = await runTenant(f);
  assert.equal(result.auditVersion, 4);
  assert.equal(result.mode, 'tenant');
  assert.equal(result.status, 'completed');
  assert.equal(result.failedUsers, 0);
  assert.equal(result.successfulUsers, 9);
  assert.equal(result.userCount, 9);
  assert.deepEqual(result.users.map(user => user.userId), [7, 8, 9, 12, 13, 14, 15, 18, 19]);
  for (const user of result.users) {
    const single = await f.run({ userId: user.userId });
    assert.deepEqual(user.metrics, { ...single.metrics, aiActiveDurationHours:
      single.metrics.aiActiveDurationSeconds === null ? null : single.metrics.aiActiveDurationSeconds / 3600 });
    assert.deepEqual(user.coverage, single.coverage);
    assert.deepEqual(user.scanned, single.scanned);
    assert.equal(user.error, null);
  }
  assert.deepEqual(result.users.slice(0, 2).map(user => [user.metrics.aiActiveDurationSeconds, user.metrics.generatedSqlLines]), [[60, 2], [120, 3]]);
  assert.equal(result.users.find(user => user.userId === 9).metrics.aiActiveDurationSeconds, null, 'a member without readable history is unavailable, not zero');
  assert.equal(result.users.find(user => user.userId === 9).metrics.generatedSqlLines, 0, 'an available empty message source has zero SQL');
  assert.equal(result.users.find(user => user.userId === 15).metrics.aiActiveDurationSeconds, 0, 'a readable empty main transcript retains the established zero semantics');
});

test('tenant discovery supports history-only databases and reports an empty tenant without importing all users', async t => {
  const f = await fixture(t);
  await f.native(historyTurn('history-only', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')));
  assert.deepEqual((await runTenant(f)).users.map(user => user.userId), [7]);
  const empty = await runTenant(f, { tenantId: 2 });
  assert.deepEqual(empty.users, []);
  assert.equal(empty.userCount, 0);
  assert.equal(empty.status, 'completed');
  f.db.exec('DROP TABLE ai_usage_turn_facts; DROP TABLE session_index; DROP TABLE agent_session_runtime; DROP TABLE agent_session_messages;');
  assert.deepEqual((await runTenant(f)).users, []);
});

test('tenant mode preserves date timezone clipping, SQL suppression and single-user source-scope exclusion rules', async t => {
  const f = await fixture(t);
  f.session();
  f.session({ tenantId: 2, workspaceId: 20 });
  await f.native(historyTurn('conflicted', at, '2026-09-11T02:10:00.000Z', fence('SELECT 99;')));
  f.session({ sessionId: 'healthy' });
  const content = fence('SELECT 1;\nSELECT 2;');
  const records = historyTurn('cross-day', '2026-09-10T15:59:00.000Z', '2026-09-10T16:02:00.000Z', content);
  await f.native(records, { sessionId: 'healthy' });
  f.message(reply('second-user', fence('SELECT 3;')), { userId: 8, provider: 'codex' });
  const scope = { tenant_id: 1, workspace_id: 10, user_id: 7, provider: 'claude', provider_session_id: 'healthy' };
  const sql = parseSqlGeneration(scope, records[1], { timeZone: 'Asia/Shanghai' })[0];
  f.db.exec('CREATE TABLE ai_usage_suppressed_rows(tenant_id INTEGER,dataset TEXT,row_key TEXT)');
  f.db.prepare("INSERT INTO ai_usage_suppressed_rows VALUES(1,'sql_generations',?)").run(sql.row_key);
  const result = await runTenant(f);
  assert.deepEqual(result.users.map(user => [user.userId, user.metrics.aiActiveDurationSeconds, user.metrics.generatedSqlLines]),
    [[7, 120, 0], [8, null, 1]]);
  assert.ok(result.users[0].skipped.SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT > 0);
  assert.equal(result.users[0].skipped.sql_suppressed, 1);
  const utc = await runTenant(f, { timeZone: 'UTC' });
  assert.equal(utc.range.fromInclusive, '2026-09-11T00:00:00.000Z');
  assert.equal(utc.users[0].metrics.aiActiveDurationSeconds, 0);
});

test('a failed historical owner remains an explicit null/error row while healthy users before and after it finish', async t => {
  const f = await fixture(t);
  f.db.exec("INSERT INTO users VALUES(9,'later-user'); DELETE FROM users WHERE id=8;");
  for (const userId of [7, 8, 9]) await f.native(historyTurn(`user-${userId}`, at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')), { userId });
  const result = await runTenant(f);
  assert.deepEqual(result.users.map(user => user.userId), [7, 8, 9]);
  assert.equal(result.status, 'partial_failure');
  assert.equal(result.successfulUsers, 2);
  assert.equal(result.failedUsers, 1);
  assert.deepEqual(result.users.filter(user => user.error === null).map(user => user.metrics.aiActiveDurationSeconds), [60, 60]);
  const failed = result.users[1];
  assert.equal(failed.userName, null);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.metrics, { aiActiveDurationMs: null, aiActiveDurationSeconds: null, aiActiveDurationHours: null, generatedSqlLines: null });
  assert.equal(failed.coverage.duration, 'unavailable');
  assert.equal(failed.coverage.sql, 'unavailable');
  assert.match(failed.error.message, /用户不存在：8/);
});

test('tenant CLI defaults to per-user output and JSON without a user-id and remains strictly read-only', async t => {
  const f = await fixture(t);
  f.db.exec("CREATE TABLE tenant_users(tenant_id INTEGER,user_id INTEGER,status TEXT); INSERT INTO tenant_users VALUES(1,7,'active'),(1,8,'active');");
  const file = await f.native(historyTurn('healthy', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;\nSELECT 2;')));
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  f.db.close();
  const before = { database: await readFile(f.databasePath), native: await readFile(file),
    databaseMtime: (await stat(f.databasePath)).mtimeMs, nativeMtime: (await stat(file)).mtimeMs,
    directory: (await readdir(f.directory)).sort() };
  const text = await execute(process.execPath, tenantArguments(f), { timeout: 10000 });
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /用户ID\t用户名\tAI时长\(秒\)\tAI时长\(小时\)\tSQL行数/);
  assert.match(text.stdout, /7\taudit-user\t60\t0\.0167\t2\t/);
  assert.match(text.stdout, /8\tother-user\t不可用\t不可用\t0\t/);
  const json = await execute(process.execPath, [...tenantArguments(f), '--json'], { timeout: 10000 });
  assert.equal(json.stderr, '');
  const result = JSON.parse(json.stdout);
  assert.equal(result.mode, 'tenant');
  assert.equal(result.users.length, 2);
  assert.equal(result.users[0].metrics.aiActiveDurationHours, 60 / 3600);
  assert.deepEqual(await readFile(f.databasePath), before.database);
  assert.deepEqual(await readFile(file), before.native);
  assert.equal((await stat(f.databasePath)).mtimeMs, before.databaseMtime);
  assert.equal((await stat(file)).mtimeMs, before.nativeMtime);
  assert.deepEqual((await readdir(f.directory)).sort(), before.directory);
  const inspected = new Database(f.databasePath, { readonly: true, fileMustExist: true });
  try { assert.deepEqual(inspected.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), schema); }
  finally { inspected.close(); }
});

test('tenant CLI emits complete JSON and a nonzero partial-failure exit code without losing healthy user results', async t => {
  const f = await fixture(t);
  await f.native(historyTurn('healthy', at, '2026-09-11T02:01:00.000Z', fence('SELECT 1;')));
  f.turn('deleted-owner', at, '2026-09-11T02:01:00.000Z', { userId: 99 });
  f.db.close();
  const before = await readFile(f.databasePath);
  await assert.rejects(execute(process.execPath, [...tenantArguments(f), '--json'], { timeout: 10000 }), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stderr, '');
    const result = JSON.parse(error.stdout);
    assert.equal(result.status, 'partial_failure');
    assert.equal(result.users[0].userId, 7);
    assert.equal(result.users[0].metrics.generatedSqlLines, 1);
    assert.equal(result.users[1].userId, 99);
    assert.equal(result.users[1].metrics.generatedSqlLines, null);
    assert.match(result.users[1].error.message, /用户不存在：99/);
    return true;
  });
  assert.deepEqual(await readFile(f.databasePath), before);
});

test('tenant audit still validates dates, scope and existing database before enumerating users', async t => {
  const f = await fixture(t);
  await assert.rejects(runTenant(f, { tenantId: 999 }), /租户不存在/);
  await assert.rejects(runTenant(f, { from: 'bad-date' }), /日期必须/);
  await assert.rejects(runTenant(f, { from: '2026-09-12' }), /不能晚于/);
  await assert.rejects(runTenant(f, { tenantId: 0 }), /正整数/);
  const missing = path.join(f.directory, 'not-created.db');
  await assert.rejects(runTenant(f, { databasePath: missing }));
  await assert.rejects(stat(missing), { code: 'ENOENT' });
  await assert.rejects(execute(process.execPath, [script, '--db', f.databasePath, '--tenant-id', '1'], { timeout: 10000 }),
    error => error.code === 1 && /缺少 --from/.test(error.stderr));
});
