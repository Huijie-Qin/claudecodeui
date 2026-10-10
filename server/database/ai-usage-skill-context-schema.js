// Bootstrap owns migration; importing the recorder never opens a database.
export function migrateAiUsageSkillContext(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ai_usage_skill_context (
    tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
    provider TEXT NOT NULL, session_id TEXT, context_kind TEXT NOT NULL,
    context_id TEXT NOT NULL, request_id TEXT, origin TEXT NOT NULL DEFAULT 'unknown',
    skill_name TEXT, subagent_id TEXT, occurred_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(tenant_id,user_id,workspace_id,provider,context_kind,context_id),
    CHECK(context_kind IN ('request','tool','session')),
    CHECK(origin IN ('user','hook','agent_graph','top_skill','unknown'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_skill_context_session
    ON ai_usage_skill_context(tenant_id,user_id,workspace_id,provider,session_id,context_kind,context_id);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_skill_context_request
    ON ai_usage_skill_context(tenant_id,user_id,workspace_id,provider,request_id);`);
  if (!database.prepare('PRAGMA table_info(ai_usage_skill_context)').all().some((column) => column.name === 'subagent_id')) {
    database.exec('ALTER TABLE ai_usage_skill_context ADD COLUMN subagent_id TEXT');
  }
}
