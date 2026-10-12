import { localParts } from './ai-usage-config.js';
import { parseJson, sessionScope } from './ai-usage-session-report.js';
import { isSessionSourceScopeConflict, scopeValidator } from './ai-usage-session-source.js';

export { isSessionSourceScopeConflict } from './ai-usage-session-source.js';

export const SESSION_CONFLICT_VERSION = 1;
const DATASETS = "'interactions','turns','skill_invocations','sql_generations','session_usage'";
const ISSUE_UPSERT = `INSERT INTO ai_usage_session_issues
  (tenant_id,session_key,workspace_id,user_id,provider,provider_session_id,reason,expected_json,actual_json,
    first_seen_at,last_seen_at,status,last_checked_batch_id,last_checked_at,last_check_conflict)
  VALUES(@tenant,@key,@workspace,@user,@provider,@session,@reason,@expected,@actual,@now,@now,'open',@batch,@now,1)
  ON CONFLICT(tenant_id,session_key) DO UPDATE SET
    reason=excluded.reason,expected_json=excluded.expected_json,actual_json=excluded.actual_json,
    last_seen_at=excluded.last_seen_at,status='open',last_checked_batch_id=excluded.last_checked_batch_id,
    last_checked_at=excluded.last_checked_at,last_check_conflict=1,resolved_at=NULL,resolved_batch_id=NULL`;

function issueParameters(batch, key, error, now) {
  const scope = error.scope;
  return { tenant: batch.tenant_id, key, workspace: scope.workspace_id, user: scope.user_id,
    provider: scope.provider, session: scope.session_id, reason: error.code,
    expected: JSON.stringify(error.expected), actual: JSON.stringify(error.actual), now, batch: batch.id };
}

function validateFactScope(row, scope) {
  const value = parseJson(row.value_json) || {};
  if (row.workspace_id !== scope.workspace_id
    || (row.dataset !== 'skill_invocations' && row.user_id !== scope.user_id)
    || (row.dataset === 'skill_invocations' && value.callerUserId != null && value.callerUserId !== scope.user_id)
    || (value.provider != null && value.provider !== scope.provider)
    || (value.providerSessionId != null && value.providerSessionId !== scope.session_id)) {
    throw new Error('SESSION_SUMMARY_FACT_SCOPE_CONFLICT');
  }
}

function warnConflict(logger, batch, key, error) {
  logger?.warn?.('[AI usage] Session scope conflict quarantined', {
    tenantId: batch.tenant_id, batchId: batch.id, sessionKey: key,
    reason: 'SESSION_SUMMARY_SOURCE_SCOPE_CONFLICT',
    expected: error.expected, actual: error.actual,
  });
}

/** Recheck original identities before partition aggregation, without changing
 * the original facts or resolving an issue before its replacement is published. */
