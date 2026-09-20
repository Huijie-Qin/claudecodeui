import { randomUUID } from 'node:crypto';

import { REPORT_COLUMNS, requeueAiUsageReport } from '../database/ai-usage-report-schema.js';
import { INTEGRATION_COLUMNS } from '../database/ai-dashboard-integration-schema.js';
import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';
import { SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { integrationCoverage, shanghaiReportTime } from './ai-dashboard-integration.js';
import { localInstant, localParts } from './ai-usage-config.js';
import { clearSplitStaging, publishSplitCandidate } from './ai-dashboard-split.js';
import { publishSessionSummaryCandidate } from './ai-session-summary.js';
import { SESSION_REPORT_VERSION } from './ai-usage-session-report.js';
import { validateReportSessionUsageCandidate } from './ai-usage-session-source.js';

export function createAiUsageStore(database, { clock = () => new Date() } = {}) {
  const dirty = database.prepare(`INSERT INTO ai_usage_dirty_partitions(tenant_id,dataset,stat_date,generation)
    VALUES(?,?,?,1) ON CONFLICT(tenant_id,dataset,stat_date) DO UPDATE SET generation=generation+1`);
  const dirtySkill = database.prepare(`INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key)
    VALUES(?,?) ON CONFLICT(tenant_id,session_key) DO UPDATE SET generation=generation+1`);
  function markDirty(tenantId, row) {
    if (row.dataset !== 'skill_evidence') dirty.run(tenantId, row.dataset, row.stat_date);
    if (row.session_key && ['skill_evidence', 'interactions'].includes(row.dataset)) dirtySkill.run(tenantId, row.session_key);
  }
  const write = database.prepare(`INSERT INTO ai_usage_fact_rows
    (tenant_id,source_key,dataset,row_key,stat_date,user_id,workspace_id,subject_id,session_key,occurred_at,value_json,priority)
    VALUES(@tenant_id,@source_key,@dataset,@row_key,@stat_date,@user_id,@workspace_id,@subject_id,@session_key,@occurred_at,@value_json,@priority)
    ON CONFLICT(tenant_id,source_key,dataset,row_key) DO UPDATE SET
    stat_date=excluded.stat_date,user_id=excluded.user_id,workspace_id=excluded.workspace_id,
    subject_id=excluded.subject_id,session_key=excluded.session_key,occurred_at=excluded.occurred_at,
    value_json=excluded.value_json,priority=excluded.priority`);

  function put(tenantId, sourceKey, rows, { replace = false, priority = 0 } = {}) {
    if (replace) {
      for (const row of database.prepare('SELECT DISTINCT dataset,stat_date,session_key FROM ai_usage_fact_rows WHERE tenant_id=? AND source_key=?').all(tenantId, sourceKey)) {
        markDirty(tenantId, row);
      }
      database.prepare('DELETE FROM ai_usage_fact_rows WHERE tenant_id=? AND source_key=?').run(tenantId, sourceKey);
    }
    for (const row of rows) {
      const old = database.prepare(`SELECT stat_date FROM ai_usage_fact_rows WHERE tenant_id=? AND source_key=? AND dataset=? AND row_key=?`)
        .get(tenantId, sourceKey, row.dataset, row.row_key);
      if (old && old.stat_date !== row.stat_date) markDirty(tenantId, { ...row, stat_date: old.stat_date });
      write.run({ tenant_id: tenantId, source_key: sourceKey, user_id: null, workspace_id: null,
        subject_id: null, session_key: null, occurred_at: null, ...row,
        value_json: JSON.stringify(row.value ?? {}), priority });
      markDirty(tenantId, row);
    }
  }

  function assertLease(batch, now = clock()) {
    const current = database.prepare(`SELECT 1 FROM ai_usage_batches WHERE id=? AND lease_token=?
      AND status='running' AND lease_until>?`).get(batch.id, batch.lease_token, now.toISOString());
    if (!current) throw new Error('AI_USAGE_LEASE_LOST');
  }

  function claim(tenantId, schedule, config, now = clock()) {
    return database.transaction(() => {
      const nowIso = now.toISOString();
      if (database.prepare("SELECT 1 FROM ai_usage_batches WHERE tenant_id=? AND status='running' AND lease_until>?")
        .get(tenantId, nowIso)) return null;
      // Resume an unfinished logical batch before scheduling newer targets.
      let batch = database.prepare(`SELECT * FROM ai_usage_batches WHERE tenant_id=?
        AND status IN ('running','paused','failed') ORDER BY scheduled_for LIMIT 1`).get(tenantId);
      if (!batch) {
        if (database.prepare('SELECT 1 FROM ai_usage_batches WHERE tenant_id=? AND scheduled_for=?')
          .get(tenantId, schedule.scheduledFor)) return null;
        const id = randomUUID();
        database.prepare(`INSERT INTO ai_usage_batches(id,tenant_id,scheduled_for,target_through,time_zone,calculation_version,source_read_at)
          VALUES(?,?,?,?,?,?,?)`).run(id, tenantId, schedule.scheduledFor, schedule.targetThrough,
          config.timeZone, config.calculationVersion, nowIso);
        batch = database.prepare('SELECT * FROM ai_usage_batches WHERE id=?').get(id);
      }
      if (batch.calculation_version !== config.calculationVersion || batch.time_zone !== config.timeZone) {
        // A paused old-definition batch must not resume half way through new
        // parser code. Keep the published snapshot and restart only staging.
        requeueAiUsageReport(database, tenantId);
        database.prepare('DELETE FROM ai_usage_report_staging WHERE batch_id=?').run(batch.id);
        database.prepare('DELETE FROM ai_dashboard_integration_staging WHERE batch_id=?').run(batch.id);
        clearSplitStaging(database, batch.id);
        database.prepare('DELETE FROM ai_session_summary_staging WHERE batch_id=?').run(batch.id);
        database.prepare('DELETE FROM ai_usage_batch_files WHERE batch_id=?').run(batch.id);
        database.prepare('DELETE FROM ai_usage_skill_work_items WHERE batch_id=?').run(batch.id);
        const targetThrough = batch.time_zone === config.timeZone ? batch.target_through
          : localInstant(localParts(batch.target_through, batch.time_zone).date, '00:00', config.timeZone);
        database.prepare(`UPDATE ai_usage_batches SET progress_json='{}',calculation_version=?,time_zone=?,target_through=? WHERE id=?`)
          .run(config.calculationVersion, config.timeZone, targetThrough, batch.id);
        batch = { ...batch, progress_json: '{}', calculation_version: config.calculationVersion,
          time_zone: config.timeZone, target_through: targetThrough };
      }
      const leaseToken = randomUUID();
      database.prepare(`UPDATE ai_usage_batches SET status='running',lease_token=?,lease_until=?,error=NULL WHERE id=?`)
        .run(leaseToken, new Date(now.getTime() + config.leaseMs).toISOString(), batch.id);
      database.prepare('INSERT OR IGNORE INTO ai_usage_tenant_state(tenant_id) VALUES(?)').run(tenantId);
      return { ...batch, status: 'running', lease_token: leaseToken };
    }).immediate();
  }

  function checkpoint(batch, progress, config, now = clock()) {
    const result = database.prepare(`UPDATE ai_usage_batches SET progress_json=?,lease_until=?
      WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`).run(JSON.stringify(progress),
      new Date(now.getTime() + config.leaseMs).toISOString(), batch.id, batch.lease_token, now.toISOString());
    if (!result.changes) throw new Error('AI_USAGE_LEASE_LOST');
  }

  function finish(batch, status, error = null) {
    database.prepare(`UPDATE ai_usage_batches SET status=?,error=?,lease_until=NULL
      WHERE id=? AND lease_token=? AND status='running'`).run(status, error, batch.id, batch.lease_token);
  }

  function initializeStaging(batch, progress, config) {
    if (progress.stagingInitialized) return;
    database.transaction(() => {
      assertLease(batch);
      database.prepare('DELETE FROM ai_usage_report_staging WHERE batch_id=?').run(batch.id);
      database.prepare(`INSERT INTO ai_usage_report_staging(batch_id,${REPORT_COLUMNS})
        SELECT ?,${REPORT_COLUMNS} FROM ai_usage_report_rows WHERE tenant_id=?`).run(batch.id, batch.tenant_id);
      progress.stagingInitialized = true;
      checkpoint(batch, progress, config);
    }).immediate();
  }

  function publish(batch, coverage, now = clock()) {
    database.transaction(() => {
      assertLease(batch, now);
      const progress = JSON.parse(database.prepare('SELECT progress_json FROM ai_usage_batches WHERE id=?').get(batch.id).progress_json);
      if (!progress.stagingInitialized || progress.stage !== 'publish') throw new Error('AI_USAGE_REPORT_NOT_READY');
      if (!progress.integration?.ready) throw new Error('AI_INTEGRATION_NOT_READY');
      if (!progress.split?.ready || progress.split.version !== SPLIT_SCHEMA_VERSION) throw new Error('AI_SPLIT_NOT_READY');
      if (coverage.sessionSummaryVersion != null || progress.sessionSummary?.ready) {
        if (!progress.reportSessionUsage?.ready || progress.reportSessionUsage.version !== SESSION_REPORT_VERSION) {
          throw new Error('SESSION_REPORT_USAGE_NOT_READY');
        }
        validateReportSessionUsageCandidate(database, batch);
      }
      database.prepare('DELETE FROM ai_usage_report_rows WHERE tenant_id=?').run(batch.tenant_id);
      database.prepare(`INSERT INTO ai_usage_report_rows(${REPORT_COLUMNS})
        SELECT ${REPORT_COLUMNS} FROM ai_usage_report_staging WHERE batch_id=? AND tenant_id=?`).run(batch.id, batch.tenant_id);
      database.prepare('DELETE FROM ai_dashboard_integration_detail WHERE tenant_id=?').run(batch.tenant_id);
      database.prepare(`INSERT INTO ai_dashboard_integration_detail(${INTEGRATION_COLUMNS.join(',')})
        SELECT ${INTEGRATION_COLUMNS.map(c => c === 'refreshed_at' ? '?' : c).join(',')}
        FROM ai_dashboard_integration_staging WHERE batch_id=? AND tenant_id=?`)
        .run(shanghaiReportTime(now), batch.id, batch.tenant_id);
      publishSplitCandidate(database, batch);
      // Old direct store consumers can still publish dashboard-only batches.
      // The nightly runner always projects the SAME original-report candidate.
      if ((coverage.sessionSummaryVersion != null || progress.sessionSummary?.ready)
        && (!progress.sessionSummary?.ready || progress.sessionSummary.version !== SESSION_SUMMARY_VERSION)) throw new Error('SESSION_SUMMARY_NOT_READY');
      if (progress.sessionSummary?.ready) publishSessionSummaryCandidate(database, batch);
      assertLease(batch);
      database.prepare(`UPDATE ai_usage_batches SET status='published',completed_at=?,coverage_json=?,lease_until=NULL WHERE id=?`)
        .run(now.toISOString(), JSON.stringify(integrationCoverage(coverage)), batch.id);
      database.prepare('UPDATE ai_usage_tenant_state SET active_batch_id=? WHERE tenant_id=?').run(batch.id, batch.tenant_id);
      database.prepare('DELETE FROM ai_usage_report_staging WHERE batch_id=?').run(batch.id);
      database.prepare('DELETE FROM ai_dashboard_integration_staging WHERE batch_id=?').run(batch.id);
    }).immediate();
  }

  return { database, put, claim, assertLease, checkpoint, finish, initializeStaging, publish,
    transaction: (fn) => database.transaction(fn).immediate() };
}
