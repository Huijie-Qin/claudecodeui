import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { parseSqlGeneration, sqlOutputMetrics } from './ai-usage-sql.js';
import { fixture } from './ai-usage-test-fixture.js';
import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';

const scope = { tenant_id: 10, workspace_id: 7, user_id: 3, provider: 'claude', provider_session_id: 's1' };
const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
const at = '2026-09-11T16:01:00Z';
const reply = (id, content, timestamp = at) => ({ uuid: id, timestamp, type: 'assistant', message: { role: 'assistant', content } });
const fence = sql => `\`\`\`sql\n${sql}\n\`\`\``;

test('SQL formats count physical lines, not statements, and remove duplicate snippets within one reply', () => {
  const cases = [
    [fence('\n-- comment\nSELECT 1;\n\nSELECT 2;\n'), 4],
    ['```PostgreSQL\r\nSELECT 1;\r\nFROM example;\r\n```', 2],
    ['~~~~mysql\nSELECT 1;\n~~~~', 1],
    ['```\nSELECT 1;\n```', 1],
    ['```json\n{"sql":"SELECT 1;\\nSELECT 2;"}\n```', 2],
    ['{"queries":[{"query":"SELECT 1;"},{"statement":"SELECT 2;"}]}', 2],
    ['<sql>SELECT 1;\nSELECT 2;</sql>', 2],
    ['可执行 `SELECT 1;`。', 1],
    ['SQL：SELECT *\nFROM sample\nWHERE id = 1;\n这里是解释，不算代码。', 3],
    ['WITH cte AS (\n  SELECT 1\n)\nSELECT * FROM cte;', 4],
    [`${fence('SELECT 1;')}\n\n另一次展示：\`SELECT 1;\``, 1],
    ['```python\nSELECT = 10\n```', 0],
    ['```sql\nSELECT 1;', 0],
    ['普通回复，没有 SQL。', 0],
  ];
  for (const [text, count] of cases) assert.equal(sqlOutputMetrics(text).generatedLines, count, text);
});

test('assistant output keeps stable scoped identities and Shanghai dates without persisting its contents', () => {
  const raw = reply('a', fence('SELECT 1;'));
  const [row] = parseSqlGeneration(scope, raw);
  assert.equal(row.stat_date, '2026-09-12');
  assert.equal(row.value.generatedLines, 1);
  assert.equal(row.row_key, parseSqlGeneration(scope, raw)[0].row_key);
  assert.notEqual(row.row_key, parseSqlGeneration({ ...scope, user_id: 4 }, raw)[0].row_key);
  assert.notEqual(row.row_key, parseSqlGeneration(scope, raw, { subagentId: 'child' })[0].row_key);
  assert.ok(!JSON.stringify(row).includes('SELECT 1'), 'no SQL text stored');
  const native = reply('b', [{ type: 'text', text: fence('SELECT 2;') },
    { type: 'thinking', thinking: fence('SELECT 3;') }, { type: 'tool_use', input: { sql: 'SELECT 4;' } },
    { type: 'tool_result', content: fence('SELECT 5;') }]);
  assert.equal(parseSqlGeneration(scope, native)[0].value.generatedLines, 3);
  for (const message of [
    { ...raw, type: 'user', message: { role: 'user', content: fence('SELECT 1;') } },
    { ...raw, inherited: true }, { ...raw, forkedFrom: {} }, { ...raw, isMeta: true },
    { id: 'b', timestamp: at, role: 'assistant', kind: 'tool_result', content: fence('SELECT 1;') },
    { id: 'b', timestamp: at, role: 'assistant', kind: 'stream_delta', content: fence('SELECT 1;') },
  ]) assert.deepEqual(parseSqlGeneration(scope, message), []);
  assert.equal(parseSqlGeneration(scope, { id: 'b', timestamp: at, role: 'assistant', kind: 'text', content: fence('SELECT 1;') })[0].value.generatedLines, 1);
  for (const provider of ['claude', 'codex', 'gemini', 'cursor']) {
    assert.equal(parseSqlGeneration({ ...scope, provider }, { id: 'normalized', timestamp: at, role: 'assistant', kind: 'text', content: fence('SELECT 1;') })[0].value.generatedLines, 1);
  }
});