export async function prepareSessionConflicts({ store, batch, progress, config, checkpoint, checkWindow,
  logger = console, now = () => new Date() }) {
  if (progress.sessionConflicts?.ready && progress.sessionConflicts.version === SESSION_CONFLICT_VERSION) return;
  const db = store.database;
  const validate = scopeValidator(db);
  const throughDate = localParts(batch.target_through, batch.time_zone || config.timeZone).date;
  const page = db.prepare(`SELECT session_key FROM (
    SELECT session_key FROM ai_usage_fact_rows WHERE tenant_id=@tenant AND stat_date<@through AND dataset IN (${DATASETS})
    UNION SELECT session_key FROM ai_usage_report_rows WHERE tenant_id=@tenant AND stat_date<@through AND dataset IN (${DATASETS})
    UNION SELECT session_key FROM ai_usage_session_issues WHERE tenant_id=@tenant AND status='open'
  ) WHERE session_key>@cursor ORDER BY session_key LIMIT @limit`);
  const issueFor = db.prepare('SELECT status FROM ai_usage_session_issues WHERE tenant_id=? AND session_key=?');
  const excluded = db.prepare(`SELECT 1 FROM ai_usage_batch_session_exclusions
    WHERE batch_id=? AND tenant_id=? AND session_key=?`);
  const record = db.prepare(ISSUE_UPSERT);
  const recordClear = db.prepare(`UPDATE ai_usage_session_issues SET last_checked_batch_id=?,last_checked_at=?,last_check_conflict=0
    WHERE tenant_id=? AND session_key=?`);
  const exclude = db.prepare(`INSERT OR IGNORE INTO ai_usage_batch_session_exclusions
    (batch_id,tenant_id,session_key,reason,created_at) VALUES(?,?,?,?,?)`);
  const factRows = db.prepare(`SELECT dataset,user_id,workspace_id,value_json FROM ai_usage_fact_rows
    WHERE tenant_id=@tenant AND session_key=@key AND stat_date<@through AND dataset IN (${DATASETS})
    UNION ALL SELECT dataset,user_id,workspace_id,value_json FROM ai_usage_report_rows
    WHERE tenant_id=@tenant AND session_key=@key AND stat_date<@through AND dataset IN (${DATASETS})`);
  const requeue = db.prepare(`INSERT INTO ai_usage_dirty_partitions(tenant_id,dataset,stat_date)
    SELECT @tenant,dataset,stat_date FROM (
      SELECT dataset,stat_date FROM ai_usage_fact_rows WHERE tenant_id=@tenant AND session_key=@key
      UNION SELECT dataset,stat_date FROM ai_usage_report_rows WHERE tenant_id=@tenant AND session_key=@key
    ) WHERE dataset NOT IN ('skill_evidence','daily_active_users','hook_daily','active_users')
    ON CONFLICT(tenant_id,dataset,stat_date) DO UPDATE SET generation=generation+1`);
  let cursor = progress.sessionConflicts?.version === SESSION_CONFLICT_VERSION
    ? progress.sessionConflicts.cursor || '' : '';
  while (true) {
    checkWindow();
    const rows = page.all({ tenant: batch.tenant_id, through: throughDate, cursor, limit: config.batchSize || 200 });
    if (!rows.length) break;
    const warnings = [];
    store.transaction(() => {
      store.assertLease(batch);
      const timestamp = now().toISOString();
      for (const { session_key: key } of rows) {
        checkWindow();
        const scope = sessionScope(key, batch.tenant_id);
        if (!scope) continue;
        let hasCandidateRows = false;
        for (const row of factRows.iterate({ tenant: batch.tenant_id, key, through: throughDate })) {
          checkWindow();
          hasCandidateRows = true;
          validateFactScope(row, scope);
        }
        const previous = issueFor.get(batch.tenant_id, key);
        let conflict = null;
        try { validate({ ...scope, session_key: key }); } catch (error) {
          if (!isSessionSourceScopeConflict(error)) throw error;
          conflict = error;
        }
        if (conflict) {
          record.run(issueParameters(batch, key, conflict, timestamp));
          if (hasCandidateRows) {
            exclude.run(batch.id, batch.tenant_id, key, conflict.code, timestamp);
            if (!previous || previous.status === 'resolved') warnings.push({ key, error: conflict });
          }
        } else if (previous) recordClear.run(batch.id, timestamp, batch.tenant_id, key);
        // Rebuild both exclusion and recovery from retained sources. This also
        // removes previously published rows after the original source vanished.
        if (conflict || previous?.status === 'open' || excluded.get(batch.id, batch.tenant_id, key)) {
          requeue.run({ tenant: batch.tenant_id, key });
        }
      }
      cursor = rows.at(-1).session_key;
      progress.sessionConflicts = { ready: false, version: SESSION_CONFLICT_VERSION, cursor };
      store.checkpoint(batch, progress, config);
    });
    for (const warning of warnings) warnConflict(logger, batch, warning.key, warning.error);
    await checkpoint();
  }
  store.transaction(() => {
    store.assertLease(batch);
    progress.sessionConflicts = { ready: true, version: SESSION_CONFLICT_VERSION };
    store.checkpoint(batch, progress, config);
  });
  await checkpoint();
}

