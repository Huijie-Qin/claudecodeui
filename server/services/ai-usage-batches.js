import { randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';

import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';
import { SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';
import { requeueAiUsageReport } from '../database/ai-usage-report-schema.js';

import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageRunLog } from './ai-usage-run-log.js';
import { createAiUsageIndexer } from './ai-usage-indexer.js';
import { getAiUsageSchedule, localParts } from './ai-usage-config.js';
import { buildActivityDays, markActivityDays } from './ai-usage-activity.js';
import { buildIntegrationCandidate } from './ai-dashboard-integration.js';
import { buildSplitCandidate, clearSplitStaging } from './ai-dashboard-split.js';
import { buildSessionSummaryCandidate } from './ai-session-summary.js';
import { mergeSessionReportFact, SESSION_REPORT_VERSION } from './ai-usage-session-report.js';
import { buildReportSessionUsageCandidate } from './ai-usage-session-source.js';
import { AiUsageDurationRecordError, durationSourceFilterSql, parseDurationFact } from './ai-usage-duration.js';
import { isSessionSourceScopeConflict, prepareSessionConflicts, recordSessionConflict,
  sessionConflictCoverage } from './ai-usage-session-conflicts.js';

const sessionDatasets = new Set(['interactions', 'turns', 'skill_invocations', 'sql_generations', 'session_usage']);

export class AiUsageWindowClosed extends Error {
  constructor(reason = 'window_ended') {
    super('AI usage idle window ended; progress saved');
    this.reason = reason;
  }
}

export async function runAiUsageWindow({ database, config, now = () => new Date(), shouldStop = () => false, logger = console }) {
  if (!config.enabled) return { status: 'outside_window', published: 0 };
  const runSchedule = getAiUsageSchedule(config, now());
  if (!runSchedule.inWindow) return { status: 'outside_window', published: 0 };
  let abortError = null;
  const globalToken = randomUUID();
  const runLog = createAiUsageRunLog(database, { schedule: runSchedule, config, workerToken: globalToken, now });
  const poolLease = database.prepare('SELECT 1 FROM ai_usage_worker_lock WHERE id=1 AND lease_token=? AND lease_until>?');
  const baseStore = createAiUsageStore(database, { clock: now });
  function assertPoolLease() {
    if (abortError) throw abortError;
    if (!poolLease.get(globalToken, now().toISOString())) throw new Error('AI_USAGE_LEASE_LOST');
  }
  function poolTransaction(fn) {
    const previousRenewal = lastRenewed;
    try {
      return baseStore.transaction(() => { assertPoolLease(); return fn(); });
    } catch (error) {
      // A nested check may renew leases inside this transaction. Its rollback
      // must also roll back the renewal clock before another tenant continues.
      lastRenewed = previousRenewal;
      throw error;
    }
  }
  // Fence writes after in-flight I/O resumes, including publication, so a
  // stopped or expired pool cannot keep writing under a replacement owner.
  const store = { ...baseStore,
    transaction: poolTransaction,
    assertLease: (...args) => { assertPoolLease(); return baseStore.assertLease(...args); },
    claim: (...args) => poolTransaction(() => {
      const batch = baseStore.claim(...args);
      if (batch) runLog.claimed(batch);
      else runLog.notClaimed(args[0]);
      return batch;
    }),
    checkpoint: (batch, progress, ...args) => poolTransaction(() => {
      baseStore.checkpoint(batch, progress, ...args);
      runLog.checkpoint(batch, progress);
    }),
    initializeFullRebuild: (...args) => poolTransaction(() => baseStore.initializeFullRebuild(...args)),
    advanceFullRebuildTarget: (...args) => poolTransaction(() => baseStore.advanceFullRebuildTarget(...args)),
    initializeStaging: (...args) => poolTransaction(() => baseStore.initializeStaging(...args)),
    publish: (batch, ...args) => poolTransaction(() => {
      baseStore.publish(batch, ...args);
      runLog.published(batch, args[0]);
    }),
  };
  const claimed = database.transaction(() => {
    const held = database.prepare('SELECT * FROM ai_usage_worker_lock WHERE id=1').get();
    if (held?.lease_until && held.lease_until > now().toISOString()) return false;
    database.prepare(`INSERT INTO ai_usage_worker_lock(id,lease_token,lease_until) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until`)
      .run(globalToken, new Date(now().getTime() + config.leaseMs).toISOString());
    return true;
  }).immediate();
  if (!claimed) return { status: 'already_running', published: 0 };
  let lastRenewed = now().getTime();
  const activeBatches = new Map();
  let published = 0;
  const errors = [];
  const excluded = database.prepare(`SELECT 1 FROM ai_usage_batch_session_exclusions
    WHERE batch_id=? AND tenant_id=? AND session_key=?`);

  function checkWindow() {
    if (abortError) throw abortError;
    const current = now();
    if (shouldStop()) throw new AiUsageWindowClosed('stop_requested');
    if (!getAiUsageSchedule(config, current).inWindow) throw new AiUsageWindowClosed();
    if (current.getTime() - lastRenewed >= config.leaseMs / 4) {
      database.transaction(() => {
        const until = new Date(current.getTime() + config.leaseMs).toISOString();
        const renewed = database.prepare(`UPDATE ai_usage_worker_lock SET lease_until=?
          WHERE id=1 AND lease_token=? AND lease_until>?`).run(until, globalToken, current.toISOString());
        if (!renewed.changes) throw new Error('AI_USAGE_LEASE_LOST');
        for (const activeBatch of activeBatches.values()) {
          const held = database.prepare(`UPDATE ai_usage_batches SET lease_until=?
            WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
            .run(until, activeBatch.id, activeBatch.lease_token, current.toISOString());
          if (!held.changes) throw new Error('AI_USAGE_LEASE_LOST');
        }
      }).immediate();
      lastRenewed = current.getTime();
    }
  }

  async function runTenant(tenant) {
    checkWindow();
    const schedule = getAiUsageSchedule(config, now());
    let batch;
    try { batch = store.claim(tenant.id, schedule, config, now()); }
    catch (error) {
      try { runLog.claimFailed(tenant.id, error); }
      catch (logError) { logger.error?.('[AI usage] run_log_failed', { tenantId: tenant.id, error: logError.message }); }
      throw error;
    }
    if (!batch) return;
    activeBatches.set(batch.id, batch);
    let progress = {};
    try {
      progress = JSON.parse(batch.progress_json || '{}');
      const batchConfig = { ...config, timeZone: batch.time_zone, calculationVersion: batch.calculation_version,
        incrementalEnabled: JSON.parse(batch.coverage_json || '{}').incrementalEnabled ?? true };
      const mode = batchConfig.incrementalEnabled ? 'incremental' : 'full';
      logger.info?.('[AI usage] batch_started', { batchId: batch.id, tenantId: batch.tenant_id,
        calculationVersion: batch.calculation_version, targetThrough: batch.target_through, mode });
      const onDurationAnomaly = ({ stage, reason, rowKey, sessionKey, sourceKey }) => {
        progress.durationAnomalies ||= {};
        const count = (progress.durationAnomalies[stage] || 0) + 1;
        progress.durationAnomalies[stage] = count;
        // Bound per-record output; the publication log includes the full count.
        if (count <= 20) logger.warn?.('[AI usage] duration_record_skipped', {
          batchId: batch.id, tenantId: batch.tenant_id, stage, reason, rowKey, sessionKey, sourceKey,
        });
      };
      const skipDuration = (error, row) => {
        if (!(error instanceof AiUsageDurationRecordError)) throw error;
        onDurationAnomaly({ stage: 'partitions', reason: error.code,
          rowKey: row.row_key, sessionKey: row.session_key, sourceKey: row.source_key });
      };
      const checkpoint = async (_progress, { persisted = false } = {}) => {
        checkWindow();
        if (!persisted) store.checkpoint(batch, progress, config, now());
        await yieldEventLoop();
        if (abortError) throw abortError;
      };
      const state = database.prepare('SELECT * FROM ai_usage_tenant_state WHERE tenant_id=?').get(tenant.id);
      if (progress.dataRevision == null) progress.dataRevision = state.data_revision || 0;
      if (!batchConfig.incrementalEnabled && !progress.fullRebuildInitialized) {
        store.initializeFullRebuild(batch, progress, batchConfig);
        logger.info?.('[AI usage] history_rebuild_started', { batchId: batch.id, tenantId: batch.tenant_id,
          previousVersion: state.calculation_version, calculationVersion: batch.calculation_version,
          targetThrough: batch.target_through, mode, reason: 'full_mode' });
      } else if (state.time_zone !== batch.time_zone || state.calculation_version !== batch.calculation_version) {
        store.transaction(() => {
          store.assertLease(batch, now());
          database.prepare(`UPDATE ai_usage_tenant_state SET bootstrapped=0,bootstrap_json='{}',time_zone=?,calculation_version=? WHERE tenant_id=?`)
            .run(batch.time_zone, batch.calculation_version, tenant.id);
          // Rebuild retained facts too, including rows whose source did not change.
          requeueAiUsageReport(database, tenant.id);
          // Source switches must also retire orphaned old captures whose raw
          // turn row no longer exists. Requeue first; the published snapshot
          // remains intact until the replacement candidate is ready.
          database.prepare("DELETE FROM ai_usage_fact_rows WHERE tenant_id=? AND dataset='turns' AND source_key LIKE 'turn:%'")
            .run(tenant.id);
          // A timezone/definition change requires explicit night-time reindexing.
          database.prepare('UPDATE ai_usage_source_states SET offset=0,identity=NULL WHERE tenant_id=?').run(tenant.id);
        });
        logger.info?.('[AI usage] history_rebuild_started', { batchId: batch.id, tenantId: batch.tenant_id,
          previousVersion: state.calculation_version, calculationVersion: batch.calculation_version,
          targetThrough: batch.target_through, mode, reason: 'definition_changed' });
      }
      refreshTarget: for (;;) {
        const indexer = createAiUsageIndexer({ store, config: batchConfig, batch, checkpoint, checkWindow, onDurationAnomaly });
        if (!progress.stage || progress.stage === 'bootstrap') {
          progress.stage = 'bootstrap';
          await indexer.bootstrap(progress);
          progress.stage = 'transcripts';
          await checkpoint();
        }
        if (progress.stage === 'transcripts') {
          await indexer.transcripts(progress);
          progress.stage = 'sources';
          await checkpoint();
        }
        if (progress.stage === 'sources') {
          await indexer.changedSources(progress);
          progress.stage = 'skills';
          await checkpoint();
        }
        if (progress.stage === 'skills') {
          await indexer.skills(progress);
          progress.stage = 'partitions';
          await checkpoint();
        }
        // A source can change while we build the candidate. Rebuild under the
        // same logical batch with a monotonic exclusion set instead of failing
        // all other sessions or publishing mismatched downstream projections.
        for (;;) {
          try {
            await prepareSessionConflicts({ store, batch, progress, config: batchConfig, checkpoint, checkWindow, now, logger });
            if (progress.stage === 'partitions') {
              store.initializeStaging(batch, progress, config);
              const throughDate = localParts(batch.target_through, batch.time_zone).date;
              while (true) {
                checkWindow();
                const part = database.prepare(`SELECT * FROM ai_usage_dirty_partitions
                  WHERE tenant_id=? AND stat_date<? ORDER BY dataset,stat_date LIMIT 1`).get(tenant.id, throughDate);
                if (!part) break;
                if (!progress.partition || progress.partition.dataset !== part.dataset || progress.partition.date !== part.stat_date) {
                  store.transaction(() => {
                    store.assertLease(batch, now());
                    const datasets = [part.dataset];
                    if (part.dataset === 'hook_records') datasets.push('hook_daily');
                    if (part.dataset === 'interactions') datasets.push('daily_active_users');
                    for (const dataset of datasets) database.prepare(`DELETE FROM ai_usage_report_staging
                      WHERE batch_id=? AND dataset=? AND stat_date=?`).run(batch.id, dataset, part.stat_date);
                    progress.partition = { dataset: part.dataset, date: part.stat_date, cursor: '' };
                    store.checkpoint(batch, progress, config, now());
                  });
                  await checkpoint();
                }
                const target = progress.partition;
                while (true) {
                  checkWindow();
                  const rows = database.prepare(`WITH next_keys AS MATERIALIZED (
                    SELECT DISTINCT row_key FROM ai_usage_fact_rows f
                    WHERE tenant_id=? AND dataset=? AND stat_date=? AND row_key>? AND ${durationSourceFilterSql('f')}
                    ORDER BY row_key LIMIT ?
                  ) SELECT * FROM (
                    SELECT f.*,ROW_NUMBER() OVER(PARTITION BY f.row_key ORDER BY
                      CASE WHEN f.dataset='skill_publications' THEN f.occurred_at END ASC,f.priority DESC,f.source_key) AS choice
                    FROM ai_usage_fact_rows f JOIN next_keys k ON k.row_key=f.row_key
                    WHERE f.tenant_id=? AND f.dataset=? AND f.stat_date=? AND ${durationSourceFilterSql('f')}
                  ) WHERE choice=1 ORDER BY row_key`).all(tenant.id, part.dataset, part.stat_date, target.cursor,
                    config.batchSize, tenant.id, part.dataset, part.stat_date);
                  if (!rows.length) break;
                  store.transaction(() => {
                    store.assertLease(batch, now());
                    const insert = database.prepare(`INSERT OR REPLACE INTO ai_usage_report_staging
                      (batch_id,tenant_id,dataset,row_key,stat_date,user_id,workspace_id,subject_id,session_key,occurred_at,value_json)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
                    const readSummary = database.prepare('SELECT * FROM ai_usage_report_staging WHERE batch_id=? AND dataset=? AND stat_date=? AND row_key=?');
                    for (const row of rows) {
                      // Apply exclusions after source-priority selection, before ANY
                      // aggregate (including daily activity) sees this contribution.
                      if (sessionDatasets.has(row.dataset) && excluded.get(batch.id, tenant.id, row.session_key)) continue;
                      let value;
                      try { value = row.dataset === 'turns' ? parseDurationFact(row) : JSON.parse(row.value_json); }
                      catch (error) { skipDuration(error, row); continue; }
                      let rowKey = row.row_key;
                      let output = value;
                      if (row.dataset === 'interactions' || row.dataset === 'turns') {
                        rowKey = JSON.stringify([row.dataset, row.session_key, row.user_id, row.workspace_id, value.templateId || null, value.status || null]);
                        const previous = readSummary.get(batch.id, row.dataset, row.stat_date, rowKey);
                        const earlier = previous ? JSON.parse(previous.value_json) : null;
                        try { output = mergeSessionReportFact(row, earlier); }
                        catch (error) { skipDuration(error, row); continue; }
                        // Source cursor and summary updates commit together below;
                        // replay after a crash never increments the same input twice.
                        row.occurred_at = previous && previous.occurred_at < row.occurred_at ? previous.occurred_at : row.occurred_at;
                      }
                      insert.run(batch.id, tenant.id, row.dataset, rowKey, row.stat_date,
                        row.user_id, row.workspace_id, row.subject_id, row.session_key, row.occurred_at, JSON.stringify(output));
                      if (row.dataset === 'interactions' && row.user_id != null) {
                        const activeKey = `active:${JSON.stringify([row.user_id, row.workspace_id, value.provider || null])}`;
                        insert.run(batch.id, tenant.id, 'daily_active_users', activeKey, row.stat_date,
                          row.user_id, row.workspace_id, null, null, null,
                          JSON.stringify({ provider: value.provider, userName: value.userName, workspaceName: value.workspaceName }));
                      }
                      if (row.dataset === 'hook_records' && !database.prepare(`SELECT 1 FROM ai_usage_suppressed_rows
                        WHERE tenant_id=? AND dataset='hook_records' AND row_key=?`).get(tenant.id, row.row_key)) {
                        const aggregateKey = `hook-daily:${JSON.stringify([row.user_id, row.workspace_id, value.hookId,
                          value.postActionId, value.recordType, value.hookVersion, value.recordSource])}`;
                        const previous = readSummary.get(batch.id, 'hook_daily', row.stat_date, aggregateKey);
                        const summary = previous ? JSON.parse(previous.value_json) : {
                          hookId: value.hookId, hookName: value.hookName, postActionId: value.postActionId,
                          recordType: value.recordType, hookVersion: value.hookVersion, recordSource: value.recordSource,
                          recordCount: 0, fields: [],
                        };
                        summary.recordCount++;
                        for (const field of value.fields || []) {
                          if (field.type !== 'number' || !Number.isFinite(field.value)) continue;
                          let aggregate = summary.fields.find((item) => item.key === field.key && item.label === field.label && item.unit === field.unit);
                          if (!aggregate) {
                            aggregate = { key: field.key, label: field.label, unit: field.unit, type: 'number',
                              validCount: 0, sum: 0, min: field.value, max: field.value };
                            summary.fields.push(aggregate);
                          }
                          aggregate.validCount++; aggregate.sum += field.value;
                          aggregate.min = Math.min(aggregate.min, field.value); aggregate.max = Math.max(aggregate.max, field.value);
                        }
                        insert.run(batch.id, tenant.id, 'hook_daily', aggregateKey, row.stat_date,
                          row.user_id, row.workspace_id, row.subject_id, null, row.occurred_at, JSON.stringify(summary));
                      }
                    }
                    target.cursor = rows.at(-1).row_key;
                    store.checkpoint(batch, progress, config, now());
                  });
                  await checkpoint();
                }
                store.transaction(() => {
                  store.assertLease(batch, now());
                  if (part.dataset === 'interactions') {
                    markActivityDays(database, tenant.id, part.stat_date);
                  }
                  database.prepare('DELETE FROM ai_usage_dirty_partitions WHERE tenant_id=? AND dataset=? AND stat_date=? AND generation=?')
                    .run(tenant.id, part.dataset, part.stat_date, part.generation);
                  delete progress.partition;
                  store.checkpoint(batch, progress, config, now());
                });
                await checkpoint();
              }
              progress.stage = 'activity';
              await checkpoint();
            }
            if (progress.stage === 'activity') {
              await buildActivityDays({ store, batch, config: batchConfig, progress, checkpoint, checkWindow });
              progress.stage = 'integration';
              await checkpoint();
            }
            if (progress.stage === 'integration' || (progress.stage === 'publish' && !progress.integration?.ready)) {
              await buildIntegrationCandidate({ store, batch, config: batchConfig, progress, checkpoint, checkWindow });
              progress.integration.ready = true;
              progress.stage = 'split';
              await checkpoint();
            }
            // Also covers a prepared, pre-split batch resumed after this additive upgrade.
            if (progress.stage === 'split' || (progress.stage === 'publish' && (!progress.split?.ready || progress.split.version !== SPLIT_SCHEMA_VERSION))) {
              await buildSplitCandidate({ store, batch, config: batchConfig, progress, checkpoint, checkWindow });
              progress.stage = 'publish';
              await checkpoint();
            }
            if (progress.stage === 'publish' && (!progress.reportSessionUsage?.ready || progress.reportSessionUsage.version !== SESSION_REPORT_VERSION)) {
              await buildReportSessionUsageCandidate({ store, batch, progress, checkpoint, checkWindow });
            }
            if (progress.stage === 'publish' && (!progress.sessionSummary?.ready || progress.sessionSummary.version !== SESSION_SUMMARY_VERSION)) {
              if (progress.durationAnomalies) progress.durationAnomalies.session_summary = 0;
              await buildSessionSummaryCandidate({ store, batch, progress, checkpoint, checkWindow, onDurationAnomaly });
            }
            checkWindow();
            // Finish the saved full rebuild before advancing its cutoff. Restarting
            // discovery on every cross-night claim could prevent a large tenant
            // from ever finishing. Reuse verified source facts, then rebuild ALL
            // projections before publishing anything. Pin this catch-up target
            // once: if it also spans nights, repeatedly chasing a moving cutoff
            // would prevent the logical batch from ever publishing.
            if (!batchConfig.incrementalEnabled && batch.target_through < runSchedule.targetThrough
              && (progress.targetRefreshCount || 0) < 1) {
              const previousTargetThrough = batch.target_through;
              store.advanceFullRebuildTarget(batch, progress, runSchedule, batchConfig);
              logger.info?.('[AI usage] full_rebuild_target_advanced', { batchId: batch.id, tenantId: batch.tenant_id,
                previousTargetThrough, targetThrough: batch.target_through,
                runScheduledFor: runSchedule.scheduledFor, targetRefreshCount: progress.targetRefreshCount });
              await checkpoint();
              continue refreshTarget;
            }
            const completedWindowScheduledFor = !batchConfig.incrementalEnabled
              && batch.target_through >= runSchedule.targetThrough ? runSchedule.scheduledFor : undefined;
            const conflictCoverage = sessionConflictCoverage(database, batch);
            const skippedDurationRecords = Object.values(progress.durationAnomalies || {}).reduce((sum, count) => sum + count, 0);
            store.publish(batch, { ...indexer.coverage(), ...conflictCoverage, activeUsers: 'partial', dataRevision: progress.dataRevision,
              sessionSummaryVersion: SESSION_SUMMARY_VERSION, skippedDurationRecords, completedWindowScheduledFor,
              ...(progress.targetRefreshCount ? { targetRefreshCount: progress.targetRefreshCount,
                originalTargetThrough: progress.originalTargetThrough } : {}),
              hookNumericStatisticsVersion: /(?:^|_)hook_numbers_v5(?:_|$)/.test(batch.calculation_version) ? 1 : 0 }, now());
            published++;
            logger.info?.('[AI usage] batch_published', { batchId: batch.id, tenantId: batch.tenant_id,
              calculationVersion: batch.calculation_version, targetThrough: batch.target_through, mode,
              excludedSessionCount: conflictCoverage.excludedSessionCount, skippedDurationRecords,
              completedWindowScheduledFor, targetRefreshCount: progress.targetRefreshCount || 0 });
            break refreshTarget;
          } catch (error) {
            if (!isSessionSourceScopeConflict(error)) throw error;
            checkWindow();
            store.transaction(() => {
              store.assertLease(batch, now());
              recordSessionConflict({ store, batch, error, now, logger });
              // Dirty markers may already have been consumed in this attempt.
              // Rebuild reports from retained facts, without re-reading sources.
              requeueAiUsageReport(database, batch.tenant_id);
              database.prepare('DELETE FROM ai_usage_report_staging WHERE batch_id=?').run(batch.id);
              database.prepare('DELETE FROM ai_dashboard_integration_staging WHERE batch_id=?').run(batch.id);
              clearSplitStaging(database, batch.id);
              database.prepare('DELETE FROM ai_session_summary_staging WHERE batch_id=?').run(batch.id);
              for (const key of ['stagingInitialized', 'partition', 'activity', 'integration', 'split',
                'reportSessionUsage', 'sessionSummary', 'sessionConflicts']) delete progress[key];
              if (progress.durationAnomalies) {
                progress.durationAnomalies.partitions = 0;
                progress.durationAnomalies.session_summary = 0;
              }
              progress.stage = 'partitions';
              store.checkpoint(batch, progress, config, now());
            });
            await checkpoint();
          }
        }
      }
    } catch (error) {
      if (error instanceof AiUsageWindowClosed || error.message === 'AI_USAGE_LEASE_LOST') abortError ??= error;
      const status = error instanceof AiUsageWindowClosed ? 'paused' : 'failed';
      try {
        database.transaction(() => {
          store.finish(batch, status, error.message);
          runLog.finished(batch, status, error.message, error.reason || error.code || null, progress);
        }).immediate();
      } catch (logError) {
        logger.error?.('[AI usage] run_log_failed', { batchId: batch.id, tenantId: batch.tenant_id, error: logError.message });
        store.finish(batch, status, error.message);
      }
      if (error instanceof AiUsageWindowClosed) logger.info?.('[AI usage] batch_paused', {
        batchId: batch.id, tenantId: batch.tenant_id, reason: error.reason, stage: progress.stage,
      });
      else logger.error?.('[AI usage] batch_failed', { batchId: batch.id, tenantId: batch.tenant_id,
        stage: progress.stage, error: error.message });
      if (error instanceof AiUsageWindowClosed || error.message === 'AI_USAGE_LEASE_LOST') throw error;
      errors.push({ tenantId: tenant.id, message: error.message });
    } finally { activeBatches.delete(batch.id); }
  }

  try {
    // Queue the least up-to-date tenants first. A full rebuild starts again
    // each night, so fixed ID ordering can spend every window on tenants whose
    // reports are already fresh while later tenants never get a first batch.
    const tenants = database.prepare(`WITH unfinished AS (
      SELECT tenant_id,MIN(scheduled_for) AS oldest_scheduled_for FROM ai_usage_batches
      WHERE status IN ('running','paused','failed') GROUP BY tenant_id
    ) SELECT t.id FROM tenants t
      LEFT JOIN ai_usage_tenant_state s ON s.tenant_id=t.id
      LEFT JOIN ai_usage_batches p ON p.id=s.active_batch_id AND p.tenant_id=t.id AND p.status='published'
      LEFT JOIN unfinished u ON u.tenant_id=t.id
      WHERE t.status='active'
      ORDER BY CASE WHEN p.id IS NULL THEN 0 ELSE 1 END,
        COALESCE(p.target_through,''),
        CASE WHEN u.oldest_scheduled_for IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(p.completed_at,''),u.oldest_scheduled_for,t.id`).all();
    store.transaction(() => runLog.initialize(tenants));
    let cursor = 0;
    async function runSlot() {
      try {
        while (!abortError && cursor < tenants.length) await runTenant(tenants[cursor++]);
      } catch (error) {
        abortError ??= error;
        throw error;
      }
    }
    // One global lease owns the entire pool, including across PM2 processes.
    // Keep it until all in-flight tenants have saved their final state.
    await Promise.allSettled(Array.from({ length: Math.min(config.concurrency ?? 1, tenants.length) }, runSlot));
    if (abortError) throw abortError;
    runLog.finalize('waiting_for_next_attempt');
    return { status: errors.length ? 'partial_failure' : 'completed', published, errors };
  } catch (error) {
    try { runLog.finalize(error instanceof AiUsageWindowClosed ? error.reason : 'worker_failed', error.message); }
    catch (logError) { logger.error?.('[AI usage] run_log_failed', { error: logError.message }); }
    if (error instanceof AiUsageWindowClosed) return { status: 'paused', published };
    throw error;
  } finally {
    database.prepare('DELETE FROM ai_usage_worker_lock WHERE id=1 AND lease_token=?').run(globalToken);
  }
}
