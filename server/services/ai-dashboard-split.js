import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

import { SPLIT_DETAILS, LEGACY_SPLIT_DETAILS, PREVIOUS_SPLIT_DETAILS, RETIRED_SPLIT_DETAILS, SPLIT_SCHEMA_VERSION, AI_DASHBOARD_SPLIT_SCHEMA_SQL, AI_DASHBOARD_SPLIT_REDACTION_SQL, splitTableDdl } from '../database/ai-dashboard-split-schema.js';

function secondsFromMilliseconds(milliseconds) {
  if (milliseconds == null) return null;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error('AI_SPLIT_DURATION_OVERFLOW');
  const seconds = milliseconds / 1000;
  if (Math.round(seconds * 1000) !== milliseconds) throw new Error('AI_SPLIT_DURATION_PRECISION');
  return seconds;
}

// Input is the EXISTING scalar projection of the old report. No raw business
// source, names lookup or second timezone conversion. Only daily AI consolidation.
export function projectSplitRow(row) {
  // Canonical INPUT still has exactly one fact kind. Only the AI OUTPUT merges
  // daily interactions and completed duration slices, after classifying input.
  if (LEGACY_SPLIT_DETAILS.filter(definition => definition.match(row)).length !== 1) throw new Error('AI_SPLIT_AMBIGUOUS_FACT');
  const matches = SPLIT_DETAILS.filter(definition => definition.match(row));
  if (matches.length !== 1) throw new Error('AI_SPLIT_AMBIGUOUS_FACT');
  const definition = matches[0];
  const values = Object.fromEntries(definition.columns.map(column => [column, row[column] ?? null]));
  if (definition.key === 'ai') {
    if (!row.ai_session_id) throw new Error('AI_SPLIT_SESSION_REQUIRED');
    if (row.ai_active_duration_ms != null && (!Number.isSafeInteger(row.ai_active_duration_ms) || row.ai_active_duration_ms < 0)) {
      throw new Error('AI_SPLIT_INVALID_DURATION');
    }
    values.id = createHash('sha256').update(JSON.stringify(['ai-daily', row.tenant_id, row.stat_date,
      row.user_id ?? null, row.workspace_id ?? null, row.ai_session_id])).digest('hex');
    values.has_ai_interaction = row.has_ai_interaction === 1 ? 1 : 0;
    values.ai_active_duration_seconds = secondsFromMilliseconds(row.ai_active_duration_ms);
  }
  return { definition, values };
}

export function mergeAiDailyRow(previous, incoming) {
  if (!previous) return incoming;
  // Retain millisecond source precision instead of accumulating floating-point
  // drift (0.1 + 0.2). Persist fractional seconds, never truncate to whole seconds.
  const duration = previous.ai_active_duration_seconds == null && incoming.ai_active_duration_seconds == null ? null
    : secondsFromMilliseconds(Math.round((previous.ai_active_duration_seconds ?? 0) * 1000)
      + Math.round((incoming.ai_active_duration_seconds ?? 0) * 1000));
  // Prefer actual interaction time over the original start of a cross-day turn.
  const timeRows = previous.has_ai_interaction === incoming.has_ai_interaction ? [previous, incoming]
    : [previous.has_ai_interaction ? previous : incoming];
  return { ...previous, has_ai_interaction: Math.max(previous.has_ai_interaction, incoming.has_ai_interaction),
    ai_active_duration_seconds: duration, occurred_at: timeRows.map(row => row.occurred_at).filter(Boolean).sort()[0] ?? null,
    user_name: previous.user_name ?? incoming.user_name, workspace_name: previous.workspace_name ?? incoming.workspace_name };
}

// For bounded verification/samples only; the nightly writer below stays paged.
export function collectSplitRows(source) {
  const output = new Map(SPLIT_DETAILS.map(definition => [definition.key, new Map()]));
  for (const row of source) {
    const { definition, values } = projectSplitRow(row);
    const target = output.get(definition.key);
    const key = JSON.stringify([values.tenant_id, values.id]);
    target.set(key, definition.key === 'ai' ? mergeAiDailyRow(target.get(key), values) : values);
  }
  return output;
}

