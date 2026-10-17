import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { AiUsageWindowClosed } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';
import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageIndexer } from './ai-usage-indexer.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const now = () => new Date('2026-09-12T18:10:00.000Z');
const scope = { tenant_id: 1, workspace_id: 10, user_id: 1, provider: 'claude', provider_session_id: 'source-page' };
const message = id => ({ type: 'user', uuid: `request-${id}`, timestamp: '2026-09-10T02:00:00.000Z',
  message: { role: 'user', content: 'Please help with a query' } });

function fixture(t, count = 6, batchSize = 200) {
  const statements = [];
  const db = new Database(':memory:', { verbose: sql => statements.push(sql) });
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE agent_session_messages(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,message_id TEXT,provider_timestamp TEXT,created_at TEXT,normalized_json TEXT);
    INSERT INTO tenants VALUES(1,'active');
    INSERT INTO users VALUES(1,'alice');
    INSERT INTO workspaces VALUES(10,1,'Example','active');`);
  migrateAiUsageSchema(db);
  const insert = db.prepare("INSERT INTO agent_session_messages VALUES(?,1,10,1,'claude','source-page',?,'2026-09-10T02:00:00.000Z','2026-09-10T02:00:00.000Z',?)");
  for (let id = 1; id <= count; id++) insert.run(id, `request-${id}`, JSON.stringify(message(id)));
  const config = { ...readAiUsageConfig({ AI_USAGE_ENABLED: 'true' }), batchSize };
  let current = now();
  const base = createAiUsageStore(db, { clock: () => current });
  const batch = base.claim(1, { scheduledFor: '2026-09-12T18:00:00.000Z', targetThrough: '2026-09-11T16:00:00.000Z' }, config);
  const progress = { stage: 'sources' };
  base.checkpoint(batch, progress, config);
  let transactions = 0, beforeTransaction = null, windowCheck = () => {};
  const store = { ...base, transaction(fn) {
    transactions++;
    beforeTransaction?.();
    return base.transaction(fn);
  } };
  const createIndexer = () => createAiUsageIndexer({ store, config, batch,
    checkWindow: () => windowCheck(), checkpoint: async () => base.checkpoint(batch, progress, config) });
  const facts = () => db.prepare("SELECT source_key,row_key,value_json FROM ai_usage_fact_rows WHERE dataset='interactions' ORDER BY source_key,row_key").all();
  const queued = () => db.prepare('SELECT source_key,generation FROM ai_usage_source_changes WHERE tenant_id=1 ORDER BY source_type,source_key').all();
  const saved = () => JSON.parse(db.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=?').get(batch.id).progress_json);
  return { db, config, batch, progress, store, createIndexer, facts, queued, saved, statements,
    transactions: () => transactions,
    setClock: time => { current = time; },
    beforeTransaction: fn => { beforeTransaction = fn; },
    windowCheck: fn => { windowCheck = fn; } };
}

test('source pages reduce write transactions while preserving every message and a durable last cursor', async t => {
  const f = fixture(t, 24, 8);
  await f.createIndexer().changedSources(f.progress);
  assert.equal(f.facts().length, 24);
  assert.deepEqual(f.queued(), []);
  assert.deepEqual(f.saved().sourceCursor, ['message', '9'], 'source identities retain their existing lexicographic traversal');
  assert.deepEqual(f.progress.sourceCursor, f.saved().sourceCursor);
  assert.ok(f.transactions() < 12, `24 messages should not require one transaction each; observed ${f.transactions()}`);
});

test('an ordinary source-write failure rolls back its entire page and cannot persist a cursor beyond rolled-back facts', async t => {
  t.mock.method(performance, 'now', () => 0); // Keep the failure inside one deterministic page.
  const f = fixture(t);
  const before = f.queued();
  f.db.exec(`CREATE TRIGGER fail_second_source BEFORE INSERT ON ai_usage_fact_rows
    WHEN NEW.source_key='message:2' BEGIN SELECT RAISE(ABORT,'source-page-write-failed'); END`);
  await assert.rejects(f.createIndexer().changedSources(f.progress), /source-page-write-failed/);
  assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.queued(), before);
  assert.deepEqual(f.saved(), { stage: 'sources' });
  assert.deepEqual(f.progress, f.saved(), 'in-memory cursor must not skip the page after rollback');
  f.db.exec('DROP TRIGGER fail_second_source');
  await f.createIndexer().changedSources(f.progress);
  assert.equal(f.facts().length, 6);
  assert.equal(new Set(f.facts().map(row => row.row_key)).size, 6);
  assert.deepEqual(f.queued(), []);
});

test('window closure saves a completed source-page prefix and restart resumes without skipping or recounting it', async t => {
  const f = fixture(t);
  f.windowCheck(() => { if (f.facts().length >= 2) throw new AiUsageWindowClosed(); });
  await assert.rejects(f.createIndexer().changedSources(f.progress), AiUsageWindowClosed);
  assert.equal(f.facts().length, 2);
  assert.deepEqual(f.queued().map(row => row.source_key), ['3', '4', '5', '6']);
  assert.deepEqual(f.saved().sourceCursor, ['message', '2']);
  assert.deepEqual(f.progress.sourceCursor, f.saved().sourceCursor);
  const first = f.facts();
  f.windowCheck(() => {});
  const resumed = f.saved();
  Object.assign(f.progress, resumed);
  await f.createIndexer().changedSources(f.progress);
  assert.equal(f.facts().length, 6);
  assert.deepEqual(f.facts().slice(0, 2), first);
  assert.deepEqual(f.queued(), []);
});

test('a newer source generation arriving after page selection remains queued for the next pass', async t => {
  const f = fixture(t, 1);
  const originalGeneration = f.queued()[0].generation;
  let edited = false;
  f.beforeTransaction(() => {
    if (edited) return;
    edited = true;
    f.db.prepare('UPDATE agent_session_messages SET normalized_json=? WHERE id=1').run(JSON.stringify(message('corrected')));
  });
  await f.createIndexer().changedSources(f.progress);
  assert.equal(edited, true);
  assert.equal(f.queued().length, 1, 'deleting only the selected generation must preserve a concurrent correction');
  assert.ok(f.queued()[0].generation > originalGeneration);
  delete f.progress.sourceCursor;
  await f.createIndexer().changedSources(f.progress);
  assert.deepEqual(f.queued(), []);
  assert.equal(f.facts().length, 1);
  assert.match(f.facts()[0].row_key, /request-corrected$/);
});

test('native-preferred empty source results still retract obsolete database facts and mark their old partitions dirty', async t => {
  const f = fixture(t, 1);
  await f.createIndexer().changedSources(f.progress);
  assert.equal(f.facts().length, 1);
  f.db.prepare(`INSERT INTO ai_usage_source_states(tenant_id,source_key,state_json)
    VALUES(1,'jsonl:native',?)`).run(JSON.stringify({ sessionKey: logicalSessionKey(scope), readable: true, isMain: true }));
  f.db.exec("DELETE FROM ai_usage_dirty_partitions; UPDATE agent_session_messages SET message_id=message_id WHERE id=1");
  delete f.progress.sourceCursor;
  await f.createIndexer().changedSources(f.progress);
  assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.queued(), []);
  assert.ok(f.db.prepare("SELECT 1 FROM ai_usage_dirty_partitions WHERE tenant_id=1 AND dataset='interactions' AND stat_date='2026-09-10'").get(),
    'empty native-preferred replacements cannot silently retain an earlier DB contribution');
});


test('a failed page checkpoint rolls back all source writes and keeps the durable and in-memory cursors unchanged', async t => {
  const f = fixture(t);
  const before = f.queued();
  f.db.exec(`CREATE TRIGGER fail_source_checkpoint BEFORE UPDATE OF progress_json ON ai_usage_batches
    WHEN json_extract(NEW.progress_json,'$.sourceCursor') IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'source-checkpoint-failed'); END`);
  await assert.rejects(f.createIndexer().changedSources(f.progress), /source-checkpoint-failed/);
  assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.queued(), before);
  assert.deepEqual(f.saved(), { stage: 'sources' });
  assert.deepEqual(f.progress, f.saved());
  f.db.exec('DROP TRIGGER fail_source_checkpoint');
  await f.createIndexer().changedSources(f.progress);
  assert.equal(f.facts().length, 6);
  assert.deepEqual(f.queued(), []);
});

test('lease expiry during a source page cannot save its processed prefix under the obsolete owner', async t => {
  t.mock.method(performance, 'now', () => 0); // Keep the failure inside one deterministic page.
  const f = fixture(t);
  const before = f.queued();
  f.windowCheck(() => {
    if (f.facts().length < 2) return;
    f.setClock(new Date(now().getTime() + f.config.leaseMs + 1));
    throw new Error('AI_USAGE_LEASE_LOST');
  });
  await assert.rejects(f.createIndexer().changedSources(f.progress), /AI_USAGE_LEASE_LOST/);
  assert.deepEqual(f.facts(), []);
  assert.deepEqual(f.queued(), before);
  assert.deepEqual(f.saved(), { stage: 'sources' });
  assert.deepEqual(f.progress, f.saved());
});


test('native-preferred messages without old source facts avoid replacement scans while an existing source is still retracted', async t => {
  const f = fixture(t, 3);
  const row = (key, date) => ({ dataset: 'interactions', row_key: key, stat_date: date, user_id: 1, workspace_id: 10,
    session_key: logicalSessionKey(scope), occurred_at: `${date}T02:00:00.000Z`, value: { provider: 'claude' } });
  f.store.transaction(() => {
    f.store.put(1, 'retained-native-file', Array.from({ length: 200 }, (_, i) => row(`native-${i}`, '2026-09-10')));
    f.store.put(1, 'message:1', [row('obsolete-db-copy', '2026-09-09')]);
  });
  f.db.prepare(`INSERT INTO ai_usage_source_states(tenant_id,source_key,state_json)
    VALUES(1,'jsonl:native',?)`).run(JSON.stringify({ sessionKey: logicalSessionKey(scope), readable: true, isMain: true }));
  f.db.exec('DELETE FROM ai_usage_dirty_partitions');
  f.statements.length = 0;
  await f.createIndexer().changedSources(f.progress);
  const scans = f.statements.filter(sql => /SELECT DISTINCT/.test(sql) && /FROM ai_usage_fact_rows/.test(sql)
    && /source_key\s*=\s*'message:/.test(sql));
  assert.ok(scans.some(sql => sql.includes("'message:1'")), 'an existing source still needs old partition and turn cleanup');
  assert.ok(!scans.some(sql => /'message:[23]'/.test(sql)), 'native-preferred absent DB sources must not scan old facts for replacement');
  assert.ok(!f.statements.some(sql => /^DELETE FROM ai_usage_fact_rows/.test(sql) && /'message:[23]'/.test(sql)),
    'absent sources also avoid a pointless replacement delete');
  assert.equal(f.facts().length, 200);
  assert.ok(f.facts().every(fact => fact.source_key === 'retained-native-file'));
  assert.deepEqual(f.queued(), []);
  assert.ok(f.db.prepare("SELECT 1 FROM ai_usage_dirty_partitions WHERE tenant_id=1 AND dataset='interactions' AND stat_date='2026-09-09'").get(),
    'the obsolete DB contribution still dirties its former report day');
});
