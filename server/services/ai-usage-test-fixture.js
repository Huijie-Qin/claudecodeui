import Database from 'better-sqlite3';

import { migrateAiUsageSchema } from '../database/ai-usage-schema.js';
import { migrateAiUsageExportSchema } from '../database/ai-usage-export-schema.js';

import { createAiUsageAccessService } from './ai-usage-access.js';
import { createAiUsageQueryService } from './ai-usage-query.js';
import { backfillIntegration } from './ai-dashboard-integration.js';
import { backfillSplitDetails } from './ai-dashboard-split.js';

export function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, is_active INTEGER, is_system_admin INTEGER);
    CREATE TABLE tenants(id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE tenant_users(tenant_id INTEGER, user_id INTEGER, role TEXT, status TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY, tenant_id INTEGER, display_name TEXT, status TEXT);
    INSERT INTO users VALUES(1,'platform',1,1),(2,'tenant-admin',1,0),(3,'member',1,0),(4,'another-member',1,0);
    INSERT INTO tenants VALUES(10,'active'),(20,'active');
    INSERT INTO tenant_users VALUES(10,2,'tenant_admin','active'),(10,3,'member','active'),(10,4,'member','active'),(20,3,'member','active');`);
  migrateAiUsageSchema(db);
  migrateAiUsageExportSchema(db);
  const accessService = createAiUsageAccessService({ db });
  const queryService = createAiUsageQueryService({ db, getScheduleStatus: () => ({ enabled: true, timeZone: 'Asia/Shanghai', nextRunAt: '2026-09-13T18:00:00Z' }) });
  const access = accessService.resolve({ tenantId: 10, userId: 2 });
  function batch(id = 'batch-1', tenantId = 10, status = 'published', coverage = {}) {
    db.prepare(`INSERT INTO ai_usage_batches(id,tenant_id,scheduled_for,target_through,completed_at,status,coverage_json,time_zone,calculation_version)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, tenantId, `${id}-schedule`, '2026-09-12T16:00:00.000Z', '2026-09-12T18:10:00.000Z', status, JSON.stringify(coverage), 'Asia/Shanghai', 'test');
    if (status === 'published') {
      db.prepare('DELETE FROM ai_usage_report_rows WHERE tenant_id=?').run(tenantId);
      db.prepare('INSERT OR REPLACE INTO ai_usage_tenant_state(tenant_id,active_batch_id) VALUES(?,?)').run(tenantId, id);
      db.transaction(() => backfillSplitDetails(db, backfillIntegration(db))).immediate();
    }
  }
  function row({ id, dataset, date = '2026-09-11', userId = 3, workspaceId = 7, subjectId = null, sessionKey = 'session-a', value = {}, batchId = 'batch-1', tenantId = 10 }) {
    const values = [tenantId, dataset, id, date, userId, workspaceId, subjectId, sessionKey, `${date}T10:00:00.000Z`, JSON.stringify(value)];
    const active = db.prepare('SELECT active_batch_id FROM ai_usage_tenant_state WHERE tenant_id=?').get(tenantId)?.active_batch_id;
    if (active === batchId) {
      db.prepare('INSERT INTO ai_usage_report_rows VALUES(?,?,?,?,?,?,?,?,?,?)').run(...values);
      materialize();
    }
    else db.prepare('INSERT INTO ai_usage_report_staging VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(batchId, ...values);
  }
  function materialize() {
    db.transaction(() => {
      db.exec("UPDATE ai_usage_batches SET coverage_json=json_remove(coverage_json,'$.integrationVersion')");
      backfillSplitDetails(db, backfillIntegration(db));
    }).immediate();
  }
  return { db, accessService, queryService, access, batch, row, materialize };
}