test('native assistant text, thinking, reasoning and tool inputs share SQL deduplication across content blocks', () => {
  const query = 'SELECT id\nFROM orders;';
  const raw = reply('all-blocks', [
    { type: 'text', text: fence(query) },
    { type: 'thinking', thinking: fence(query) },
    { type: 'reasoning', text: fence('SELECT 2;') },
    { type: 'tool_use', id: 'tool-a', name: 'query_database', input: { query: query.replace(/\n/g, '\r\n') } },
    { type: 'function_call', name: 'query_database', arguments: JSON.stringify({ sql: 'SELECT 3;' }) },
    { type: 'tool_use', name: 'query_database', input: JSON.stringify({ statement: 'SELECT 3;' }) },
    { type: 'tool_result', content: fence('SELECT 900;') },
    { type: 'text', text: 'No further SQL.' },
  ]);
  const [row] = parseSqlGeneration(scope, raw);
  assert.equal(row.value.generatedLines, 4, 'the same two-line query is counted once across text, thinking and input');
  assert.equal(row.value.sqlBlockCount, 3);
  assert.ok(!JSON.stringify(row).includes('SELECT'), 'only SQL metrics and source identities are stored');
});


test('complete SQL payloads deduplicate plain thinking and malformed text blocks cannot discard healthy SQL', () => {
  const query = 'SELECT 1;\nSELECT 2;';
  const cases = [
    { name: 'plain thinking and structured query', expected: 2, blocks: [
      { type: 'thinking', thinking: query },
      { type: 'tool_use', name: 'query_database', input: { query } },
    ] },
    { name: 'plain thinking and fenced answer', expected: 2, blocks: [
      { type: 'thinking', thinking: query },
      { type: 'text', text: fence(query) },
    ] },
    { name: 'malformed text and healthy thinking', expected: 1, blocks: [
      { type: 'text', text: { toString: 'invalid' } },
      { type: 'thinking', thinking: 'SELECT 3;' },
    ] },
  ];
  for (const { name, expected, blocks } of cases) {
    for (const content of [blocks, [...blocks].reverse()]) {
      const [row] = parseSqlGeneration(scope, reply(name, content));
      assert.equal(row?.value.generatedLines, expected, name);
    }
  }
});

test('normalized thinking and tool messages are assistant output even without an explicit role', () => {
  const cases = [
    { kind: 'thinking', content: fence('SELECT 1;') },
    { kind: 'reasoning', content: fence('SELECT 1;') },
    { kind: 'tool_use', toolName: 'query_database', toolInput: { query: 'SELECT 1;' } },
    { kind: 'tool_call', toolName: 'query_database', toolInput: { sql: 'SELECT 1;' } },
    { kind: 'function_call', name: 'query_database', arguments: JSON.stringify({ statement: 'SELECT 1;' }) },
  ];
  for (const provider of ['claude', 'codex', 'gemini', 'cursor']) {
    for (const message of cases) {
      const raw = { id: `${provider}-${message.kind}`, timestamp: at, ...message };
      const [row] = parseSqlGeneration({ ...scope, provider }, raw);
      assert.equal(row?.value.generatedLines, 1, `${provider}: ${message.kind}`);
      assert.deepEqual(parseSqlGeneration({ ...scope, provider }, { ...raw, role: 'user' }), [],
        `${provider}: an explicitly user-authored ${message.kind} is not output`);
    }
  }
});

