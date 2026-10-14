import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { auditUserUsage } from '../../scripts/audit-ai-usage-user.mjs';
import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { readAiUsageConfig } from './ai-usage-config.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const scope = { tenant_id: 1, workspace_id: 10, user_id: 1, provider: 'claude', provider_session_id: 'history-a' };
const start = '2026-09-10T02:00:00.000Z';
const user = (id, timestamp = start) => ({ uuid: id, timestamp, type: 'user', message: { role: 'user', content: 'Request' } });
const reply = (id, timestamp, stop = 'end_turn') => ({ uuid: id, timestamp, type: 'assistant', message: {
  role: 'assistant', content: [{ type: 'text', text: '```sql\nSELECT 1;\n```' }], stop_reason: stop,
} });
const lines = messages => messages.map(message => JSON.stringify(message)).join('\n') + '\n';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'ccui-history-duration-'));
  const project = path.join(home, '.claude', 'projects', 'project');
  await mkdir(project, { recursive: true });
  const file = path.join(project, 'history-a.jsonl');
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(home, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,
      provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    INSERT INTO tenants VALUES(1,'active'); INSERT INTO users VALUES(1,'alice');
    INSERT INTO workspaces VALUES(10,1,'Example','active');
    INSERT INTO session_index VALUES(1,10,1,'claude','history-a');`);
  db.prepare("INSERT INTO agent_session_runtime VALUES(1,10,1,'claude','history-a','runtime-a',?)").run(home);
  migrateAiUsageSchema(db);
  let day = 11;
  const now = () => new Date(`2026-09-${day}T18:10:00.000Z`);
  const warnings = [];
  const query = createAiUsageQueryService({ db });
  const access = { tenantId: 1, userId: 1, scope: 'tenant', canViewTenant: true };
  return { db, home, file, query, access, next: () => { day++; },
    write: messages => writeFile(file, lines(messages)), append: messages => appendFile(file, lines(messages)),
    run: options => runAiUsageWindow({ database: db, config, now, logger: { info() {}, error() {}, warn(...args) { warnings.push(args); } }, ...options }),
    rows: () => db.prepare("SELECT * FROM ai_usage_fact_rows WHERE dataset='turns'").all(),
    duration: () => db.prepare('SELECT SUM(ai_active_duration_seconds) AS value FROM ai_session_summary').get().value,
    coverage: () => JSON.parse(db.prepare(`SELECT b.coverage_json FROM ai_usage_batches b JOIN ai_usage_tenant_state s ON s.active_batch_id=b.id`).get().coverage_json),
    raw: () => db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,
      started_at,response_completed_at,terminal_status,updated_at) VALUES('captured',1,1,10,'history-a','claude',?,?, 'completed',?)`)
      .run(start, '2026-09-10T02:10:00.000Z', start), warnings };
}

// Exercises the complete nightly pipeline and published consumers with no
// ai_usage_turn_facts history, rather than only testing a duration arithmetic helper.
test('retained transcript restores historical duration with an empty capture table and unchanged SQL output', async t => {
  const f = await fixture(t);
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z'),
    user('u2', '2026-09-10T09:00:00.000Z'), reply('a2', '2026-09-10T09:02:00.000Z')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 180);
  assert.equal(f.rows().length, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_turn_facts').get().n, 0);
  assert.equal(f.coverage().duration, 'partial');
  assert.equal(f.coverage().durationSource, 'native_transcript');
  assert.equal(f.query.overview(f.access).activeDurationMs, 180000);
  assert.equal(f.query.overview(f.access).dau, 0); // Requests were the previous day.
  assert.equal(f.query.overview(f.access).mau, 1);
  assert.equal(f.db.prepare("SELECT SUM(json_extract(value_json,'$.generatedLines')) n FROM ai_usage_report_rows WHERE dataset='sql_generations'").get().n, 2);
  f.next(); await f.run();
  assert.equal(f.duration(), 180, 'unchanged files are not counted again');
});

test('captures remain unchanged interaction evidence and cannot double count transcript duration', async t => {
  const f = await fixture(t); f.raw();
  const captured = f.db.prepare('SELECT * FROM ai_usage_turn_facts').all();
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z')]);
  assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 60, 'do not add the 600-second online capture');
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_turn_facts').all(), captured);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE source_key='turn:captured' AND dataset='interactions'").get().n, 1);
  await unlink(f.file); f.next(); await f.run();
  assert.equal(f.duration(), null, 'missing files cannot silently switch back to capture timing');
  assert.equal(f.coverage().duration, 'unavailable');
  assert.equal(f.query.summary(f.access).sessionCount, 1, 'live interactions still support session counts');
});

