import { localParts } from './ai-usage-config.js';

// The caller fences writes with the global lease. Per-row owner predicates also
// protect terminal logging when an obsolete worker unwinds after losing its lease.
export function createAiUsageRunLog(database, { schedule, config, workerToken, now }) {
  const scheduled = schedule.scheduledFor;
  const mode = config.incrementalEnabled === false ? 0 : 1;
  const owner = batch => ({ scheduled, tenant: batch.tenant_id, worker: workerToken, token: batch.lease_token });
  const owned = 'scheduled_for=@scheduled AND tenant_id=@tenant AND worker_lease_token=@worker AND batch_lease_token=@token';

  function initialize(tenants) {
    const time = now().toISOString();
    // Recover evidence of an abandoned owner; updated_at is discovery time,
    // never an invented time of the original crash.
    database.prepare(`UPDATE ai_usage_run_logs SET status='interrupted',reason='lease_lost_or_process_exit',updated_at=?
      WHERE status='running' AND (window_ends_at<=? OR NOT EXISTS(
        SELECT 1 FROM ai_usage_worker_lock w WHERE w.id=1 AND w.lease_token=ai_usage_run_logs.worker_lease_token
        AND w.lease_until>?) OR NOT EXISTS(SELECT 1 FROM ai_usage_batches b
        WHERE b.id=ai_usage_run_logs.batch_id AND b.lease_token=ai_usage_run_logs.batch_lease_token
        AND b.tenant_id=ai_usage_run_logs.tenant_id AND b.status='running' AND b.lease_until>?))`)
      .run(time, time, time, time);
    const existingPublication = database.prepare(`SELECT id,completed_at,coverage_json FROM ai_usage_batches
      WHERE tenant_id=? AND scheduled_for=? AND status='published'`);
    const insert = database.prepare(`INSERT INTO ai_usage_run_logs
      (scheduled_for,tenant_id,run_date,time_zone,window_ends_at,target_through,queue_position,status,
       batch_id,worker_lease_token,incremental_enabled,updated_at,finished_at,reason,stage,published_batches,last_published_batch_id,last_published_at)
      VALUES(@scheduled,@tenant,@date,@zone,@end,@through,@position,@status,@batch,@worker,@mode,@time,@finished,@reason,@stage,@publishedCount,@batch,@finished)
      ON CONFLICT(scheduled_for,tenant_id) DO UPDATE SET queue_position=excluded.queue_position,
        worker_lease_token=CASE WHEN ai_usage_run_logs.status<>'published' THEN excluded.worker_lease_token ELSE ai_usage_run_logs.worker_lease_token END,
        window_ends_at=excluded.window_ends_at,
        reason=CASE WHEN ai_usage_run_logs.status='pending' AND COALESCE(ai_usage_run_logs.reason,'')<>'backlog_remaining'
          THEN 'waiting_for_slot' ELSE ai_usage_run_logs.reason END,
        error=CASE WHEN ai_usage_run_logs.status='pending' AND COALESCE(ai_usage_run_logs.reason,'')<>'backlog_remaining'
          THEN NULL ELSE ai_usage_run_logs.error END,
        updated_at=CASE WHEN ai_usage_run_logs.status='pending' AND COALESCE(ai_usage_run_logs.reason,'')<>'backlog_remaining'
          THEN excluded.updated_at ELSE ai_usage_run_logs.updated_at END`);
    const confirmPublication = database.prepare(`UPDATE ai_usage_run_logs SET status='published',batch_id=@batch,
      incremental_enabled=@mode,updated_at=@time,finished_at=@finished,stage='publish',error=NULL,
      reason=CASE WHEN status='published' AND attempt_count>0 THEN reason ELSE 'already_published' END,
      published_batches=MAX(1,published_batches+CASE WHEN last_published_batch_id IS @batch THEN 0 ELSE 1 END),
      last_published_batch_id=@batch,last_published_at=@finished
      WHERE scheduled_for=@scheduled AND tenant_id=@tenant
        AND (status<>'published' OR batch_id IS NOT @batch OR last_published_batch_id IS NOT @batch OR published_batches<1)`);
    for (const [position, tenant] of tenants.entries()) {
      const published = existingPublication.get(tenant.id, scheduled);
      const publishedMode = published ? JSON.parse(published.coverage_json || '{}').incrementalEnabled : null;
      const observedMode = typeof publishedMode === 'boolean' ? Number(publishedMode) : null;
      insert.run({ scheduled, tenant: tenant.id, date: localParts(scheduled, config.timeZone).date,
        zone: config.timeZone, end: schedule.windowEndsAt, through: schedule.targetThrough, position: position + 1,
        status: published ? 'published' : 'pending', batch: published?.id ?? null, worker: workerToken,
        mode: published ? observedMode : mode, publishedCount: published ? 1 : 0, stage: published ? 'publish' : null,
        time, finished: published?.completed_at ?? null, reason: published ? 'already_published' : 'waiting_for_slot' });
      if (published) confirmPublication.run({ scheduled, tenant: tenant.id, batch: published.id,
        mode: observedMode, time, finished: published.completed_at ?? null });
    }
    database.prepare(`UPDATE ai_usage_run_logs SET status='skipped',reason='tenant_inactive',updated_at=?
      WHERE scheduled_for=? AND status IN ('pending','paused','failed','interrupted')
      AND NOT EXISTS(SELECT 1 FROM tenants t WHERE t.id=ai_usage_run_logs.tenant_id AND t.status='active')`).run(time, scheduled);
  }

  function claimed(batch) {
    const time = now().toISOString();
    database.prepare(`UPDATE ai_usage_run_logs SET status='running',batch_id=@batch,worker_lease_token=@worker,
      batch_lease_token=@token,incremental_enabled=@mode,attempt_count=attempt_count+1,
      started_at=COALESCE(started_at,@time),last_started_at=@time,updated_at=@time,finished_at=NULL,
      stage=@stage,error=NULL,reason=NULL
      WHERE scheduled_for=@scheduled AND tenant_id=@tenant`).run({ ...owner(batch), batch: batch.id, time,
      mode: JSON.parse(batch.coverage_json || '{}').incrementalEnabled === false ? 0 : 1,
      stage: JSON.parse(batch.progress_json || '{}').stage || 'bootstrap' });
  }

  function notClaimed(tenantId) {
    const published = database.prepare("SELECT id,completed_at FROM ai_usage_batches WHERE tenant_id=? AND scheduled_for=? AND status='published'")
      .get(tenantId, scheduled);
    if (published) return;
    const held = database.prepare("SELECT id FROM ai_usage_batches WHERE tenant_id=? AND status='running' AND lease_until>? LIMIT 1")
      .get(tenantId, now().toISOString());
    database.prepare(`UPDATE ai_usage_run_logs SET batch_id=COALESCE(?,batch_id),reason=?,updated_at=?
      WHERE scheduled_for=? AND tenant_id=? AND worker_lease_token=? AND status<>'published'`)
      .run(held?.id ?? null, held ? 'tenant_lease_held' : 'batch_not_claimed', now().toISOString(), scheduled, tenantId, workerToken);
  }

  function checkpoint(batch, progress) {
    database.prepare(`UPDATE ai_usage_run_logs SET stage=@stage,updated_at=@time WHERE ${owned} AND status='running'`)
      .run({ ...owner(batch), stage: progress.stage || null, time: now().toISOString() });
  }

  function published(batch) {
    const time = now().toISOString();
    const currentWindow = batch.scheduled_for === scheduled;
    database.prepare(`UPDATE ai_usage_run_logs SET status=@status,stage='publish',updated_at=@time,finished_at=@finished,
      reason=@reason,error=NULL,published_batches=published_batches+CASE WHEN last_published_batch_id IS @batch THEN 0 ELSE 1 END,
      last_published_batch_id=@batch,last_published_at=@time
      WHERE ${owned} AND status='running'`).run({ ...owner(batch), batch: batch.id, time,
      status: currentWindow ? 'published' : 'pending', finished: currentWindow ? time : null,
      reason: currentWindow ? null : 'backlog_remaining' });
  }

  function finished(batch, status, error, reason, progress) {
    database.prepare(`UPDATE ai_usage_run_logs SET status=@status,stage=@stage,error=@error,reason=@reason,
      updated_at=@time,finished_at=@time WHERE ${owned} AND status='running'`).run({ ...owner(batch), status,
      stage: progress.stage || null, error: error || null, reason: reason || null, time: now().toISOString() });
  }

  function claimFailed(tenantId, error) {
    database.prepare(`UPDATE ai_usage_run_logs SET status='failed',stage='claim',error=?,reason='claim_failed',updated_at=?,finished_at=?
      WHERE scheduled_for=? AND tenant_id=? AND worker_lease_token=? AND status<>'published'`)
      .run(error.message, now().toISOString(), now().toISOString(), scheduled, tenantId, workerToken);
  }

  function finalize(reason, error = null) {
    database.prepare(`UPDATE ai_usage_run_logs SET reason=?,error=COALESCE(?,error),updated_at=?
      WHERE scheduled_for=? AND worker_lease_token=? AND status='pending' AND reason='waiting_for_slot'`)
      .run(reason, error, now().toISOString(), scheduled, workerToken);
  }

  return { initialize, claimed, notClaimed, checkpoint, published, finished, claimFailed, finalize };
}
