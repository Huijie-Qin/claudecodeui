import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageIndexer } from './ai-usage-indexer.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const INDEX_NAME = 'idx_ai_usage_native_main_session';
const scope = { tenant_id: 1, workspace_id: 10, user_id: 1, provider: 'claude', provider_session_id: 'session-a' };
const sessionKey = logicalSessionKey(scope);
const state = (overrides = {}) => JSON.stringify({ sessionKey, readable: true, isMain: true, ...overrides });

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,provider_timestamp TEXT,created_at TEXT,normalized_json TEXT);
    INSERT INTO users VALUES(1,'alice');
    INSERT INTO workspaces VALUES(10,1,'Example','active');`);
  migrateAiUsageSchema(db);
  const time = '2026-10-15T02:00:00.000Z';
  db.prepare(`INSERT INTO agent_session_messages VALUES(1,1,10,1,'claude','session-a','reply',?,?,?)`)
    .run(time, time, JSON.stringify({ uuid: 'reply', type: 'assistant', timestamp: time,
      message: { role: 'assistant', content: 'SELECT 1;' } }));
  let lookupSql;
  const database = { prepare(sql) {
    if (sql.includes('SELECT 1 FROM ai_usage_source_states') && sql.includes('sessionKey')) lookupSql = sql;
    return db.prepare(sql);
  } };
  const store = { ...createAiUsageStore(db), database, assertLease() {}, checkpoint() {} };
  const indexer = createAiUsageIndexer({ store, config: { timeZone: 'Asia/Shanghai', batchSize: 10 },
    batch: { id: 'lookup-test', tenant_id: 1 }, checkpoint: async () => {}, checkWindow() {} });
  const setState = (key, value, tenantId = 1) => db.prepare(`INSERT INTO ai_usage_source_states(tenant_id,source_key,state_json)
    VALUES(?,?,?) ON CONFLICT(tenant_id,source_key) DO UPDATE SET state_json=excluded.state_json`)
    .run(tenantId, key, value);
  return { db, setState, lookupSql: () => lookupSql,
    async scan() {
      db.prepare("INSERT OR REPLACE INTO ai_usage_source_changes(tenant_id,source_type,source_key) VALUES(1,'message','1')").run();
      await indexer.changedSources({});
      return db.prepare("SELECT COALESCE(SUM(json_extract(value_json,'$.generatedLines')),0) AS n FROM ai_usage_fact_rows WHERE dataset='sql_generations'").get().n;
    } };
}

test('native source lookup uses the session index in the actual indexer query', async (t) => {
  const f = fixture(t);
  f.setState('main', state());
  assert.equal(await f.scan(), 0);
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${f.lookupSql()}`).all(1, sessionKey);
  assert.ok(plan.some(row => row.detail.includes(INDEX_NAME) && row.detail.includes('tenant_id=? AND <expr>=?')),
    JSON.stringify(plan));
  assert.ok(plan.every(row => !row.detail.startsWith('SCAN ')), JSON.stringify(plan));
});

test('native source index follows readability, session, tenant and source changes without caching', async (t) => {
  const f = fixture(t);
  f.setState('malformed', '{invalid legacy JSON');
  f.setState('subagent', state({ isMain: false }));
  f.setState('foreign-tenant', state(), 2);
  f.setState('wrong-session', state({ sessionKey: 'other-session' }));
  f.setState('no-markers', JSON.stringify({ sessionKey }));
  f.setState('string-markers', state({ readable: '1', isMain: '1' }));
  assert.equal(await f.scan(), 1, 'unreadable, subagent, foreign and malformed states must retain the DB fallback');
  f.setState('main', state());
  assert.equal(await f.scan(), 0, 'readable main history suppresses the existing DB contribution');
  f.setState('main', state({ readable: false }));
  assert.equal(await f.scan(), 1);
  f.setState('main', state({ sessionKey: 'moved-session' }));
  assert.equal(await f.scan(), 1);
  f.setState('main', state({ readable: 1, isMain: 1 }));
  assert.equal(await f.scan(), 0, 'legacy numeric markers retain the same semantics as true');
  f.db.prepare("DELETE FROM ai_usage_source_states WHERE tenant_id=1 AND source_key='main'").run();
  assert.equal(await f.scan(), 1, 'removed native sources restore the DB fallback');
});

test('native source index migration retains malformed legacy state and is idempotent', async (t) => {
  const f = fixture(t);
  f.db.exec(`DROP INDEX ${INDEX_NAME}`);
  f.setState('malformed', '{invalid legacy JSON');
  f.setState('main', state());
  f.setState('subagent', state({ isMain: false }));
  const before = f.db.prepare('SELECT * FROM ai_usage_source_states ORDER BY tenant_id,source_key').all();
  assert.doesNotThrow(() => migrateAiUsageSchema(f.db));
  assert.doesNotThrow(() => migrateAiUsageSchema(f.db));
  assert.deepEqual(f.db.prepare('SELECT * FROM ai_usage_source_states ORDER BY tenant_id,source_key').all(), before);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name=?").get(INDEX_NAME).n, 1);
  assert.equal(await f.scan(), 0);
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${f.lookupSql()}`).all(1, sessionKey);
  assert.ok(plan.some(row => row.detail.includes(INDEX_NAME)), JSON.stringify(plan));
});

test('native source lookup benchmark against the previous tenant-only access path', {
  skip: process.env.AI_USAGE_LOOKUP_BENCHMARK !== 'true',
}, async (t) => {
  const f = fixture(t);
  await f.scan();
  const totalSources = 20000;
  const lookups = 400;
  f.db.transaction(() => {
    for (let index = 0; index < totalSources; index++) {
      f.setState(`source-${String(index).padStart(6, '0')}`, state({ sessionKey: `session-${index}` }));
    }
  })();
  const indexed = f.db.prepare(f.lookupSql());
  // Force the original PK access path while retaining the same guarded predicate.
  const tenantOnly = f.db.prepare(f.lookupSql().replace('FROM ai_usage_source_states',
    'FROM ai_usage_source_states INDEXED BY sqlite_autoindex_ai_usage_source_states_1'));
  const key = index => index % 2 ? 'missing-session' : `session-${totalSources - 1}`;
  for (let index = 0; index < 100; index++) indexed.get(1, key(index));
  const measure = statement => {
    let matches = 0;
    const start = performance.now();
    for (let index = 0; index < lookups; index++) if (statement.get(1, key(index))) matches++;
    return { elapsedMs: performance.now() - start, matches };
  };
  const baseline = measure(tenantOnly);
  const improved = measure(indexed);
  assert.equal(baseline.matches, lookups / 2);
  assert.equal(improved.matches, baseline.matches);
  t.diagnostic(JSON.stringify({ totalSources, lookups, baseline, improved,
    speedup: baseline.elapsedMs / improved.elapsedMs }));
});