test('structured query fields and SQL file writes preserve complete physical lines including blank and comment lines', () => {
  const query = '-- query heading\nWITH cte AS (\nSELECT 1\n)\n\nSELECT *\nFROM cte;';
  const fileContents = '-- generated SQL file\nBEGIN;\n\nSELECT 2;\nCOMMIT;';
  const queryMessages = [
    reply('query-object', [{ type: 'tool_use', name: 'query_database', input: { query } }]),
    reply('sql-array', [{ type: 'tool_use', name: 'query_database', input: { queries: [{ sql: query }] } }]),
    reply('query-json', [{ type: 'function_call', name: 'query_database', arguments: JSON.stringify({ query }) }]),
    { id: 'normalized-query', timestamp: at, kind: 'tool_use', toolName: 'query_database', toolInput: { query } },
  ];
  for (const raw of queryMessages) {
    assert.equal(parseSqlGeneration(scope, raw)[0]?.value.generatedLines, 7, raw.uuid || raw.id);
  }
  for (const raw of [
    reply('write-native', [{ type: 'tool_use', name: 'Write', input: { file_path: '/workspace/report.SQL', content: fileContents } }]),
    { id: 'write-normalized', timestamp: at, kind: 'tool_use', toolName: 'Write', toolInput: { file_path: '/workspace/report.sql', content: fileContents } },
  ]) {
    assert.equal(parseSqlGeneration(scope, raw)[0]?.value.generatedLines, 5, raw.uuid || raw.id);
  }
  const repeated = reply('sql-file-dedup', [
    { type: 'text', text: fence(fileContents) },
    { type: 'thinking', thinking: fence(fileContents) },
    { type: 'tool_use', name: 'Write', input: { file_path: '/workspace/report.sql', content: fileContents } },
  ]);
  const [row] = parseSqlGeneration(scope, repeated);
  assert.equal(row.value.generatedLines, 5);
  assert.equal(row.value.sqlBlockCount, 1);
});

test('SQL collection ignores envelopes, metadata and tool results while retaining healthy blocks next to malformed inputs', () => {
  const raw = {
    ...reply('mixed-validity', [
      { type: 'thinking', thinking: fence('SELECT 1;'), signature: fence('SELECT 901;') },
      { type: 'tool_use', id: 'SELECT 902;', name: 'SELECT 903;', input: { query: 'SELECT 2;' } },
      { type: 'function_call', arguments: '{malformed-json' },
      { type: 'tool_use', input: null },
      { type: 'tool_result', content: fence('SELECT 904;') },
      { type: 'redacted_thinking', data: fence('SELECT 905;') },
      null,
    ]),
    metadata: { sql: 'SELECT 906;' },
    query: 'SELECT 907;',
  };
  raw.message.usage = { sql: 'SELECT 908;' };
  const [row] = parseSqlGeneration(scope, raw);
  assert.equal(row.value.generatedLines, 2);
  assert.equal(row.value.sqlBlockCount, 2);
  for (const kind of ['tool_result', 'stream_delta', 'stream_end', 'status', 'task_notification']) {
    assert.deepEqual(parseSqlGeneration(scope, {
      id: `excluded-${kind}`, timestamp: at, role: 'assistant', kind,
      content: fence('SELECT 1;'), toolInput: { query: 'SELECT 2;' },
    }), [], kind);
  }
  for (const flag of [{ inherited: true }, { forkedFrom: {} }, { isMeta: true }, { is_meta: true }]) {
    assert.deepEqual(parseSqlGeneration(scope, { ...raw, ...flag }), [], JSON.stringify(flag));
  }
});

test('native top-level conversation type controls SQL attribution before nested roles', () => {
  const raw = reply('role-precedence', [{ type: 'tool_use', name: 'query_database', input: { sql: 'SELECT 1;' } }]);
  assert.equal(parseSqlGeneration(scope, { ...raw, message: { ...raw.message, role: 'user' } })[0]?.value.generatedLines, 1);
  assert.deepEqual(parseSqlGeneration(scope, { ...raw, type: 'user', message: { ...raw.message, role: 'assistant' } }), []);
  assert.equal(parseSqlGeneration(scope, { type: 'claude-response', data: raw })[0]?.value.generatedLines, 1);
});

