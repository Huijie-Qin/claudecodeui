// Independent consumer-facing session table; dashboard fact tables stay intact.
export const SESSION_SUMMARY_VERSION = 4;

export const SESSION_SUMMARY_COLUMNS = [
  'id', 'tenant_id', 'workspace_id', 'user_id', 'provider', 'session_id',
  'user_name', 'total_tokens', 'skill_list', 'start_time', 'end_time', 'ai_active_duration_seconds',
];

export const AI_SESSION_SUMMARY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_session_summary (
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_name TEXT,
  total_tokens INTEGER,
  skill_list TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  ai_active_duration_seconds REAL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS ai_session_summary_staging (
  batch_id TEXT NOT NULL,
  id TEXT NOT NULL,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_name TEXT,
  total_tokens INTEGER,
  skill_list TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  ai_active_duration_seconds REAL,
  PRIMARY KEY (batch_id, tenant_id, id)
);
`;

export function migrateAiSessionSummarySchema(database) {
  database.transaction(() => {
    database.exec(AI_SESSION_SUMMARY_SCHEMA_SQL);
    for (const table of ['ai_session_summary', 'ai_session_summary_staging']) {
      if (!database.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'ai_active_duration_seconds')) {
        // Additive upgrade: existing rows/IDs and prepared candidates are kept.
        // Unknown historical durations stay NULL until the next full refresh.
        database.exec(`ALTER TABLE ${table} ADD COLUMN ai_active_duration_seconds REAL`);
      }
    }
  }).immediate();
}
