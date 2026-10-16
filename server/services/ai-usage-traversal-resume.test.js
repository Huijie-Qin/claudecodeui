import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig } from './ai-usage-config.js';

const fullConfig = readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false' });
const night = '2026-09-11T18:00:00.000Z';
const quiet = { info() {}, warn() {}, error() {} };
const reply = id => ({ uuid: id, type: 'assistant', timestamp: '2026-09-01T02:01:00Z',
  message: { role: 'assistant', content: '```sql\nSELECT 1;\n```', stop_reason: 'end_turn' } });

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-traversal-resume-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await fs.rm(home, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    CREATE TABLE session_index(tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,provider TEXT,provider_session_id TEXT);
    CREATE TABLE agent_session_runtime(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,user_id INTEGER,
      provider TEXT,provider_session_id TEXT,runtime_id TEXT,runtime_home_path TEXT);
    INSERT INTO tenants VALUES(1,'active'); INSERT INTO users VALUES(1,'user');
    INSERT INTO workspaces VALUES(10,1,'workspace','active');`);
  migrateAiUsageSchema(db);
  let runtime = 0;
  async function addSession(sessionId, homeName = 'home', projectName = 'project') {
    const runtimeHome = path.join(home, homeName);
    const project = path.join(runtimeHome, '.claude', 'projects', projectName);
    await fs.mkdir(project, { recursive: true });
    db.prepare("INSERT INTO session_index VALUES(1,10,1,'claude',?)").run(sessionId);
    db.prepare("INSERT INTO agent_session_runtime VALUES(?,1,10,1,'claude',?,?,?)")
      .run(++runtime, sessionId, `runtime-${runtime}`, runtimeHome);
    const file = path.join(project, `${sessionId}.jsonl`);
    await fs.writeFile(file, [
      { uuid: `${sessionId}-request`, type: 'user', timestamp: '2026-09-01T02:00:00Z', message: { role: 'user', content: 'request' } },
      reply(`${sessionId}-answer`),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    return { runtimeHome, project, file, directory: path.join(project, sessionId) };
  }
  const run = (at = night, options = {}) => runAiUsageWindow({ database: db, config: fullConfig,
    now: () => new Date(at), logger: quiet, ...options });
  return { home, db, addSession, run };
}

test('a full rebuild on a slow filesystem advances across windows instead of replaying completed directory prefixes forever', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 30; index++) await f.addSession(`session-${String(index).padStart(3, '0')}`);
  const config = { ...readAiUsageConfig({ AI_USAGE_ENABLED: 'true', AI_USAGE_INCREMENTAL_ENABLED: 'false',
    AI_USAGE_RUN_AT: '02:00', AI_USAGE_WINDOW_END: '02:20' }), leaseMs: 86_400_000 };
  let current;
  let directoryOpens;
  const original = fs.opendir;
  // Virtual I/O cost makes the window exhaustion deterministic without sleeps.
  fs.opendir = async function (directory, ...args) {
    if (String(directory).startsWith(f.home)) {
      directoryOpens++;
      current = new Date(current.getTime() + 60_000);
    }
    return original.call(this, directory, ...args);
  };
  const attempts = [];
  try {
    for (let day = 11; day <= 16; day++) {
      current = new Date(`2026-09-${day}T18:00:00.000Z`);
      directoryOpens = 0;
      const result = await f.run(night, { config, now: () => current });
      const batch = f.db.prepare('SELECT * FROM ai_usage_batches ORDER BY scheduled_for LIMIT 1').get();
      const progress = JSON.parse(batch.progress_json);
      attempts.push({ result, batchId: batch.id, cursor: progress.fileCursor, directoryOpens,
        targetRefreshCount: progress.targetRefreshCount || 0 });
      if (result.published) break;
    }
  } finally { fs.opendir = original; }
  assert.equal(attempts[0].result.status, 'paused');
  assert.equal(attempts[0].cursor[2], 'session-017.jsonl');
  assert.equal(new Set(attempts.map(attempt => attempt.batchId)).size, 1, 'all windows resume the same logical full rebuild');
  assert.equal(attempts.at(-1).result.published, 1, JSON.stringify(attempts));
  assert.ok(attempts.length > 1, 'the fixture must exercise actual cross-window resume');
  assert.ok(attempts.every(attempt => attempt.targetRefreshCount <= 1), 'catchup cannot chase the moving cutoff forever');
  const outcome = f.db.prepare('SELECT status,reason FROM ai_usage_run_logs ORDER BY scheduled_for DESC LIMIT 1').get();
  assert.equal(outcome.status, 'pending', 'a bounded multi-night catchup must not claim a newer window is covered');
  assert.equal(outcome.reason, 'backlog_remaining');
  assert.equal(f.db.prepare('SELECT SUM(ai_active_duration_seconds) total FROM ai_dashboard_ai_detail').get().total, 1800);
  assert.equal(f.db.prepare('SELECT SUM(generated_sql_lines) total FROM ai_dashboard_sql_generation_detail').get().total, 30);
});

test('resuming inside a main session skips older parents but retains its remaining subagents and display sidecar', async t => {
  const f = await fixture(t);
  const priorHome = await f.addSession('prior-home', 'a', 'a');
  const priorProject = await f.addSession('prior-project', 'z', 'a');
  const current = await f.addSession('current', 'z', 'z');
  const subagents = path.join(current.directory, 'subagents');
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, 'agent-a.jsonl'), JSON.stringify(reply('subagent-a')) + '\n');
  await fs.writeFile(path.join(subagents, 'agent-b.jsonl'), JSON.stringify(reply('subagent-b')) + '\n');
  await fs.writeFile(path.join(current.directory, 'display-commands.jsonl'), JSON.stringify({ messageId: 'command', displayCommand: '/analysis' }) + '\n');
  const first = await f.run(night, { shouldStop: () => Boolean(f.db.prepare(`SELECT 1 FROM ai_usage_batch_files
    WHERE source_key LIKE '%/agent-a.jsonl'`).get()) });
  assert.equal(first.status, 'paused');
  const batch = f.db.prepare("SELECT * FROM ai_usage_batches WHERE status='paused'").get();
  assert.equal(JSON.parse(batch.progress_json).fileCursor[3], '1:agent-a.jsonl');
  const opened = [];
  const original = fs.opendir;
  fs.opendir = async function (directory, ...args) { opened.push(String(directory)); return original.call(this, directory, ...args); };
  try { assert.equal((await f.run()).published, 1); }
  finally { fs.opendir = original; }
  assert.ok(!opened.includes(path.join(priorHome.runtimeHome, '.claude', 'projects')), 'a completed earlier home is not reopened');
  assert.ok(!opened.includes(priorProject.project), 'a completed earlier project is not reopened');
  assert.ok(opened.includes(subagents), 'the cursor main session still discovers its later subagents');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_batch_files WHERE batch_id=?').get(batch.id).n, 6);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE source_key LIKE '%/agent-b.jsonl' AND dataset='sql_generations'").get().n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM ai_usage_fact_rows WHERE source_key LIKE '%/display-commands.jsonl' AND dataset='skill_evidence'").get().n, 1);
});

test('a new full batch starts discovery from the beginning and includes newly added earlier homes projects and sessions', async t => {
  const f = await fixture(t);
  await f.addSession('z-session', 'z', 'z');
  assert.equal((await f.run()).published, 1);
  const firstBatch = f.db.prepare('SELECT active_batch_id id FROM ai_usage_tenant_state WHERE tenant_id=1').get().id;
  await f.addSession('a-home', 'a', 'z');
  await f.addSession('a-project', 'z', 'a');
  await f.addSession('a-session', 'z', 'z');
  assert.equal((await f.run('2026-09-12T18:00:00.000Z')).published, 1);
  const secondBatch = f.db.prepare('SELECT active_batch_id id FROM ai_usage_tenant_state WHERE tenant_id=1').get().id;
  assert.notEqual(firstBatch, secondBatch);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ai_usage_batch_files WHERE batch_id=?').get(secondBatch).n, 4);
  assert.equal(f.db.prepare('SELECT SUM(ai_active_duration_seconds) total FROM ai_dashboard_ai_detail').get().total, 240);
  assert.equal(f.db.prepare('SELECT SUM(generated_sql_lines) total FROM ai_dashboard_sql_generation_detail').get().total, 4);
});