export function sessionConflictCoverage(db, batch) {
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ai_usage_batch_session_exclusions
    WHERE batch_id=? AND tenant_id=?`).get(batch.id, batch.tenant_id).count;
  return { sessionScope: count ? 'partial' : 'complete', excludedSessionCount: count };
}

// The publisher calls this inside its transaction, after validating the final
// candidate. A failed or paused repair must leave its diagnostic issue open.
export function publishSessionConflictIssues(db, batch, now = new Date()) {
  const timestamp = now instanceof Date ? now.toISOString() : now;
  const validate = scopeValidator(db);
  const candidates = db.prepare(`SELECT session_key FROM ai_usage_session_issues
    WHERE tenant_id=? AND status='open' AND last_checked_batch_id=? AND last_check_conflict=0
      AND NOT EXISTS(SELECT 1 FROM ai_usage_batch_session_exclusions e
        WHERE e.batch_id=? AND e.tenant_id=ai_usage_session_issues.tenant_id
          AND e.session_key=ai_usage_session_issues.session_key)`).all(batch.tenant_id, batch.id, batch.id);
  for (const { session_key: key } of candidates) {
    const scope = sessionScope(key, batch.tenant_id);
    if (!scope) throw new Error('SESSION_REPORT_SCOPE_CONFLICT');
    try { validate({ ...scope, session_key: key }); } catch (error) {
      if (!isSessionSourceScopeConflict(error)) throw error;
      // A vanished historical source may have no rows in this candidate for
      // the earlier publication validator to inspect. Keep its issue open if
      // metadata changed again; there is no current contribution to exclude.
      db.prepare(ISSUE_UPSERT).run(issueParameters(batch, key, error, timestamp));
    }
  }
  const result = db.prepare(`UPDATE ai_usage_session_issues SET status='resolved',resolved_at=?,resolved_batch_id=?
    WHERE tenant_id=? AND status='open' AND last_checked_batch_id=? AND last_check_conflict=0
      AND NOT EXISTS(SELECT 1 FROM ai_usage_batch_session_exclusions e
        WHERE e.batch_id=? AND e.tenant_id=ai_usage_session_issues.tenant_id
          AND e.session_key=ai_usage_session_issues.session_key)`)
    .run(timestamp, batch.id, batch.tenant_id, batch.id, batch.id);
  return result.changes;
}

/** Synchronous so the original report and all projections can be validated
 * under the publisher's write transaction, including sessions with only SQL. */
export function validateSessionConflictCandidate(db, batch) {
  const validate = scopeValidator(db);
  const rows = db.prepare(`SELECT * FROM ai_usage_report_staging WHERE batch_id=? AND tenant_id=?
    AND dataset IN (${DATASETS}) ORDER BY session_key`);
  let previousKey = null;
  for (const row of rows.iterate(batch.id, batch.tenant_id)) {
    const scope = sessionScope(row.session_key, batch.tenant_id);
    if (!scope) continue;
    validateFactScope(row, scope);
    if (row.session_key !== previousKey) {
      validate({ ...scope, session_key: row.session_key });
      previousKey = row.session_key;
    }
  }
}

/** Called by the late-conflict retry transaction before resetting its staging.
 * Nested SQLite transactions preserve the caller's atomic reset boundary. */
export function recordSessionConflict({ store, batch, error, now = new Date(), logger = console }) {
  if (!isSessionSourceScopeConflict(error) || error.scope.tenant_id !== batch.tenant_id) throw error;
  const db = store.database;
  const timestamp = (typeof now === 'function' ? now() : now).toISOString();
  const key = error.scope.session_key;
  let fresh = false;
  store.transaction(() => {
    store.assertLease(batch);
    const previous = db.prepare('SELECT status FROM ai_usage_session_issues WHERE tenant_id=? AND session_key=?')
      .get(batch.tenant_id, key);
    fresh = !previous || previous.status === 'resolved';
    db.prepare(ISSUE_UPSERT).run(issueParameters(batch, key, error, timestamp));
    db.prepare(`INSERT OR IGNORE INTO ai_usage_batch_session_exclusions
      (batch_id,tenant_id,session_key,reason,created_at) VALUES(?,?,?,?,?)`)
      .run(batch.id, batch.tenant_id, key, error.code, timestamp);
  });
  if (fresh) warnConflict(logger, batch, key, error);
}