function assertMigrationIdle(db) {
  const now = new Date().toISOString();
  if (db.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE lease_until>?').get(now)
    || db.prepare("SELECT 1 FROM ai_usage_batches WHERE status='running' AND lease_until>?").get(now)) {
    throw new Error('AI_SPLIT_MIGRATION_WORKER_ACTIVE');
  }
}

// Keep each existing row/ID, including paused candidates, while changing the
// declared SQLite affinity to REAL. The outer transaction owns rollback.
function migrateAiSecondsColumns(db) {
  const definition = SPLIT_DETAILS[0];
  for (const staging of [false, true]) {
    const table = staging ? definition.staging : definition.table;
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.some(column => column.name === 'ai_active_duration_ms')) continue;
    assertMigrationIdle(db);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").get(table)) {
      throw new Error(`AI_SPLIT_LEGACY_SCHEMA_CHANGED: custom dependency on ${table}`);
    }
    const temporary = `${table}_seconds_migration`;
    if (db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(temporary)) throw new Error('AI_SPLIT_MIGRATION_NAME_CONFLICT');
    db.exec(splitTableDdl(definition, staging).replace(table, temporary));
    const columns = staging ? ['batch_id', ...definition.columns] : definition.columns;
    db.exec(`INSERT INTO ${temporary} (${columns.join(',')}) SELECT ${columns.map(column => column === 'ai_active_duration_seconds'
      ? 'ai_active_duration_ms / 1000.0' : column).join(',')} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`);
  }
}

// Validate v1/v2 rows against the preserved canonical wide snapshot BEFORE
// rebuilding shared AI/Skill/code table names. Never validate old AI IDs against
// new aggregated IDs, or overwrite an unexpected manual edit before checking it.
export function migrateSplitDetails(db, forceTenants = []) {
  return db.transaction(() => {
    const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const legacy = PREVIOUS_SPLIT_DETAILS.flatMap(definition => [false, true].map(staging => ({
      definition, staging, table: staging ? definition.staging : definition.table,
    }))).filter(item => exists(item.table) && !(item.definition.key === 'ai'
      && db.prepare(`PRAGMA table_info(${item.table})`).all().some(column => column.name === 'ai_active_duration_seconds')));
    const states = exists('ai_dashboard_split_state') ? db.prepare('SELECT * FROM ai_dashboard_split_state').all() : [];
    const retired = legacy.filter(item => RETIRED_SPLIT_DETAILS.some(definition => definition.table === item.definition.table));
    const upgrading = retired.length || states.some(row => row.schema_version !== SPLIT_SCHEMA_VERSION);
    if (upgrading) assertMigrationIdle(db);
    const wideCandidate = db.prepare('SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? AND tenant_id=? AND id=?');
    const wideFormal = db.prepare('SELECT * FROM ai_dashboard_integration_detail WHERE tenant_id=? AND id=?');
    const candidateVersion = db.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=? AND tenant_id=?');
    const previousAi = new Map();
    const v3AiRow = (row, staging, progress) => {
      const scope = JSON.stringify([row.tenant_id, staging ? row.batch_id : null]);
      if (!previousAi.has(scope)) {
        const params = staging ? [row.batch_id, row.tenant_id, progress.split?.ready ? '\uffff' : progress.split?.cursor || ''] : [row.tenant_id];
        const query = staging ? 'SELECT * FROM ai_dashboard_integration_staging WHERE batch_id=? AND tenant_id=? AND id<=?'
          : 'SELECT * FROM ai_dashboard_integration_detail WHERE tenant_id=?';
        const source = db.prepare(`${query} ORDER BY id`).all(...params);
        previousAi.set(scope, collectSplitRows(source).get('ai'));
      }
      const current = previousAi.get(scope).get(JSON.stringify([row.tenant_id, row.id]));
      if (!current) return null;
      return { ...current, batch_id: row.batch_id,
        ai_active_duration_ms: current.ai_active_duration_seconds == null ? null : Math.round(current.ai_active_duration_seconds * 1000) };
    };
    for (const { definition, staging, table } of upgrading ? legacy : []) {
      const columns = staging ? ['batch_id', ...definition.columns] : definition.columns;
      if (!isDeepStrictEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name), columns)) {
        throw new Error(`AI_SPLIT_LEGACY_SCHEMA_CHANGED: ${table}`);
      }
      const keys = staging ? ['batch_id', 'tenant_id', 'id'] : ['tenant_id', 'id'];
      const first = db.prepare(`SELECT * FROM ${table} ORDER BY ${keys.join(',')} LIMIT 500`);
      const next = db.prepare(`SELECT * FROM ${table} WHERE (${keys.join(',')})>(${keys.map(() => '?').join(',')}) ORDER BY ${keys.join(',')} LIMIT 500`);
      for (let page = first.all(); page.length; page = next.all(...keys.map(key => page.at(-1)[key]))) {
        for (const row of page) {
          const progress = staging ? JSON.parse(candidateVersion.get(row.batch_id, row.tenant_id)?.progress_json || '{}') : {};
          const currentVersion = staging ? progress.split?.version
            : states.find(state => state.tenant_id === row.tenant_id)?.schema_version;
          if (currentVersion === SPLIT_SCHEMA_VERSION && !retired.some(item => item.table === table)) continue;
          const current = definition.key === 'ai' && currentVersion === 3 ? v3AiRow(row, staging, progress)
            : staging ? wideCandidate.get(row.batch_id, row.tenant_id, row.id) : wideFormal.get(row.tenant_id, row.id);
          if (!current || !definition.match(current)
            || !isDeepStrictEqual(row, Object.fromEntries(columns.map(column => [column, current[column] ?? null])))) {
            throw new Error(`AI_SPLIT_LEGACY_DATA_MISMATCH: ${table}`);
          }
        }
      }
    }
    migrateAiSecondsColumns(db);
    db.exec(AI_DASHBOARD_SPLIT_SCHEMA_SQL);
    backfillSplitDetails(db, forceTenants);
    db.exec('DROP TRIGGER IF EXISTS ai_dashboard_split_suppress_insert');
    for (const { table } of retired) db.exec(`DROP TABLE ${table}`);
    db.exec(AI_DASHBOARD_SPLIT_REDACTION_SQL);
    return retired.map(item => item.table);
  }).immediate();
}