function messagesFixture(t) {
  const f = fixture(t);
  f.db.exec(`UPDATE tenants SET status='inactive' WHERE id=20;
    INSERT INTO workspaces VALUES(7,10,'研发','active');
    CREATE TABLE session_index(tenant_id,workspace_id,user_id,provider,provider_session_id);
    CREATE TABLE agent_session_runtime(tenant_id,workspace_id,user_id,provider,provider_session_id,runtime_id,runtime_home_path);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id,workspace_id,user_id,provider,provider_session_id,message_id,provider_timestamp,created_at,normalized_json,runtime_id,sequence);
    INSERT INTO session_index VALUES(10,7,3,'claude','s1');`);
  migrateAiUsageSchema(f.db);
  const save = (id, message, { user = 3, workspace = 7, provider = 'claude', session = 's1' } = {}) => f.db.prepare(`INSERT INTO agent_session_messages
    VALUES(?,10,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET normalized_json=excluded.normalized_json,provider_timestamp=excluded.provider_timestamp`)
    .run(id, workspace, user, provider, session, message.uuid || message.id, message.timestamp || at, at, JSON.stringify(message), 'runtime', id);
  const run = async (day, extra = {}) => {
    const result = await runAiUsageWindow({ database: f.db, config, now: () => new Date(`2026-09-${day}T18:10:00Z`), ...extra });
    assert.equal(result.errors?.length || 0, 0, JSON.stringify(result)); return result;
  };
  const sum = () => f.queryService.code(f.access).summary?.generatedLines;
  const parity = expected => {
    assert.equal(sum(), expected);
    const old = f.db.prepare("SELECT COALESCE(SUM(json_extract(value_json,'$.generatedLines')),0) AS n FROM ai_usage_report_rows WHERE dataset='sql_generations'").get().n;
    const wide = f.db.prepare('SELECT COALESCE(SUM(generated_sql_lines),0) AS n FROM ai_dashboard_integration_detail').get().n;
    const split = f.db.prepare('SELECT COALESCE(SUM(generated_sql_lines),0) AS n FROM ai_dashboard_sql_generation_detail').get().n;
    assert.deepEqual([old, wide, split], [expected, expected, expected]);
  };
  return { ...f, save, run, sum, parity };
}

test('nightly bootstrap, multi-round append, amendments/deletes, filters and projections do not depend on Hooks', async t => {
  const f = messagesFixture(t);
  f.save(1, reply('a', fence('SELECT 1;\nSELECT 2;')));
  f.save(2, reply('b', 'SELECT 3;'));
  f.save(3, { ...reply('u', fence('SELECT 100;')), type: 'user', message: { role: 'user', content: fence('SELECT 100;') } });
  f.save(4, reply('another-user', fence('SELECT 4;')), { user: 4 });
  f.save(5, reply('future', fence('SELECT 5;'), '2026-09-12T16:01:00Z'));
  assert.equal((await f.run(12)).published, 1); f.parity(4);
  assert.equal(f.queryService.code(f.access, { userSearch: 'member', workspaceSearch: '研发' }).summary.generatedLines, 4);
  assert.equal(f.queryService.code(f.access, { userId: 3 }).summary.generatedLines, 3);
  assert.equal(f.queryService.code(f.access, { from: '2026-09-12', to: '2026-09-12' }).summary.generatedLines, 4);
  assert.equal(f.queryService.code(f.access, { from: '2026-09-11', to: '2026-09-11' }).summary.generatedLines, 0);
  assert.equal((await f.run(12)).published, 0); f.parity(4);
  f.save(1, reply('a', fence('SELECT 1;'))); // correct an already-counted output
  f.save(6, reply('c', fence('SELECT 6;\nSELECT 7;'))); // new round, same session
  f.db.exec('DELETE FROM agent_session_messages WHERE id=2');
  assert.equal(f.sum(), 4, 'published results remain unchanged before the night');
  await f.run(13); f.parity(5);
  await f.run(14); f.parity(5);
  f.save(1, reply('a', '不再输出 SQL'));
  await f.run(15); f.parity(4);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ai_usage_report_rows WHERE dataset='sql_generations'").get().n, 3);
});

