import { localParts, shiftDate } from './ai-usage-config.js';

// One changed interaction day can alter this day and the next 29 rolling MAUs.
// Called once per completed daily partition, not once per incoming message.
export function markActivityDays(database, tenantId, date) {
  const dirty = database.prepare(`INSERT INTO ai_usage_dirty_activity_days(tenant_id,stat_date)
    VALUES(?,?) ON CONFLICT(tenant_id,stat_date) DO UPDATE SET generation=generation+1`);
  for (let offset = 0; offset < 30; offset++) dirty.run(tenantId, shiftDate(date, offset));
}

export async function buildActivityDays({ store, batch, config, progress, checkpoint, checkWindow }) {
  const db = store.database;
  const through = localParts(batch.target_through, batch.time_zone).date;
  while (true) {
    checkWindow();
    const day = db.prepare(`SELECT * FROM ai_usage_dirty_activity_days
      WHERE tenant_id=? AND stat_date<? ORDER BY stat_date LIMIT 1`).get(batch.tenant_id, through);
    if (!day) return;
    if (!progress.activity || progress.activity.date !== day.stat_date) {
      store.transaction(() => {
        store.assertLease(batch);
        db.prepare("DELETE FROM ai_usage_report_staging WHERE batch_id=? AND dataset='active_users' AND stat_date=?")
          .run(batch.id, day.stat_date);
        progress.activity = { date: day.stat_date, cursor: '' };
        store.checkpoint(batch, progress, config);
      });
      await checkpoint();
    }
    const target = progress.activity;
    const params = { batch: batch.id, tenant: batch.tenant_id, from: shiftDate(day.stat_date, -29),
      date: day.stat_date, limit: config.batchSize };
    while (true) {
      checkWindow();
      // Read daily user/workspace/provider presence, not sessions or messages.
      // Membership preserves exact deduplication under overlapping filters.
      const rows = db.prepare(`WITH daily AS NOT MATERIALIZED (
        SELECT r.* FROM ai_usage_report_staging r
        WHERE r.batch_id=@batch AND r.dataset='daily_active_users' AND r.stat_date BETWEEN @from AND @date
          AND r.tenant_id=@tenant AND r.row_key>@cursor
      ), next_keys AS MATERIALIZED (SELECT DISTINCT row_key FROM daily ORDER BY row_key LIMIT @limit)
      SELECT d.row_key,MAX(d.user_id) AS user_id,MAX(d.workspace_id) AS workspace_id,
        MAX(json_extract(d.value_json,'$.provider')) AS provider,
        MAX(json_extract(d.value_json,'$.userName')) AS user_name,
        MAX(json_extract(d.value_json,'$.workspaceName')) AS workspace_name,
        MAX(CASE WHEN d.stat_date=@date THEN 1 ELSE 0 END) AS is_dau
      FROM daily d JOIN next_keys k ON k.row_key=d.row_key GROUP BY d.row_key ORDER BY d.row_key`)
        .all({ ...params, cursor: target.cursor });
      if (!rows.length) break;
      store.transaction(() => {
        store.assertLease(batch);
        const write = db.prepare(`INSERT OR REPLACE INTO ai_usage_report_staging
          (batch_id,tenant_id,dataset,row_key,stat_date,user_id,workspace_id,value_json)
          VALUES(?,?,'active_users',?,?,?,?,?)`);
        for (const row of rows) write.run(batch.id, batch.tenant_id, row.row_key, day.stat_date,
          row.user_id, row.workspace_id, JSON.stringify({ provider: row.provider, userName: row.user_name,
            workspaceName: row.workspace_name, isDau: row.is_dau === 1, isMau: true }));
        target.cursor = rows.at(-1).row_key;
        store.checkpoint(batch, progress, config);
      });
      await checkpoint();
    }
    store.transaction(() => {
      store.assertLease(batch);
      db.prepare('DELETE FROM ai_usage_dirty_activity_days WHERE tenant_id=? AND stat_date=? AND generation=?')
        .run(batch.tenant_id, day.stat_date, day.generation);
      delete progress.activity;
      store.checkpoint(batch, progress, config);
    });
    await checkpoint();
  }
}