export function splitWriter(db, staging = false) {
  const writers = new Map(SPLIT_DETAILS.map(definition => {
    const columns = staging ? ['batch_id', ...definition.columns] : definition.columns;
    return [definition.key, db.prepare(`INSERT INTO ${staging ? definition.staging : definition.table} (${columns.join(',')})
      VALUES (${columns.map(column => `@${column}`).join(',')})${definition.key === 'ai'
        ? ` ON CONFLICT(${staging ? 'batch_id,' : ''}tenant_id,id) DO UPDATE SET ${definition.columns.filter(column => !['tenant_id', 'id'].includes(column)).map(column => `${column}=excluded.${column}`).join(',')}` : ''}`)];
  }));
  const aiRead = db.prepare(`SELECT ${SPLIT_DETAILS[0].columns.join(',')} FROM ai_dashboard_ai_${staging ? 'staging' : 'detail'}
    WHERE ${staging ? 'batch_id=? AND ' : ''}tenant_id=? AND id=?`);
  return (row, batchId) => {
    const { definition, values } = projectSplitRow(row);
    const output = definition.key === 'ai' ? mergeAiDailyRow(aiRead.get(...(staging ? [batchId] : []), values.tenant_id, values.id), values) : values;
    writers.get(definition.key).run(staging ? { batch_id: batchId, ...output } : output);
  };
}

export function clearSplitStaging(db, batchId) {
  for (const definition of SPLIT_DETAILS) db.prepare(`DELETE FROM ${definition.staging} WHERE batch_id=?`).run(batchId);
}