test('configurable cutoff includes today for testing, rolls back safely and restores unchanged SQL facts', async t => {
  const f = messagesFixture(t);
  f.save(1, reply('yesterday', fence('SELECT 1;'), '2026-09-11T02:00:00Z'));
  f.save(2, reply('today', fence('SELECT 2;\nSELECT 3;')));
  f.save(3, reply('tomorrow', fence('SELECT 4;\nSELECT 5;\nSELECT 6;\nSELECT 7;'), '2026-09-12T16:01:00Z'));
  await f.run(11); f.parity(1); // Shanghai Sep 12, default T-1.
  const todayConfig = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_DATA_LAG_DAYS: '0' });
  // Changing only the range does not unexpectedly rerun an already-published window.
  assert.equal((await f.run(11, { config: todayConfig })).published, 0);
  f.parity(1);
  await f.run(11, { config: { ...todayConfig, runAt: '02:01' } }); f.parity(3);
  const meta = f.queryService.status(f.access);
  assert.equal(meta.dataThroughDate, '2026-09-12');
  assert.equal(meta.coverage.dataLagDays, 0);
  assert.equal(meta.coverage.partialDay, true);
  await f.run(11, { config: { ...todayConfig, dataLagDays: 2, runAt: '02:02' } }); f.parity(0);
  assert.equal(f.queryService.status(f.access).dataThroughDate, '2026-09-10');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE dataset='sql_generations'").get().n, 3);
  await f.run(11, { config: { ...todayConfig, runAt: '02:03' } }); f.parity(3);
  assert.equal(f.queryService.status(f.access).coverage.partialDay, true);
  await f.run(13); f.parity(7);
  assert.equal(f.queryService.status(f.access).coverage.partialDay, false);
});

test('native transcripts take precedence, survive append/replay/partial tails and are rescanned on definition upgrades', async t => {
  const f = messagesFixture(t);
  const home = await mkdtemp('/private/tmp/ccui-session-sql-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/projects/demo'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 's1.jsonl');
  const original = reply('native-a', fence('SELECT 1;\nSELECT 2;'));
  await writeFile(file, `${JSON.stringify(original)}\n`);
  f.db.prepare("INSERT INTO agent_session_runtime VALUES(10,7,3,'claude','s1','runtime',?)").run(home);
  f.save(1, { id: 'db-copy-with-different-id', timestamp: at, role: 'assistant', kind: 'text', content: fence('SELECT 1;\nSELECT 2;') });
  // Simulate a deployment whose previous job had consumed the transcript under
  // the old definition. The new calculation version must rewind its cursor.
  await f.run(12, { config: { ...config, calculationVersion: 'before-session-sql' } });
  f.db.exec("DELETE FROM ai_usage_fact_rows WHERE dataset='sql_generations'; DELETE FROM ai_usage_report_rows WHERE dataset='sql_generations'; DELETE FROM ai_dashboard_integration_detail; DELETE FROM ai_dashboard_sql_generation_detail;");
  await f.run(13); f.parity(2);
  await appendFile(file, `${JSON.stringify(original)}\n${JSON.stringify({ ...reply('inherited', fence('SELECT 900;')), inherited: true })}\n`);
  const next = JSON.stringify(reply('native-b', fence('SELECT 3;')));
  await appendFile(file, next.slice(0, -3));
  await f.run(14); f.parity(2);
  await appendFile(file, `${next.slice(-3)}\n`);
  await f.run(15); f.parity(3);
  await appendFile(file, `${JSON.stringify(reply('native-a', 'SQL 已移除'))}\n`);
  await f.run(16); f.parity(1);
  await f.run(17); f.parity(1);
  assert.ok(!f.db.prepare("SELECT value_json FROM ai_usage_report_rows WHERE dataset='sql_generations'").get().value_json.includes('SELECT'));
});