test('sidecar appearing after an unchanged null-stop transcript triggers a rebuild without extending duration', async t => {
  const f = await fixture(t);
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z', null)]);
  await f.run(); assert.equal(f.duration(), null);
  const directory = path.join(path.dirname(f.file), 'history-a'); await mkdir(directory);
  await writeFile(path.join(directory, 'completed-replies.jsonl'), lines([{ version: 1, sourceMessageUuid: 'a1', completedAt: '2026-09-11T12:00:00Z' }]));
  f.next(); await f.run(); assert.equal(f.duration(), 60);
  f.next(); await f.run(); assert.equal(f.duration(), 60);
});

test('append, pause/resume and corrected completion replace all previous day slices', async t => {
  const f = await fixture(t);
  await f.write([user('u1', '2026-09-10T15:59:00.000Z'), reply('a1', '2026-09-10T16:01:00.000Z')]);
  await f.run(); assert.equal(f.duration(), 120);
  assert.deepEqual(f.rows().map(row => [row.stat_date, JSON.parse(row.value_json).durationMs]).sort(), [
    ['2026-09-10', 60000], ['2026-09-11', 60000],
  ]);
  await f.append([reply('a2', '2026-09-10T16:02:00.000Z')]); f.next();
  const before = f.duration();
  const paused = await f.run({ shouldStop: () => Boolean(f.db.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND json_extract(progress_json,'$.fileCursor') IS NOT NULL").get()) });
  assert.equal(paused.status, 'paused'); assert.equal(f.duration(), before, 'published result remains during pause');
  assert.equal((await f.run()).published, 1); assert.equal(f.duration(), 180);
  await f.append([{ type: 'system', subtype: 'error', level: 'error' }]); f.next(); await f.run();
  assert.equal(f.duration(), null, 'late failure withdraws a previously completed candidate');
  assert.equal(f.rows().filter(row => JSON.parse(row.value_json).status === 'completed').length, 0);
});

test('one malformed interval or JSON line cannot erase adjacent valid requests', async t => {
  const f = await fixture(t);
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z'),
    user('bad', '2026-09-10T03:00:00.000Z'), reply('bad-end', 'not-a-time'),
    user('u2', '2026-09-10T04:00:00.000Z'), reply('a2', '2026-09-10T04:02:00.000Z')]);
  await f.run(); assert.equal(f.duration(), 180); assert.ok(f.warnings.length);
  await f.append([user('bad-json', '2026-09-10T05:00:00.000Z')]);
  await appendFile(f.file, '{broken json}\n');
  await f.append([reply('orphan', '2026-09-10T05:10:00.000Z'), user('u3', '2026-09-10T06:00:00.000Z'), reply('a3', '2026-09-10T06:01:00.000Z')]);
  f.next(); await f.run(); assert.equal(f.duration(), 240);
});

test('v15 removes orphan old capture duration while rebuilding unchanged files and preserving old snapshot until publication', async t => {
  const f = await fixture(t);
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z')]);
  await f.run(); assert.equal(f.duration(), 60);
  const store = createAiUsageStore(f.db);
  store.put(1, 'turn:lost-raw-row', [{ dataset: 'turns', row_key: 'lost:2026-09-10', stat_date: '2026-09-10',
    user_id: 1, workspace_id: 10, session_key: logicalSessionKey(scope), occurred_at: start,
    value: { provider: 'claude', turnKey: 'lost', status: 'completed', requestStartedAt: start,
      responseCompletedAt: '2026-09-10T02:10:00.000Z', durationMs: 600000 } }]);
  f.db.prepare("UPDATE ai_usage_tenant_state SET calculation_version='old-v14'").run();
  f.next();
  const paused = await f.run({ shouldStop: () => f.db.prepare("SELECT calculation_version FROM ai_usage_tenant_state").get().calculation_version === config.calculationVersion });
  assert.equal(paused.status, 'paused'); assert.equal(f.duration(), 60);
  assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 60);
  assert.equal(f.rows().some(row => row.source_key.startsWith('turn:')), false);
});

test('a suspended MCP continuation retracts an earlier candidate until the main reply resumes', async t => {
  const f = await fixture(t);
  await f.write([user('u1'), reply('a1', '2026-09-10T02:01:00.000Z')]);
  await f.run(); assert.equal(f.duration(), 60);
  await f.append([{ uuid: 'mcp-wrapper', timestamp: '2026-09-10T02:02:00.000Z', type: 'user', isMeta: true,
    message: { role: 'user', content: '<ccui-mcp-loop-results>Results</ccui-mcp-loop-results>' } }]);
  f.next(); await f.run(); assert.equal(f.duration(), null);
  await f.append([reply('resumed', '2026-09-10T02:05:00.000Z')]);
  f.next(); await f.run(); assert.equal(f.duration(), 300);
  assert.equal(f.rows().length, 1, 'a continuation remains one request and one completion');
});