// Caller owns the same transaction that promotes old report + integration facts.
export function publishSplitCandidate(db, batch) {
  for (const definition of SPLIT_DETAILS) {
    db.prepare(`DELETE FROM ${definition.table} WHERE tenant_id=?`).run(batch.tenant_id);
    db.prepare(`INSERT INTO ${definition.table} (${definition.columns.join(',')}) SELECT ${definition.columns.join(',')}
      FROM ${definition.staging} WHERE batch_id=? AND tenant_id=?`).run(batch.id, batch.tenant_id);
  }
  db.prepare(`INSERT INTO ai_dashboard_split_state(tenant_id,batch_id,schema_version) VALUES(?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET batch_id=excluded.batch_id,schema_version=excluded.schema_version`)
    .run(batch.tenant_id, batch.id, SPLIT_SCHEMA_VERSION);
  clearSplitStaging(db, batch.id);
}

export async function buildSplitCandidate({ store, batch, progress, config, checkpoint, checkWindow }) {
  const db = store.database;
  if (!progress.integration?.ready) throw new Error('AI_SPLIT_INTEGRATION_NOT_READY');
  if (progress.split?.version !== SPLIT_SCHEMA_VERSION) store.transaction(() => {
    store.assertLease(batch);
    clearSplitStaging(db, batch.id);
    progress.split = { version: SPLIT_SCHEMA_VERSION, cursor: '' };
    store.checkpoint(batch, progress, config);
  });
  const write = splitWriter(db, true);
  while (!progress.split.ready) {
    checkWindow();
    store.transaction(() => {
      store.assertLease(batch);
      // Fetch and write under one lock so a concurrent suppression cannot be
      // followed by resurrecting a row fetched before that suppression.
      const rows = db.prepare(`SELECT * FROM ai_dashboard_integration_staging
        WHERE batch_id=? AND tenant_id=? AND id>? ORDER BY id LIMIT ?`)
        .all(batch.id, batch.tenant_id, progress.split.cursor, config.batchSize);
      for (const row of rows) write(row, batch.id);
      if (rows.length) progress.split.cursor = rows.at(-1).id;
      else progress.split.ready = true;
      store.checkpoint(batch, progress, config);
    });
    await checkpoint();
  }
}

// One-time additive backfill, in the caller's transaction. Never modifies the
// old report, the integration table, active batch or its coverage/timestamps.
export function backfillSplitDetails(db, forceTenants = []) {
  const pending = db.prepare(`SELECT b.id,b.tenant_id,b.time_zone,b.coverage_json,s.batch_id,s.schema_version
    FROM ai_usage_tenant_state t JOIN ai_usage_batches b ON b.id=t.active_batch_id AND b.tenant_id=t.tenant_id
    LEFT JOIN ai_dashboard_split_state s ON s.tenant_id=t.tenant_id WHERE b.status='published'`).all()
    .filter(batch => batch.time_zone === 'Asia/Shanghai' && JSON.parse(batch.coverage_json || '{}').integrationVersion === 1
      && (batch.schema_version !== SPLIT_SCHEMA_VERSION || batch.batch_id !== batch.id || forceTenants.includes(batch.tenant_id)));
  if (!pending.length) return;
  assertMigrationIdle(db);
  const write = splitWriter(db);
  for (const batch of pending) {
    for (const definition of SPLIT_DETAILS) db.prepare(`DELETE FROM ${definition.table} WHERE tenant_id=?`).run(batch.tenant_id);
    let cursor = '';
    for (;;) {
      const rows = db.prepare('SELECT * FROM ai_dashboard_integration_detail WHERE tenant_id=? AND id>? ORDER BY id LIMIT 500').all(batch.tenant_id, cursor);
      if (!rows.length) break;
      for (const row of rows) write(row);
      cursor = rows.at(-1).id;
    }
    db.prepare(`INSERT INTO ai_dashboard_split_state(tenant_id,batch_id,schema_version) VALUES(?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET batch_id=excluded.batch_id,schema_version=excluded.schema_version`)
      .run(batch.tenant_id, batch.id, SPLIT_SCHEMA_VERSION);
  }
}
