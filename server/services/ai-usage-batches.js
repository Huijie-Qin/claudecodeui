import { randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';

import { SPLIT_SCHEMA_VERSION } from '../database/ai-dashboard-split-schema.js';
import { SESSION_SUMMARY_VERSION } from '../database/ai-session-summary-schema.js';

import { createAiUsageStore } from './ai-usage-db.js';
import { createAiUsageIndexer } from './ai-usage-indexer.js';
import { getAiUsageSchedule, localParts } from './ai-usage-config.js';
import { buildActivityDays, markActivityDays } from './ai-usage-activity.js';
import { buildIntegrationCandidate } from './ai-dashboard-integration.js';
import { buildSplitCandidate } from './ai-dashboard-split.js';
import { buildSessionSummaryCandidate } from './ai-session-summary.js';
import { mergeSessionReportFact, SESSION_REPORT_VERSION } from './ai-usage-session-report.js';
import { buildReportSessionUsageCandidate } from './ai-usage-session-source.js';

export class AiUsageWindowClosed extends Error {
  constructor() { super('AI usage idle window ended; progress saved'); }
}

export async function runAiUsageWindow({ database, config, now = () => new Date(), shouldStop = () => false }) {
  if (!config.enabled || !getAiUsageSchedule(config, now()).inWindow) return { status: 'outside_window', published: 0 };
  const store = createAiUsageStore(database, { clock: now });
  const globalToken = randomUUID();
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
  let activeBatch = null;
  let published = 0;
  const errors = [];

  function checkWindow() {
    const current = now();
    if (shouldStop() || !getAiUsageSchedule(config, current).inWindow) throw new AiUsageWindowClosed();
    if (current.getTime() - lastRenewed >= config.leaseMs / 4) {
      const renewed = database.prepare(`UPDATE ai_usage_worker_lock SET lease_until=?
        WHERE id=1 AND lease_token=? AND lease_until>?`).run(new Date(current.getTime() + config.leaseMs).toISOString(), globalToken, current.toISOString());
      if (!renewed.changes) throw new Error('AI_USAGE_LEASE_LOST');
      if (activeBatch) {
        const held = database.prepare(`UPDATE ai_usage_batches SET lease_until=?
          WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`)
          .run(new Date(current.getTime() + config.leaseMs).toISOString(), activeBatch.id, activeBatch.lease_token, current.toISOString());
        if (!held.changes) throw new Error('AI_USAGE_LEASE_LOST');
      }
      lastRenewed = current.getTime();
    }
  }

  try {
    const tenants = database.prepare("SELECT id FROM tenants WHERE status='active' ORDER BY id").all();
    for (const tenant of tenants) {
      checkWindow();
      const schedule = getAiUsageSchedule(config, now());
      const batch = store.claim(tenant.id, schedule, config, now());
      if (!batch) continue;
      activeBatch = batch;
      const progress = JSON.parse(batch.progress_json || '{}');
      const batchConfig = { ...config, timeZone: batch.time_zone, calculationVersion: batch.calculation_version };
      const checkpoint = async () => {
        checkWindow();
        store.checkpoint(batch, progress, config, now());
        await yieldEventLoop();
      };
      try {
        const state = database.prepare('SELECT * FROM ai_usage_tenant_state WHERE tenant_id=?').get(tenant.id);
        if (progress.dataRevision == null) progress.dataRevision = state.data_revision || 0;
        if (state.time_zone !== batch.time_zone || state.calculation_version !== batch.calculation_version) {
          store.transaction(() => {
            store.assertLease(batch, now());
            database.prepare(`UPDATE ai_usage_tenant_state SET bootstrapped=0,bootstrap_json='{}',time_zone=?,calculation_version=? WHERE tenant_id=?`)
              .run(batch.time_zone, batch.calculation_version, tenant.id);
            // A timezone/definition change requires explicit night-time reindexing.
            database.prepare('UPDATE ai_usage_source_states SET offset=0,identity=NULL WHERE tenant_id=?').run(tenant.id);
          });
        }
        const indexer = createAiUsageIndexer({ store, config: batchConfig, batch, checkpoint, checkWindow });
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
                SELECT DISTINCT row_key FROM ai_usage_fact_rows
                WHERE tenant_id=? AND dataset=? AND stat_date=? AND row_key>?
                ORDER BY row_key LIMIT ?
              ) SELECT * FROM (
                SELECT f.*,ROW_NUMBER() OVER(PARTITION BY f.row_key ORDER BY f.priority DESC,f.source_key) AS choice
                FROM ai_usage_fact_rows f JOIN next_keys k ON k.row_key=f.row_key
                WHERE f.tenant_id=? AND f.dataset=? AND f.stat_date=?
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
                  const value = JSON.parse(row.value_json);
                  let rowKey = row.row_key;
                  let output = value;
                  if (row.dataset === 'interactions' || row.dataset === 'turns') {
                    rowKey = JSON.stringify([row.dataset, row.session_key, row.user_id, row.workspace_id, value.templateId || null, value.status || null]);
                    const previous = readSummary.get(batch.id, row.dataset, row.stat_date, rowKey);
                    const earlier = previous ? JSON.parse(previous.value_json) : null;
                    output = mergeSessionReportFact(row, earlier);
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
          await buildSessionSummaryCandidate({ store, batch, progress, checkpoint, checkWindow });
        }
        checkWindow();
        store.publish(batch, { ...indexer.coverage(), activeUsers: 'partial', dataRevision: progress.dataRevision,
          sessionSummaryVersion: SESSION_SUMMARY_VERSION,
          hookNumericStatisticsVersion: /(?:^|_)hook_numbers_v5(?:_|$)/.test(batch.calculation_version) ? 1 : 0 }, now());
        published++;
      } catch (error) {
        store.finish(batch, error instanceof AiUsageWindowClosed ? 'paused' : 'failed', error.message);
        if (error instanceof AiUsageWindowClosed || error.message === 'AI_USAGE_LEASE_LOST') throw error;
        errors.push({ tenantId: tenant.id, message: error.message });
      } finally { activeBatch = null; }
    }
    return { status: errors.length ? 'partial_failure' : 'completed', published, errors };
  } catch (error) {
    if (error instanceof AiUsageWindowClosed) return { status: 'paused', published };
    throw error;
  } finally {
    database.prepare('DELETE FROM ai_usage_worker_lock WHERE id=1 AND lease_token=?').run(globalToken);
  }
}