// Source priority applies to the complete logical turn, including its failure
// state and every date slice; choosing independent rows can resurrect stale copies.
test('duplicate history sources let a failed preferred turn withdraw completed copies and recover when it disappears', async t => {
  const f = await fixture(t);
  const run = () => f.run({ config: { ...config, batchSize: 1 } });
  const completed = [user('shared-request'), reply('shared-answer', '2026-09-10T02:01:00.000Z')];
  await f.write(completed);
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 60);
  const preferredDirectory = path.join(f.home, '.claude', 'projects', 'a-preferred');
  await mkdir(preferredDirectory, { recursive: true });
  const preferred = path.join(preferredDirectory, path.basename(f.file));
  await writeFile(preferred, lines([...completed, { type: 'system', subtype: 'error', level: 'error' }]));
  f.next();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), null, 'the selected failed turn must suppress the older completed copy');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_report_rows WHERE dataset='turns' AND json_extract(value_json,'$.status')='completed'").get().n, 0);
  await unlink(preferred);
  f.next();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 60, 'the retained completed source becomes eligible when the preferred file disappears');
});

test('duplicate history sources select one whole cross-day interval and remove stale dates after a shorter revision', async t => {
  const f = await fixture(t);
  const run = () => f.run({ config: { ...config, batchSize: 1 } });
  const request = user('cross-day-request', '2026-09-10T15:59:00.000Z');
  await f.write([request, reply('cross-day-answer', '2026-09-10T16:01:00.000Z')]);
  const publishedSlices = () => f.db.prepare("SELECT stat_date,json_extract(value_json,'$.durationMs') AS duration FROM ai_usage_report_rows WHERE dataset='turns' AND json_extract(value_json,'$.status')='completed' ORDER BY stat_date").all();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 120);
  assert.deepEqual(publishedSlices(), [{ stat_date: '2026-09-10', duration: 60000 }, { stat_date: '2026-09-11', duration: 60000 }]);
  const preferredDirectory = path.join(f.home, '.claude', 'projects', 'a-preferred');
  await mkdir(preferredDirectory, { recursive: true });
  const preferred = path.join(preferredDirectory, path.basename(f.file));
  await writeFile(preferred, lines([request, reply('cross-day-answer', '2026-09-10T15:59:30.000Z')]));
  f.next();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 30, 'the shorter preferred interval replaces the whole two-day interval');
  assert.deepEqual(publishedSlices(), [{ stat_date: '2026-09-10', duration: 30000 }],
    'the old second-day slice must be requeued even though the new source never had that date');
  await unlink(preferred);
  f.next();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 120);
  assert.deepEqual(publishedSlices(), [{ stat_date: '2026-09-10', duration: 60000 }, { stat_date: '2026-09-11', duration: 60000 }],
    'removing the preferred source must restore every date from the surviving source');
});


test('one-row partition pages skip a losing history slice without hiding later valid turns', async t => {
  const f = await fixture(t);
  const run = () => f.run({ config: { ...config, batchSize: 1 } });
  const candidates = [
    [user('page-first', '2026-09-10T03:00:00.000Z'), reply('page-first-answer', '2026-09-10T03:01:00.000Z')],
    [user('page-second', '2026-09-10T04:00:00.000Z'), reply('page-second-answer', '2026-09-10T04:01:00.000Z')],
  ];
  await f.write(candidates.flat());
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 120);
  // Choose the existing earlier SQL row key so its losing copy really precedes
  // another valid turn on the same partition's next page.
  const first = [...f.rows()].sort((a, b) => a.row_key < b.row_key ? -1 : 1)[0];
  const replaced = candidates.find(([request]) => request.timestamp === first.occurred_at);
  assert.ok(replaced);
  const preferredDirectory = path.join(f.home, '.claude', 'projects', 'a-preferred');
  await mkdir(preferredDirectory, { recursive: true });
  await writeFile(path.join(preferredDirectory, path.basename(f.file)),
    lines([...replaced, { type: 'system', subtype: 'error', level: 'error' }]));
  f.next();
  assert.equal((await run()).published, 1);
  assert.equal(f.duration(), 60, 'a rejected first row must not terminate pagination before the healthy later turn');
  assert.equal(f.db.prepare("SELECT SUM(json_extract(value_json,'$.durationMs')) AS duration FROM ai_usage_report_rows WHERE dataset='turns' AND json_extract(value_json,'$.status')='completed'").get().duration, 60000);
});