test('the all-reply calculation upgrade rebuilds unchanged native and database SQL from the old text-only snapshot', async t => {
  const f = messagesFixture(t);
  const home = await mkdtemp('/private/tmp/ccui-session-sql-upgrade-');
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude/projects/demo'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, 's1.jsonl');
  const native = reply('native-expanded', [
    { type: 'text', text: fence('SELECT 1;') },
    { type: 'thinking', thinking: fence('SELECT 2;\nSELECT 3;') },
    { type: 'tool_use', name: 'query_database', input: { query: 'SELECT id\nFROM orders\nWHERE id = 4;' } },
  ]);
  const transcript = `${JSON.stringify(native)}\n`;
  await writeFile(file, transcript);
  f.db.prepare("INSERT INTO agent_session_runtime VALUES(10,7,3,'claude','s1','runtime',?)").run(home);
  const databaseMessage = { id: 'db-expanded', timestamp: at, kind: 'tool_use', toolName: 'Write',
    toolInput: { file_path: '/workspace/report.sql', content: 'SELECT 5;\nSELECT 6;' } };
  f.save(1, databaseMessage, { provider: 'codex', session: 'db-session' });
  const previousVersion = config.calculationVersion.replace(/_sql_all_reply_v14(?=_|$)/, '');
  assert.notEqual(previousVersion, config.calculationVersion, 'the new SQL definition must bump the calculation version');
  await f.run(12, { config: { ...config, calculationVersion: previousVersion } });
  f.parity(8);
  const nativeRowKey = parseSqlGeneration(scope, native)[0].row_key;
  // Retain the consumed cursors and raw inputs, but simulate the published
  // text-only version: one native line and no contribution from the DB tool.
  for (const table of ['ai_usage_fact_rows', 'ai_usage_report_rows']) {
    f.db.prepare(`DELETE FROM ${table} WHERE dataset='sql_generations' AND row_key<>?`).run(nativeRowKey);
    f.db.prepare(`UPDATE ${table} SET value_json=json_set(value_json,'$.generatedLines',1,'$.sqlBlockCount',1)
      WHERE dataset='sql_generations' AND row_key=?`).run(nativeRowKey);
  }
  f.materialize();
  f.parity(1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_dirty_partitions').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_source_changes').get().n, 0);
  assert.equal(f.db.prepare("SELECT offset FROM ai_usage_source_states WHERE source_key LIKE 'jsonl:%'").get().offset,
    Buffer.byteLength(transcript), 'the native file was already completely consumed');
  const publishedBefore = f.db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=10').get().active_batch_id;
  const upgraded = await f.run(13);
  assert.equal(upgraded.published, 1);
  f.parity(8);
  const current = f.db.prepare(`SELECT b.id,b.calculation_version FROM ai_usage_batches b
    JOIN ai_usage_tenant_state s ON s.active_batch_id=b.id WHERE s.tenant_id=10`).get();
  assert.notEqual(current.id, publishedBefore);
  assert.equal(current.calculation_version, config.calculationVersion);
  assert.equal(await readFile(file, 'utf8'), transcript);
  assert.equal(f.db.prepare('SELECT normalized_json FROM agent_session_messages WHERE id=1').get().normalized_json,
    JSON.stringify(databaseMessage));
  await f.run(14); f.parity(8);
});

test('old Hook-generated snapshots remain until the new session candidate atomically replaces them', async t => {
  const f = messagesFixture(t);
  f.batch('old-batch', 10, 'published', { integrationVersion: 1, generatedSql: 'partial' });
  f.db.exec(`INSERT INTO ai_dashboard_integration_detail(id,tenant_id,stat_date,sql_record_id,generated_sql_lines,refreshed_at) VALUES('legacy',10,'2026-09-12','hook-record',900,'2026-09-13 02:10:00');
    INSERT INTO ai_dashboard_sql_generation_detail(id,tenant_id,stat_date,sql_record_id,generated_sql_lines) VALUES('legacy',10,'2026-09-12','hook-record',900);`);
  f.row({ id: 'hook-record', dataset: 'hook_records', value: { recordType: 'sql_response_metrics', fields: [{ key: 'sqlLineCount', type: 'number', value: 900 }] }, batchId: 'other' });
  f.save(1, reply('a', fence('SELECT 1;')));
  let checks = 0;
  await f.run(13, { shouldStop: () => ++checks > 14 });
  assert.equal(f.sum(), 900, 'a paused batch cannot expose a half-updated metric');
  await f.run(13); f.parity(1);
});
