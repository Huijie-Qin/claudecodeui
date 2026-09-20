// Generates a portable report from fresh synthetic data only. Never opens a file database.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { seedAiUsageSimulation, simulationCounts, simulationNight } from '../../server/services/ai-usage-simulation-fixture.js';
import { runAiUsageWindow } from '../../server/services/ai-usage-batches.js';
import { readAiUsageConfig } from '../../server/services/ai-usage-config.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: node snapshot.mjs OUTPUT.json');
const db = new Database(':memory:');
try {
  seedAiUsageSimulation(db);
  const result = await runAiUsageWindow({ database: db, config: readAiUsageConfig({ AI_USAGE_ENABLED: 'true' }), now: simulationNight });
  assert.equal(result.published, 1);
  db.exec("UPDATE tenants SET status='active' WHERE id=20");
  const names = ['tenants', 'users', 'tenant_users', 'workspaces', 'ai_usage_batches', 'ai_usage_tenant_state',
    'ai_usage_report_rows', 'ai_usage_suppressed_rows', 'ai_dashboard_integration_detail'];
  // Only public report projections and minimal mock identities, not raw messages,
  // hook payloads, credentials, worker queues, or the business database.
  const tables = names.map((name) => {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql;
    const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
    const rows = db.prepare(`SELECT * FROM ${name}`).all().map((row) => {
      if (name === 'ai_usage_batches') Object.assign(row, { lease_token: null, lease_until: null, progress_json: '{}', error: null });
      if (name === 'ai_usage_tenant_state') row.bootstrap_json = '{}';
      return columns.map((column) => row[column]);
    });
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(name).map((row) => row.sql);
    return { name, schema, columns, rows, indexes };
  });
  const snapshot = { kind: 'ai-usage-synthetic-only', version: 1, dataThrough: '2026-09-12', counts: simulationCounts, tables };
  await writeFile(destination, JSON.stringify(snapshot), { flag: 'wx' });
  console.log(JSON.stringify({ destination, rows: tables.map(({ name, rows }) => [name, rows.length]) }));
} finally { db.close(); }