test('an unsupported calendar boundary cannot interrupt adjacent valid historical turns', async t => {
  const f = await fixture(t);
  await f.write([
    user('calendar-before', '2026-09-10T02:00:00.000Z'), reply('calendar-before-answer', '2026-09-10T02:01:00.000Z'),
    user('calendar-invalid', '0001-01-01T00:00:00.000Z'), reply('calendar-invalid-answer', '0001-01-01T00:01:00.000Z'),
    user('calendar-after', '2026-09-10T04:00:00.000Z'), reply('calendar-after-answer', '2026-09-10T04:01:00.000Z'),
  ]);
  const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.published, 1);
  assert.equal(f.duration(), 120, 'an unrepresentable calendar boundary must preserve both valid one-minute turns');
  assert.equal(f.rows().filter(row => JSON.parse(row.value_json).status === 'completed').length, 2);
  assert.ok(f.warnings.length > 0, 'the rejected historical boundary remains diagnosable');
});


// Snapshot only the fixture DB so the audit exercises its normal read-only CLI
// library path against exactly the same retained histories as the nightly job.
async function auditDuration(f) {
  const databasePath = path.join(f.home, 'audit.db');
  await writeFile(databasePath, f.db.serialize());
  const audit = await auditUserUsage({ databasePath, tenantId: 1, userId: 1,
    from: '2026-09-10', to: '2026-09-10' });
  return audit.metrics.aiActiveDurationSeconds;
}

test('an oversized unfinished tail preserves completed duration until its newline across nightly batches', async t => {
  const f = await fixture(t);
  f.db.exec('ALTER TABLE agent_session_runtime ADD COLUMN id INTEGER');
  await f.write([
    user('retained'), reply('retained-answer', '2026-09-10T02:01:00.000Z'),
    user('damaged', '2026-09-10T03:00:00.000Z'), reply('damaged-answer', '2026-09-10T03:02:00.000Z'),
  ]);
  await f.run(); assert.equal(f.duration(), 180);
  const oversized = JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) });
  await appendFile(f.file, oversized);
  f.next(); assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 180, 'an unfinished tail must not withdraw its preceding completion');
  assert.equal(await auditDuration(f), f.duration());
  assert.equal(f.warnings.length, 0);
  assert.equal(JSON.parse(f.db.prepare('SELECT state_json FROM ai_usage_source_states').get().state_json).skipLine, true);
  f.next(); assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 180, 'restoring the saved skipLine must wait for the delimiter');
  assert.equal(await auditDuration(f), f.duration());
  await appendFile(f.file, '\n');
  await f.append([user('later', '2026-09-10T04:00:00.000Z'), reply('later-answer', '2026-09-10T04:03:00.000Z')]);
  f.next(); assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 240, 'only the damaged current turn is removed; both adjacent turns survive');
  assert.equal(await auditDuration(f), f.duration());
  assert.equal(f.warnings.length, 1);
  assert.equal(f.warnings[0][1].reason, 'AI_USAGE_OVERSIZED_HISTORY_LINE');
  assert.equal(JSON.parse(f.db.prepare('SELECT state_json FROM ai_usage_source_states').get().state_json).skipLine, false);
});

test('a legal JSON line of exactly the size limit is accepted after its delayed newline', async t => {
  const f = await fixture(t);
  f.db.exec('ALTER TABLE agent_session_runtime ADD COLUMN id INTEGER');
  await f.write([user('first'), reply('first-answer', '2026-09-10T02:01:00.000Z'),
    user('large', '2026-09-10T03:00:00.000Z')]);
  await f.run(); assert.equal(f.duration(), 60);
  const large = reply('large-answer', '2026-09-10T03:02:00.000Z');
  large.message.content = [{ type: 'text', text: '' }];
  large.message.content[0].text = 'x'.repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(large)));
  const exactLine = JSON.stringify(large);
  assert.equal(Buffer.byteLength(exactLine), 2 * 1024 * 1024);
  await appendFile(f.file, exactLine);
  f.next(); assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 60);
  assert.equal(await auditDuration(f), f.duration());
  assert.equal(JSON.parse(f.db.prepare('SELECT state_json FROM ai_usage_source_states').get().state_json).skipLine, false);
  await appendFile(f.file, '\n');
  f.next(); assert.equal((await f.run()).published, 1);
  assert.equal(f.duration(), 180, 'the size limit excludes the newline, matching the audit reader');
  assert.equal(await auditDuration(f), f.duration());
  assert.equal(f.warnings.length, 0);
});
