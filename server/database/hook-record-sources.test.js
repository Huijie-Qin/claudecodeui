import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migrateHookRecordSources } from './hook-config-schema.js';

test('record source migration is idempotent and never trusts historical record JSON', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`CREATE TABLE hook_data_records(id TEXT PRIMARY KEY,tenant_id INTEGER,hook_id TEXT,
      data_json TEXT,created_at TEXT);
      INSERT INTO hook_data_records VALUES ('old',1,'reassigned',
      '{"postActionId":"fake","recordSource":"post_action","hookVersion":7}', '2026-09-10');`);
    migrateHookRecordSources(database);
    migrateHookRecordSources(database);
    assert.deepEqual(database.prepare(`SELECT post_action_id,hook_version,record_source FROM hook_data_records`).get(),
      { post_action_id: null, hook_version: null, record_source: 'unknown' });
  } finally { database.close(); }
});
