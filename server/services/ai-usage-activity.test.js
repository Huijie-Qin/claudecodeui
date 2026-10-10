import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';

import { runAiUsageWindow } from './ai-usage-batches.js';
import { readAiUsageConfig, shiftDate } from './ai-usage-config.js';
import { createAiUsageQueryService } from './ai-usage-query.js';

const config = readAiUsageConfig({ AI_USAGE_ENABLED: 'true' });
function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY,tenant_id INTEGER,display_name TEXT,status TEXT);
    INSERT INTO tenants VALUES(1,'active'),(2,'active');
    INSERT INTO users VALUES(1,'alice'),(2,'bob'),(3,'carol');
    INSERT INTO workspaces VALUES(10,1,'first','active'),(11,1,'second','active'),(20,2,'foreign','active');`);
  migrateAiUsageSchema(db);
  const query = createAiUsageQueryService({ db });
  const access = { tenantId: 1, userId: 1, scope: 'tenant', canViewTenant: true };
  let night = '2026-09-11';
  return { db, query, access,
    run: (options = {}) => runAiUsageWindow({ database: db, config, now: () => new Date(`${night}T18:10:00.000Z`), ...options }),
    nextNight: () => { night = shiftDate(night, 1); },
    request(key, date = '2026-09-11', { user = 1, workspace = 10, provider = 'claude', tenant = 1 } = {}) {
      db.prepare(`INSERT INTO ai_usage_turn_facts(turn_key,tenant_id,user_id,workspace_id,session_key,provider,
        started_at,terminal_status,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?)`)
        .run(key, tenant, user, workspace, key, provider, `${date}T02:00:00.000Z`, `${date}T02:00:00.000Z`);
    },
  };
}

test('nightly DAU/MAU deduplicate users across sessions/workspaces/providers and preserve the full rolling window', async (t) => {
  const f = fixture(t);
  f.request('a1'); f.request('a2'); f.request('a-other-workspace', undefined, { workspace: 11, provider: 'codex' });
  f.request('boundary-included', shiftDate('2026-09-11', -29), { user: 2 });
  f.request('boundary-excluded', shiftDate('2026-09-11', -30), { user: 3 });
  f.request('today-excluded', '2026-09-12', { user: 3 });
  f.request('foreign', undefined, { tenant: 2, workspace: 20, user: 3 });
  const result = await f.run();
  assert.equal(result.published, 2, JSON.stringify(result));
  const filter = { from: '2026-09-11', to: '2026-09-11' };
  const overview = f.query.overview(f.access, filter);
  assert.deepEqual([overview.dau, overview.mau, overview.mauFrom], [1, 2, shiftDate('2026-09-11', -29)]);
  assert.throws(() => f.query.overview(f.access, { ...filter, provider: 'codex' }), { code: 'invalidFilter' });
  assert.equal(f.query.overview(f.access, { ...filter, workspaceId: 11 }).dau, 1);
  assert.equal(f.query.overview(f.access, { ...filter, userId: 2 }).dau, 0);
  assert.equal(f.query.overview(f.access, { ...filter, userId: 2 }).mau, 1);
  assert.equal(f.query.overview(f.access, { ...filter, userSearch: 'bob' }).mau, 1);
  const self = { ...f.access, scope: 'self', canViewTenant: false };
  assert.equal(f.query.overview(self, filter).mau, 1);
  assert.throws(() => f.query.overview(self, { ...filter, userId: 2 }), { statusCode: 403 });
  assert.equal(f.query.trend(f.access, filter).items[0].mau, 2);
  assert.ok(f.db.prepare("SELECT COUNT(*) AS n FROM ai_usage_dirty_activity_days WHERE stat_date>='2026-09-12'").get().n > 0);
});

test('a quiet next day still expires the 30th-day membership without a new message', async (t) => {
  const f = fixture(t);
  f.request('today'); f.request('old', shiftDate('2026-09-11', -29), { user: 2 });
  await f.run();
  assert.equal(f.query.overview(f.access).mau, 2);
  f.nextNight(); await f.run();
  const overview = f.query.overview(f.access, { from: '2026-09-12', to: '2026-09-12' });
  assert.deepEqual([overview.dau, overview.mau], [0, 1]);
});

test('late historical changes replace affected rolling days and reject stale batch queries', async (t) => {
  const f = fixture(t);
  f.request('recent'); f.request('late', '2026-09-01', { user: 2 });
  await f.run();
  const oldBatch = f.query.status(f.access).batchId;
  assert.equal(f.query.overview(f.access).mau, 2);
  f.db.prepare('DELETE FROM ai_usage_turn_facts WHERE turn_key=?').run('late');
  f.nextNight(); await f.run();
  const trend = f.query.trend(f.access, { from: '2026-09-01', to: '2026-09-12' });
  assert.equal(trend.items.find((row) => row.date === '2026-09-01').mau, 0);
  assert.equal(trend.items.find((row) => row.date === '2026-09-11').mau, 1);
  assert.equal(trend.items.find((row) => row.date === '2026-09-12').dau, 0);
  assert.throws(() => f.query.overview(f.access, { batchId: oldBatch }), { code: 'reportUpdated', statusCode: 409 });
});

test('activity membership pagination pauses atomically and resumes without double counting', async (t) => {
  const f = fixture(t);
  f.request('one'); await f.run();
  const old = f.query.status(f.access).batchId;
  f.request('two', '2026-09-12', { user: 2 }); f.nextNight();
  const small = { ...config, batchSize: 1 };
  const paused = await f.run({ config: small, shouldStop: () => {
    const current = f.db.prepare("SELECT progress_json FROM ai_usage_batches WHERE status='running'").get();
    return Boolean(current && JSON.parse(current.progress_json).activity?.cursor);
  } });
  assert.equal(paused.status, 'paused');
  assert.equal(f.query.status(f.access).batchId, old);
  assert.equal(f.query.overview(f.access).mau, 1);
  assert.equal((await f.run({ config: small })).published, 2);
  assert.deepEqual([f.query.overview(f.access).dau, f.query.overview(f.access).mau], [1, 2]);
});

test('old batches expose unavailable activity rather than invented zero, while new empty dates expose zero', async (t) => {
  const f = fixture(t);
  assert.equal(f.query.overview(f.access).dau, null);
  await f.run();
  const newBatch = f.query.status(f.access).batchId;
  assert.deepEqual([f.query.overview(f.access).dau, f.query.overview(f.access).mau], [0, 0]);
  f.db.prepare("UPDATE ai_usage_batches SET coverage_json='{}' WHERE id=?").run(newBatch);
  assert.deepEqual([f.query.overview(f.access).dau, f.query.overview(f.access).mau], [null, null]);
  f.db.exec('DELETE FROM ai_dashboard_split_state');
  assert.throws(() => f.query.overview(f.access), { code: 'splitNotReady' });
  migrateAiUsageSchema(f.db); // Upgrade the old published snapshot without inventing activity coverage.
  assert.deepEqual([f.query.overview(f.access).dau, f.query.overview(f.access).mau], [null, null]);
  assert.ok(f.query.trend(f.access, { from: '2026-09-10', to: '2026-09-11' }).items.every((row) => row.dau === null));
});
