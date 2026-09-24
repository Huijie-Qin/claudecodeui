import { backfillIntegration } from '../services/ai-dashboard-integration.js';
import { migrateSplitDetails } from '../services/ai-dashboard-split.js';

import { migrateAiUsageSkillContext } from './ai-usage-skill-context-schema.js';
import { AI_USAGE_REPORT_SCHEMA_SQL, migrateAiUsageReportRows } from './ai-usage-report-schema.js';
import { AI_DASHBOARD_INTEGRATION_SCHEMA_SQL, migrateIntegrationId } from './ai-dashboard-integration-schema.js';
import { AI_SESSION_SUMMARY_SCHEMA_SQL, migrateAiSessionSummarySchema } from './ai-session-summary-schema.js';


export const AI_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_usage_turn_facts (
  turn_key TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL, session_key TEXT, provider TEXT NOT NULL,
  request_key TEXT, started_at TEXT NOT NULL, response_completed_at TEXT,
  terminal_at TEXT, terminal_status TEXT NOT NULL DEFAULT 'pending', source TEXT,
  generation INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_turn_tenant ON ai_usage_turn_facts(tenant_id, started_at, turn_key);
CREATE TABLE IF NOT EXISTS ai_usage_dirty_tenants (tenant_id INTEGER PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ai_usage_worker_lock (id INTEGER PRIMARY KEY CHECK(id=1), lease_token TEXT, lease_until TEXT);
CREATE TABLE IF NOT EXISTS ai_usage_source_changes (
  tenant_id INTEGER NOT NULL, source_type TEXT NOT NULL, source_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id, source_type, source_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_source_states (
  tenant_id INTEGER NOT NULL, source_key TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, mtime_ms REAL, identity TEXT, fingerprint TEXT,
  state_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT,
  PRIMARY KEY(tenant_id, source_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_batch_files (
  batch_id TEXT NOT NULL, source_key TEXT NOT NULL, readable INTEGER NOT NULL,
  PRIMARY KEY(batch_id,source_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_fact_rows (
  tenant_id INTEGER NOT NULL, source_key TEXT NOT NULL, dataset TEXT NOT NULL, row_key TEXT NOT NULL,
  stat_date TEXT NOT NULL, user_id INTEGER, workspace_id INTEGER, subject_id TEXT, session_key TEXT,
  occurred_at TEXT, value_json TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id, source_key, dataset, row_key)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_facts_partition ON ai_usage_fact_rows(tenant_id,dataset,stat_date);
CREATE INDEX IF NOT EXISTS idx_ai_usage_facts_cursor ON ai_usage_fact_rows(tenant_id,dataset,stat_date,row_key,priority DESC,source_key);
CREATE INDEX IF NOT EXISTS idx_ai_usage_facts_session ON ai_usage_fact_rows(tenant_id,dataset,session_key,row_key,source_key);
CREATE INDEX IF NOT EXISTS idx_ai_usage_skill_boundaries ON ai_usage_fact_rows(tenant_id,session_key,occurred_at,row_key)
  WHERE dataset='skill_evidence' AND json_extract(value_json,'$.kind')='boundary';
CREATE TABLE IF NOT EXISTS ai_usage_dirty_skill_sessions (
  tenant_id INTEGER NOT NULL, session_key TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,session_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_skill_groups (
  tenant_id INTEGER NOT NULL, session_key TEXT NOT NULL, group_key TEXT NOT NULL,
  PRIMARY KEY(tenant_id,session_key,group_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_skill_work_items (
  batch_id TEXT NOT NULL, session_key TEXT NOT NULL, group_key TEXT NOT NULL,
  kind TEXT NOT NULL, item_key TEXT NOT NULL, source_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(batch_id,session_key,group_key,kind,item_key,source_key)
);
CREATE TABLE IF NOT EXISTS ai_usage_dirty_partitions (
  tenant_id INTEGER NOT NULL, dataset TEXT NOT NULL, stat_date TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(tenant_id,dataset,stat_date)
);
CREATE TABLE IF NOT EXISTS ai_usage_dirty_activity_days (
  tenant_id INTEGER NOT NULL, stat_date TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id,stat_date)
);
CREATE TABLE IF NOT EXISTS ai_usage_batches (
  id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, scheduled_for TEXT NOT NULL,
  target_through TEXT NOT NULL, source_read_at TEXT, completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', error TEXT, coverage_json TEXT NOT NULL DEFAULT '{}',
  time_zone TEXT NOT NULL, calculation_version TEXT NOT NULL,
  lease_token TEXT, lease_until TEXT, progress_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(tenant_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_batch_state ON ai_usage_batches(tenant_id,status,scheduled_for);
CREATE TABLE IF NOT EXISTS ai_usage_tenant_state (
  tenant_id INTEGER PRIMARY KEY, active_batch_id TEXT, bootstrapped INTEGER NOT NULL DEFAULT 0,
  bootstrap_json TEXT NOT NULL DEFAULT '{}', time_zone TEXT, calculation_version TEXT,
  data_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_usage_suppressed_rows (
  tenant_id INTEGER NOT NULL, dataset TEXT NOT NULL, row_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(tenant_id,dataset,row_key)
);
${AI_USAGE_REPORT_SCHEMA_SQL}
${AI_DASHBOARD_INTEGRATION_SCHEMA_SQL}
${AI_SESSION_SUMMARY_SCHEMA_SQL}
CREATE TABLE IF NOT EXISTS ai_skill_publications (
  operation_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  skill_id TEXT, skill_name TEXT, first_published_at TEXT, status TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_skill_publish_events (
  id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL, skill_id TEXT, skill_name TEXT NOT NULL,
  publish_kind TEXT NOT NULL, status TEXT NOT NULL,
  requested_at TEXT NOT NULL, published_at TEXT, finished_at TEXT,
  published_version INTEGER, failure_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_skill_publish_event_history
  ON ai_skill_publish_events(tenant_id,skill_id,status,published_at);
CREATE TABLE IF NOT EXISTS ai_skill_binding_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
  local_name TEXT NOT NULL, remote_skill_id TEXT NOT NULL, publisher_user_id INTEGER,
  publisher_account_id TEXT, valid_from TEXT NOT NULL, valid_to TEXT, evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_skill_history_lookup ON ai_skill_binding_history(tenant_id,workspace_id,local_name,valid_from);
CREATE INDEX IF NOT EXISTS idx_ai_skill_history_remote ON ai_skill_binding_history(tenant_id,remote_skill_id,workspace_id);
CREATE INDEX IF NOT EXISTS idx_ai_skill_publication_publisher ON ai_skill_publications(tenant_id,skill_id,status,first_published_at);
`;

function exists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

// Triggers write only an identity/version, never a second message payload. They
// cover UPSERTs and deletes as well as inserts and run in the business transaction.
export function migrateAiUsageSchema(database) {
  migrateAiUsageReportRows(database);
  database.exec(AI_USAGE_SCHEMA_SQL);
  migrateAiSessionSummarySchema(database);
  migrateIntegrationId(database);
  migrateAiUsageSkillContext(database);
  // Immediate redaction is metadata-driven and affects both published views.
  // Ordinary corrections still wait for the atomic nightly refresh.
  database.exec(`DROP TRIGGER IF EXISTS ai_usage_integration_suppress_insert;
    CREATE TRIGGER ai_usage_integration_suppress_insert
    AFTER INSERT ON ai_usage_suppressed_rows BEGIN
      DELETE FROM ai_dashboard_integration_detail WHERE tenant_id=NEW.tenant_id AND (
        (NEW.dataset IN ('sql_generations','hook_records') AND sql_record_id=NEW.row_key) OR
        (NEW.dataset='code_submissions' AND code_submission_id=NEW.row_key) OR
        (NEW.dataset='skill_publications' AND skill_publish_count=1 AND skill_id IN (
          SELECT subject_id FROM ai_usage_report_rows WHERE tenant_id=NEW.tenant_id
            AND dataset=NEW.dataset AND row_key=NEW.row_key)));
      DELETE FROM ai_dashboard_integration_staging WHERE tenant_id=NEW.tenant_id AND (
        (NEW.dataset IN ('sql_generations','hook_records') AND sql_record_id=NEW.row_key) OR
        (NEW.dataset='code_submissions' AND code_submission_id=NEW.row_key) OR
        (NEW.dataset='skill_publications' AND skill_publish_count=1 AND skill_id IN (
          SELECT subject_id FROM ai_usage_report_rows WHERE tenant_id=NEW.tenant_id
            AND dataset=NEW.dataset AND row_key=NEW.row_key)));
    END;`);
  const definitions = [
    ['agent_session_messages', 'message', 'id', 'tenant_id'],
    ['ai_usage_turn_facts', 'turn', 'turn_key', 'tenant_id'],
    ['hook_data_records', 'hook', 'id', 'tenant_id'],
    ['hook_executions', 'hook_execution', 'id', 'tenant_id'],
    ['workspace_agent_template_snapshots', 'template', 'workspace_id', null],
    ['ai_skill_publications', 'publication', 'operation_id', 'tenant_id'],
    ['ai_skill_publish_events', 'publication_event', 'id', 'tenant_id'],
    ['ai_mr_submissions', 'code_submission', 'id', 'tenant_id'],
  ];
  for (const [table, type, key, tenantColumn] of definitions) {
    if (!exists(database, table)) continue;
    if (!tenantColumn && !exists(database, 'workspaces')) continue;
    const tenant = (alias) => tenantColumn ? `${alias}.${tenantColumn}`
      : `(SELECT tenant_id FROM workspaces WHERE id=${alias}.workspace_id)`;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const aliases = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
      const statements = aliases.map((alias) => `
        INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key,generation)
        SELECT ${tenant(alias)}, '${type}', CAST(${alias}.${key} AS TEXT), 1 WHERE ${tenant(alias)} IS NOT NULL
        ON CONFLICT(tenant_id,source_type,source_key) DO UPDATE SET generation=generation+1;`).join('\n');
      database.exec(`CREATE TRIGGER IF NOT EXISTS ai_usage_${type}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} BEGIN ${statements} END;`);
    }
  }
  // Request/tool metadata changes can correct an already-indexed invocation
  // without changing the native transcript. These triggers enqueue identities
  // only; correlation and historical partition replacement happen at night.
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const aliases = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    database.exec(`CREATE TRIGGER IF NOT EXISTS ai_usage_skill_context_${operation.toLowerCase()}
      AFTER ${operation} ON ai_usage_skill_context BEGIN ${aliases.map((alias) => `
      INSERT INTO ai_usage_dirty_skill_sessions(tenant_id,session_key)
      SELECT ${alias}.tenant_id,json_array(${alias}.tenant_id,${alias}.workspace_id,${alias}.user_id,${alias}.provider,${alias}.session_id)
      WHERE ${alias}.session_id IS NOT NULL AND ${alias}.session_id<>''
      ON CONFLICT(tenant_id,session_key) DO UPDATE SET generation=generation+1;`).join('\n')} END;`);
    database.exec(`CREATE TRIGGER IF NOT EXISTS ai_usage_skill_binding_${operation.toLowerCase()}
      AFTER ${operation} ON ai_skill_binding_history BEGIN ${aliases.map((alias) => `
      INSERT INTO ai_usage_source_changes(tenant_id,source_type,source_key)
      VALUES(${alias}.tenant_id,'skill_binding',CAST(${alias}.workspace_id AS TEXT))
      ON CONFLICT(tenant_id,source_type,source_key) DO UPDATE SET generation=generation+1;`).join('\n')} END;`);
  }
  if (exists(database, 'hook_data_records')) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS ai_usage_hook_suppress_delete AFTER DELETE ON hook_data_records
      WHEN OLD.tenant_id IS NOT NULL BEGIN
      INSERT OR REPLACE INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(OLD.tenant_id,'hook_records',OLD.id);
      INSERT INTO ai_usage_tenant_state(tenant_id,data_revision) VALUES(OLD.tenant_id,1)
        ON CONFLICT(tenant_id) DO UPDATE SET data_revision=data_revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS ai_usage_hook_unsuppress_insert AFTER INSERT ON hook_data_records BEGIN
      DELETE FROM ai_usage_suppressed_rows WHERE tenant_id=NEW.tenant_id AND dataset='hook_records' AND row_key=NEW.id;
    END;`);
  }
  if (exists(database, 'hook_executions')) database.exec(`
    CREATE TRIGGER IF NOT EXISTS ai_usage_hook_execution_suppress_delete AFTER DELETE ON hook_executions
    WHEN OLD.tenant_id IS NOT NULL BEGIN
      INSERT OR REPLACE INTO ai_usage_suppressed_rows(tenant_id,dataset,row_key) VALUES(OLD.tenant_id,'hook_executions',OLD.id);
    END;
    CREATE TRIGGER IF NOT EXISTS ai_usage_hook_execution_unsuppress_insert AFTER INSERT ON hook_executions BEGIN
      DELETE FROM ai_usage_suppressed_rows WHERE tenant_id=NEW.tenant_id AND dataset='hook_executions' AND row_key=NEW.id;
    END;`);
  // Migrate only the current published snapshot, never independently recalculate
  // business metrics. The backfill and its ready marker become visible together.
  database.transaction(() => {
    const changedTenants = exists(database, 'users') && exists(database, 'workspaces') ? backfillIntegration(database) : [];
    migrateSplitDetails(database, changedTenants);
  }).immediate();
}
