export const HOOK_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
  event_name TEXT NOT NULL,
  matcher_json TEXT NOT NULL DEFAULT '{}',
  gate_json TEXT NOT NULL DEFAULT '{"mode":"all","conditions":[]}',
  advanced_script_json TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_hooks_status_updated
  ON hooks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_hooks_event_name
  ON hooks(event_name);

CREATE TABLE IF NOT EXISTS hook_actions (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (hook_id) REFERENCES hooks(id) ON DELETE CASCADE,
  UNIQUE(hook_id, position)
);

CREATE INDEX IF NOT EXISTS idx_hook_actions_hook_position
  ON hook_actions(hook_id, position);
`;
