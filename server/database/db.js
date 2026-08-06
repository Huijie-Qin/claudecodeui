import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import Database from 'better-sqlite3';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import {
  APP_CONFIG_TABLE_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SQL,
  VAPID_KEYS_TABLE_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SQL,
  USER_INVITATIONS_TABLE_SQL,
  USER_INVITATIONS_TOKEN_INDEX_SQL,
  USER_INVITATIONS_USER_INDEX_SQL,
  USER_PASSWORD_RESETS_TABLE_SQL,
  USER_PASSWORD_RESETS_TOKEN_INDEX_SQL,
  USER_PASSWORD_RESETS_USER_INDEX_SQL,
  SESSION_NAMES_TABLE_SQL,
  SESSION_NAMES_LOOKUP_INDEX_SQL,
  CODEHUB_REPOSITORIES_TABLE_SQL,
  CODEHUB_REPOSITORIES_USER_INDEX_SQL,
  CODEHUB_WORKSPACE_REPOSITORIES_TABLE_SQL,
  CODEHUB_WORKSPACE_REPOSITORIES_LOOKUP_INDEX_SQL,
  AI_MR_SUBMISSIONS_TABLE_SQL,
  AI_MR_SUBMISSIONS_POLL_INDEX_SQL,
  AI_MR_SUBMISSIONS_TENANT_STATS_INDEX_SQL,
  AI_MR_SUBMISSIONS_USER_STATS_INDEX_SQL,
  AI_MR_SUBMISSION_FILES_TABLE_SQL,
  AI_MR_SUBMISSION_FILES_SUBMISSION_INDEX_SQL,
  DATABASE_SCHEMA_SQL
} from './schema.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';
import { migrateExistingScheduledTasksToNew } from './scheduled-task-migrations.js';
import { DEFAULT_MODEL_RESPONSE_HOOK_CONFIG, normalizeModelResponseHookConfig } from './model-response-hooks.js';
import {
  decryptUserEnvRecord,
  decryptSecretString,
  encryptSecretString,
  ensureUserKeyEnvRecord,
  parseUserEnvJson,
  serializeUserEnvRecord,
  USER_KEY_ENV_NAME,
} from './user-env.js';

const __dirname = getModuleDir(import.meta.url);
// The compiled backend lives under dist-server/server/database, but the install root we log
// should still point at the project/app root. Resolving it here avoids build-layout drift.
const APP_ROOT = findAppRoot(__dirname);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

const USER_KEY_ENCRYPTION_SECRET_CONFIG_KEY = 'user_key_encryption_secret';
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(APP_CONFIG_TABLE_SQL);

// Show app installation path prominently
const appInstallPath = APP_ROOT;
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    if (!columnNames.includes('git_name')) {
      console.log('Running migration: Adding git_name column');
      db.exec('ALTER TABLE users ADD COLUMN git_name TEXT');
    }

    if (!columnNames.includes('git_email')) {
      console.log('Running migration: Adding git_email column');
      db.exec('ALTER TABLE users ADD COLUMN git_email TEXT');
    }

    if (!columnNames.includes('git_token')) {
      console.log('Running migration: Adding git_token column');
      db.exec('ALTER TABLE users ADD COLUMN git_token TEXT');
    }

    if (!columnNames.includes('has_completed_onboarding')) {
      console.log('Running migration: Adding has_completed_onboarding column');
      db.exec('ALTER TABLE users ADD COLUMN has_completed_onboarding BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('is_system_admin')) {
      console.log('Running migration: Adding is_system_admin column');
      db.exec('ALTER TABLE users ADD COLUMN is_system_admin BOOLEAN DEFAULT 0');
    }

    if (!columnNames.includes('env')) {
      console.log('Running migration: Adding env column');
      db.exec("ALTER TABLE users ADD COLUMN env TEXT DEFAULT '{}'");
    }

    if (!columnNames.includes('env_visibility')) {
      console.log('Running migration: Adding env_visibility column');
      db.exec("ALTER TABLE users ADD COLUMN env_visibility TEXT DEFAULT '{}'");
    }

    if (!columnNames.includes('env_encrypted')) {
      console.log('Running migration: Adding env_encrypted column');
      db.exec("ALTER TABLE users ADD COLUMN env_encrypted TEXT DEFAULT '{}'");
    }

    backfillExistingUserEnvRecords();

    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SQL);
    db.exec(VAPID_KEYS_TABLE_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SQL);
    db.exec(USER_INVITATIONS_TABLE_SQL);
    db.exec(USER_INVITATIONS_TOKEN_INDEX_SQL);
    db.exec(USER_INVITATIONS_USER_INDEX_SQL);
    db.exec(USER_PASSWORD_RESETS_TABLE_SQL);
    db.exec(USER_PASSWORD_RESETS_TOKEN_INDEX_SQL);
    db.exec(USER_PASSWORD_RESETS_USER_INDEX_SQL);
    db.exec(APP_CONFIG_TABLE_SQL);
    db.exec(SESSION_NAMES_TABLE_SQL);
    db.exec(SESSION_NAMES_LOOKUP_INDEX_SQL);
    db.exec(CODEHUB_REPOSITORIES_TABLE_SQL);
    db.exec(CODEHUB_REPOSITORIES_USER_INDEX_SQL);
    db.exec(CODEHUB_WORKSPACE_REPOSITORIES_TABLE_SQL);
    db.exec(CODEHUB_WORKSPACE_REPOSITORIES_LOOKUP_INDEX_SQL);
    db.exec(AI_MR_SUBMISSIONS_TABLE_SQL);
    db.exec(AI_MR_SUBMISSIONS_POLL_INDEX_SQL);
    db.exec(AI_MR_SUBMISSIONS_TENANT_STATS_INDEX_SQL);
    db.exec(AI_MR_SUBMISSIONS_USER_STATS_INDEX_SQL);
    db.exec(AI_MR_SUBMISSION_FILES_TABLE_SQL);
    db.exec(AI_MR_SUBMISSION_FILES_SUBMISSION_INDEX_SQL);
    ensureAiMrSubmissionColumns();
    migrateSqlCheckPreferencesToWorkspaceScope();
    db.exec(MULTITENANCY_SCHEMA_SQL);
    runMultitenancyMigrations();

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

function runMultitenancyMigrations() {
  ensureColumn('tenants', 'prod_code', 'TEXT');
  migrateLegacyTenantProdCode();

  const mcpPresetColumns = db
    .prepare("PRAGMA table_info(mcp_server_presets)")
    .all()
    .map((col) => col.name);

  if (!mcpPresetColumns.includes('preinstall_scope')) {
    console.log('Running migration: Adding mcp_server_presets.preinstall_scope column');
    db.exec("ALTER TABLE mcp_server_presets ADD COLUMN preinstall_scope TEXT NOT NULL DEFAULT 'none'");
  }

  ensureColumn('workspace_mcp_preset_installs', 'tool_settings_json', "TEXT NOT NULL DEFAULT '{}'");

  const scheduledTaskColumns = db
    .prepare("PRAGMA table_info(scheduled_session_tasks)")
    .all()
    .map((col) => col.name);

  if (!scheduledTaskColumns.includes('schedule_type')) {
    console.log('Running migration: Adding scheduled_session_tasks.schedule_type column');
    db.exec("ALTER TABLE scheduled_session_tasks ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'interval'");
  }

  if (!scheduledTaskColumns.includes('schedule_cron')) {
    console.log('Running migration: Adding scheduled_session_tasks.schedule_cron column');
    db.exec('ALTER TABLE scheduled_session_tasks ADD COLUMN schedule_cron TEXT');
  }

  if (!scheduledTaskColumns.includes('schedule_start_at')) {
    console.log('Running migration: Adding scheduled_session_tasks.schedule_start_at column');
    db.exec('ALTER TABLE scheduled_session_tasks ADD COLUMN schedule_start_at TEXT');
    db.exec('UPDATE scheduled_session_tasks SET schedule_start_at = next_run_at WHERE schedule_start_at IS NULL');
  }

  if (!scheduledTaskColumns.includes('session_mode')) {
    console.log('Running migration: Adding scheduled_session_tasks.session_mode column');
    db.exec("ALTER TABLE scheduled_session_tasks ADD COLUMN session_mode TEXT NOT NULL DEFAULT 'new'");
  }

  const sessionModeMigration = migrateExistingScheduledTasksToNew(db);
  if (sessionModeMigration.applied) {
    console.log(`Running migration: Restored ${sessionModeMigration.updatedTasks} existing scheduled tasks to new-session mode`);
  }

  db.exec(`
    UPDATE session_index
    SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
    WHERE provider_session_id LIKE 'scheduled-task-%'
      AND status != 'deleted'
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcp_server_presets_tenant_preinstall
      ON mcp_server_presets(tenant_id, preinstall_scope, status)
  `);

}

function hasTable(tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function getColumnNames(tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((col) => col.name);
}

function ensureColumn(tableName, columnName, columnDefinition) {
  const columnNames = getColumnNames(tableName);
  if (columnNames.includes(columnName)) {
    return;
  }

  console.log(`Running migration: Adding ${tableName}.${columnName} column`);
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function migrateLegacyTenantProdCode() {
  const tenantColumns = getColumnNames('tenants');
  if (!tenantColumns.includes('prod_tenant_id')) {
    return;
  }

  console.log('Running migration: Copying tenants.prod_tenant_id to tenants.prod_code');
  db.prepare(`
    UPDATE tenants
    SET prod_code = prod_tenant_id
    WHERE (prod_code IS NULL OR prod_code = '')
      AND prod_tenant_id IS NOT NULL
      AND prod_tenant_id != ''
  `).run();
}

function ensureAiMrSubmissionColumns() {
  if (!hasTable('ai_mr_submissions')) {
    return;
  }
  ensureColumn('ai_mr_submissions', 'description', 'TEXT');
  ensureColumn('ai_mr_submissions', 'binary_source', 'TEXT');
  ensureColumn('ai_mr_submissions', 'mr_title', 'TEXT');
  ensureColumn('ai_mr_submissions', 'updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP');
}

function migrateSqlCheckPreferencesToWorkspaceScope() {
  if (!hasTable('user_sql_check_preferences')) {
    return;
  }

  const preferenceColumns = getColumnNames('user_sql_check_preferences');
  if (preferenceColumns.includes('workspace_id')) {
    return;
  }

  console.log('Running migration: Moving SQL check user preferences to workspace scope');
  const hasRulesTable = hasTable('user_sql_check_rules');
  const customEnabledExpression = preferenceColumns.includes('custom_enabled')
    ? 'COALESCE(p.custom_enabled, 0)'
    : '0';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS user_sql_check_rules_legacy;
      DROP TABLE IF EXISTS user_sql_check_preferences_legacy;
    `);

    if (hasRulesTable) {
      db.exec('ALTER TABLE user_sql_check_rules RENAME TO user_sql_check_rules_legacy');
    }
    db.exec('ALTER TABLE user_sql_check_preferences RENAME TO user_sql_check_preferences_legacy');

    db.exec(MULTITENANCY_SCHEMA_SQL);

    db.exec(`
      INSERT OR IGNORE INTO user_sql_check_preferences (
        tenant_id,
        workspace_id,
        user_id,
        custom_enabled,
        created_at,
        updated_at
      )
      SELECT
        p.tenant_id,
        w.id,
        p.user_id,
        ${customEnabledExpression},
        p.created_at,
        p.updated_at
      FROM user_sql_check_preferences_legacy p
      JOIN workspaces w
        ON w.tenant_id = p.tenant_id
       AND (
          w.owner_user_id = p.user_id
          OR EXISTS (
            SELECT 1
            FROM workspace_acl acl
            WHERE acl.workspace_id = w.id
              AND acl.user_id = p.user_id
          )
       )
    `);

    if (hasRulesTable) {
      db.exec(`
        INSERT OR IGNORE INTO user_sql_check_rules (
          tenant_id,
          workspace_id,
          user_id,
          rule_id,
          sort_order,
          created_at,
          updated_at
        )
        SELECT
          r.tenant_id,
          p.workspace_id,
          r.user_id,
          r.rule_id,
          r.sort_order,
          r.created_at,
          r.updated_at
        FROM user_sql_check_rules_legacy r
        JOIN user_sql_check_preferences p
          ON p.tenant_id = r.tenant_id
         AND p.user_id = r.user_id
      `);
    }

    db.exec(`
      DROP TABLE IF EXISTS user_sql_check_rules_legacy;
      DROP TABLE IF EXISTS user_sql_check_preferences_legacy;
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_sql_check_rules_owner_order
        ON user_sql_check_rules(workspace_id, user_id, sort_order)
    `);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    db.exec(DATABASE_SCHEMA_SQL);
    console.log('Database initialized successfully');
    runMigrations();
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

function getUserKeyEncryptionSecret() {
  const configured = process.env.PROXY_ENCRYPTION_KEY;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured;
  }

  let secret = appConfigDb.get(USER_KEY_ENCRYPTION_SECRET_CONFIG_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    appConfigDb.set(USER_KEY_ENCRYPTION_SECRET_CONFIG_KEY, secret);
  }
  return secret;
}

function buildUserEnvJson(value = {}) {
  const env = ensureUserKeyEnvRecord(parseUserEnvJson(value), {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
  return serializeUserEnvRecord(env);
}

function ensureUserEnvForRow(row) {
  if (!row) return null;
  const env = ensureUserKeyEnvRecord(parseUserEnvJson(row.env), {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
  const envJson = serializeUserEnvRecord(env);

  if (row.env !== envJson) {
    db.prepare('UPDATE users SET env = ? WHERE id = ?').run(envJson, row.id);
  }

  return env;
}

function normalizeUserEnvEncryptedRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ENV_NAME_PATTERN.test(String(key)))
      .map(([key, entry]) => [String(key), entry === true]),
  );
}

function parseUserEnvEncryptedJson(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeUserEnvEncryptedRecord(value);
  }

  try {
    return normalizeUserEnvEncryptedRecord(JSON.parse(String(value)));
  } catch {
    return {};
  }
}

function serializeUserEnvEncryptedRecord(value) {
  return JSON.stringify(normalizeUserEnvEncryptedRecord(value));
}

function buildUserEnvUpdateResult(env = {}, encrypted = {}) {
  const secretMaterial = getUserKeyEncryptionSecret();
  const encryptedKeys = parseUserEnvEncryptedJson(encrypted);

  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => {
      if (name === USER_KEY_ENV_NAME) {
        return [name, value];
      }

      if (encryptedKeys[name] === true) {
        return [name, encryptSecretString(String(value), { secretMaterial })];
      }

      return [name, String(value)];
    }),
  );
}

function buildClaudeEnvUpdateResult(row, envPatch, visibilityPatch = {}, encryptedPatch = {}) {
  const existingEnv = ensureUserEnvForRow(row);
  const existingVisibility = parseUserEnvVisibilityJson(row.env_visibility);
  const existingEncrypted = parseUserEnvEncryptedJson(row.env_encrypted);
  const preparedPatch = buildUserEnvUpdateResult(envPatch, encryptedPatch);
  const nextEnv = {
    ...existingEnv,
    ...preparedPatch,
  };
  const nextVisibility = {
    ...existingVisibility,
    ...visibilityPatch,
  };
  const nextEncrypted = {
    ...existingEncrypted,
    ...Object.fromEntries(Object.keys(envPatch).map((name) => [name, encryptedPatch?.[name] === true])),
  };
  const envJson = buildUserEnvJson(nextEnv);
  const visibilityJson = serializeUserEnvVisibilityRecord(nextVisibility);
  const encryptedJson = serializeUserEnvEncryptedRecord(nextEncrypted);
  db.prepare('UPDATE users SET env = ? WHERE id = ?').run(envJson, row.id);
  db.prepare('UPDATE users SET env_visibility = ? WHERE id = ?').run(visibilityJson, row.id);
  db.prepare('UPDATE users SET env_encrypted = ? WHERE id = ?').run(encryptedJson, row.id);

  return {
    userId: row.id,
    username: row.username,
    success: true,
    env: Object.fromEntries(Object.keys(envPatch).map((name) => [name, nextEnv[name]])),
  };
}

function buildClaudeEnvListEntry(row) {
  const env = decryptUserEnvForRuntime(ensureUserEnvForRow(row) || {}, parseUserEnvEncryptedJson(row.env_encrypted));
  const visibility = parseUserEnvVisibilityJson(row.env_visibility);
  const encryptedFields = parseUserEnvEncryptedJson(row.env_encrypted);

  return {
    userId: row.id,
    username: row.username,
    env: Object.entries(env)
      .filter(([name]) => name !== USER_KEY_ENV_NAME)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const visible = visibility[name] === true;
        return {
          name,
          configured: true,
          visible,
          encrypted: encryptedFields[name] === true,
          ...(visible ? { value } : {}),
        };
      }),
  };
}

function decryptUserEnvForRuntime(env, encrypted = {}) {
  const decrypted = decryptUserEnvRecord(env, {
    secretMaterial: getUserKeyEncryptionSecret(),
  });

  const encryptedNames = parseUserEnvEncryptedJson(encrypted);

  return Object.fromEntries(
    Object.entries(decrypted).map(([name, value]) => {
      if (name === USER_KEY_ENV_NAME || encryptedNames[name] !== true) {
        return [name, value];
      }

      try {
        return [name, decryptSecretString(value, { secretMaterial: getUserKeyEncryptionSecret() })];
      } catch {
        return [name, value];
      }
    }),
  );
}

function normalizeUserEnvVisibilityRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => ENV_NAME_PATTERN.test(String(key)))
      .map(([key, entry]) => [String(key), entry === true]),
  );
}

function parseUserEnvVisibilityJson(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeUserEnvVisibilityRecord(value);
  }

  try {
    return normalizeUserEnvVisibilityRecord(JSON.parse(String(value)));
  } catch {
    return {};
  }
}

function serializeUserEnvVisibilityRecord(value) {
  return JSON.stringify(normalizeUserEnvVisibilityRecord(value));
}


function encryptCodeHubToken(token) {
  return encryptSecretString(token, {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
}

function decryptCodeHubToken(tokenEncrypted) {
  return decryptSecretString(tokenEncrypted, {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
}

function encryptGitToken(token) {
  return encryptSecretString(token, {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
}

function decryptGitToken(tokenEncrypted) {
  if (!tokenEncrypted) return null;
  return decryptSecretString(tokenEncrypted, {
    secretMaterial: getUserKeyEncryptionSecret(),
  });
}

function requireCodeHubRepositoryValue(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  if (normalized.length > 2048) {
    throw new Error(`${name} must be 2048 characters or fewer`);
  }
  return normalized;
}

function requireCodeHubToken(value) {
  const token = String(value || '').trim();
  if (!token) {
    throw new Error('token is required');
  }
  if (token.length > 8192) {
    throw new Error('token must be 8192 characters or fewer');
  }
  return token;
}

function hydrateCodeHubRepository(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    target_repository: row.target_repository,
    private_repository: row.private_repository,
    token_configured: typeof row.token_encrypted === 'string' && row.token_encrypted.trim() !== '',
    last_test_status: row.last_test_status || null,
    last_test_error: row.last_test_error || null,
    last_tested_at: row.last_tested_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getCodeHubRepositoryRowForUser(userId, repositoryId) {
  return db.prepare(`
    SELECT *
    FROM codehub_repositories
    WHERE id = ? AND user_id = ?
  `).get(Number(repositoryId), Number(userId)) || null;
}

function backfillExistingUserEnvRecords() {
  const rows = db.prepare('SELECT id, env FROM users').all();
  for (const row of rows) {
    ensureUserEnvForRow(row);
  }
}

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user
  createUser: (username, passwordHash, options = {}) => {
    try {
      const isSystemAdmin = options.isSystemAdmin === true ? 1 : 0;
      const envJson = buildUserEnvJson(options.env);
      const stmt = db.prepare('INSERT INTO users (username, password_hash, is_system_admin, env) VALUES (?, ?, ?, ?)');
      const result = stmt.run(username, passwordHash, isSystemAdmin, envJson);
      return { id: result.lastInsertRowid, username, is_system_admin: isSystemAdmin };
    } catch (err) {
      throw err;
    }
  },

  createInvitedUser: ({ username, tokenHash, createdByUserId, expiresAt }) => {
    try {
      const createInvitation = db.transaction(() => {
        const envJson = buildUserEnvJson();
        const userResult = db
          .prepare('INSERT INTO users (username, password_hash, is_active, is_system_admin, env) VALUES (?, ?, 0, 0, ?)')
          .run(username, '', envJson);
        const user = {
          id: userResult.lastInsertRowid,
          username,
          is_active: 0,
          is_system_admin: 0,
        };

        const invitationResult = db
          .prepare(`
            INSERT INTO user_invitations (user_id, token_hash, created_by_user_id, expires_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(user.id, tokenHash, createdByUserId, expiresAt);

        return {
          user,
          invitation: {
            id: invitationResult.lastInsertRowid,
            user_id: user.id,
            expires_at: expiresAt,
          },
        };
      });

      return createInvitation();
    } catch (err) {
      throw err;
    }
  },

  createInvitationForUser: ({ userId, tokenHash, createdByUserId, expiresAt }) => {
    try {
      const createInvitation = db.transaction(() => {
        const user = db.prepare(`
          SELECT id, username, is_active, is_system_admin
          FROM users
          WHERE id = ?
        `).get(userId);

        if (!user) {
          return null;
        }

        if (user.is_active === 1) {
          throw new Error('User is already active');
        }

        db.prepare(`
          UPDATE user_invitations
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        `).run(user.id);

        const invitationResult = db
          .prepare(`
            INSERT INTO user_invitations (user_id, token_hash, created_by_user_id, expires_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(user.id, tokenHash, createdByUserId, expiresAt);

        return {
          user,
          invitation: {
            id: invitationResult.lastInsertRowid,
            user_id: user.id,
            expires_at: expiresAt,
          },
        };
      });

      return createInvitation();
    } catch (err) {
      throw err;
    }
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login, is_system_admin FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  getUserByIdAnyStatus: (userId) => {
    try {
      return db.prepare('SELECT id, username, created_at, last_login, is_active, is_system_admin FROM users WHERE id = ?').get(userId);
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login, is_system_admin FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  listUsers: () => {
    try {
      const rows = db.prepare(`
        SELECT
          u.id,
          u.username,
          u.created_at,
          u.last_login,
          u.is_active,
          u.is_system_admin,
          (
            SELECT ui.expires_at
            FROM user_invitations ui
            WHERE ui.user_id = u.id
              AND ui.accepted_at IS NULL
              AND ui.revoked_at IS NULL
            ORDER BY ui.created_at DESC
            LIMIT 1
          ) AS invitation_expires_at,
          (
            SELECT ui.created_at
            FROM user_invitations ui
            WHERE ui.user_id = u.id
              AND ui.accepted_at IS NULL
              AND ui.revoked_at IS NULL
            ORDER BY ui.created_at DESC
            LIMIT 1
          ) AS invitation_created_at
        FROM users u
        ORDER BY username COLLATE NOCASE ASC
      `).all();

      return rows.map((row) => {
        if (row.is_active === 1) {
          return { ...row, invitation_status: 'active' };
        }

        const expiresAt = row.invitation_expires_at ? Date.parse(row.invitation_expires_at) : NaN;
        if (Number.isFinite(expiresAt)) {
          return {
            ...row,
            invitation_status: expiresAt > Date.now() ? 'invited' : 'expired',
          };
        }

        return { ...row, invitation_status: 'inactive' };
      });
    } catch (err) {
      throw err;
    }
  },

  getInvitationByTokenHash: (tokenHash) => {
    try {
      return db.prepare(`
        SELECT
          ui.id,
          ui.user_id,
          ui.token_hash,
          ui.created_by_user_id,
          ui.expires_at,
          ui.accepted_at,
          ui.revoked_at,
          ui.created_at,
          u.username,
          u.is_active,
          u.is_system_admin
        FROM user_invitations ui
        JOIN users u ON u.id = ui.user_id
        WHERE ui.token_hash = ?
        LIMIT 1
      `).get(tokenHash);
    } catch (err) {
      throw err;
    }
  },

  createPasswordResetForUser: ({ userId, tokenHash, createdByUserId, expiresAt }) => {
    try {
      const createReset = db.transaction(() => {
        const user = db.prepare(`
          SELECT id, username, is_active, is_system_admin
          FROM users
          WHERE id = ?
        `).get(userId);

        if (!user) {
          return null;
        }

        if (user.is_active !== 1) {
          throw new Error('User is not active');
        }

        db.prepare(`
          UPDATE user_password_resets
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
            AND used_at IS NULL
            AND revoked_at IS NULL
        `).run(user.id);

        const resetResult = db.prepare(`
          INSERT INTO user_password_resets (user_id, token_hash, created_by_user_id, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(user.id, tokenHash, createdByUserId, expiresAt);

        return {
          user,
          passwordReset: {
            id: resetResult.lastInsertRowid,
            user_id: user.id,
            expires_at: expiresAt,
          },
        };
      });

      return createReset();
    } catch (err) {
      throw err;
    }
  },

  getPasswordResetByTokenHash: (tokenHash) => {
    try {
      return db.prepare(`
        SELECT
          upr.id,
          upr.user_id,
          upr.token_hash,
          upr.created_by_user_id,
          upr.expires_at,
          upr.used_at,
          upr.revoked_at,
          upr.created_at,
          u.username,
          u.is_active,
          u.is_system_admin
        FROM user_password_resets upr
        JOIN users u ON u.id = upr.user_id
        WHERE upr.token_hash = ?
        LIMIT 1
      `).get(tokenHash);
    } catch (err) {
      throw err;
    }
  },

  deleteUser: (userId) => {
    try {
      const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  acceptInvitation: ({ tokenHash, passwordHash }) => {
    try {
      const accept = db.transaction(() => {
        const invitation = userDb.getInvitationByTokenHash(tokenHash);
        if (!invitation) {
          return null;
        }

        const invitationUpdate = db.prepare(`
          UPDATE user_invitations
          SET accepted_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND accepted_at IS NULL
            AND revoked_at IS NULL
        `).run(invitation.id);

        if (invitationUpdate.changes === 0) {
          return null;
        }

        db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?')
          .run(passwordHash, invitation.user_id);
        userDb.ensureEnvForUser(invitation.user_id);

        return db.prepare(`
          SELECT id, username, created_at, last_login, is_system_admin
          FROM users
          WHERE id = ? AND is_active = 1
        `).get(invitation.user_id);
      });

      return accept();
    } catch (err) {
      throw err;
    }
  },

  resetPasswordWithToken: ({ tokenHash, passwordHash }) => {
    try {
      const resetPassword = db.transaction(() => {
        const passwordReset = userDb.getPasswordResetByTokenHash(tokenHash);
        if (!passwordReset) {
          return null;
        }

        const resetUpdate = db.prepare(`
          UPDATE user_password_resets
          SET used_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND used_at IS NULL
            AND revoked_at IS NULL
        `).run(passwordReset.id);

        if (resetUpdate.changes === 0) {
          return null;
        }

        db.prepare('UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?')
          .run(passwordHash, passwordReset.user_id);

        db.prepare(`
          UPDATE user_password_resets
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
            AND id != ?
            AND used_at IS NULL
            AND revoked_at IS NULL
        `).run(passwordReset.user_id, passwordReset.id);

        return db.prepare(`
          SELECT id, username, created_at, last_login, is_system_admin
          FROM users
          WHERE id = ? AND is_active = 1
        `).get(passwordReset.user_id);
      });

      return resetPassword();
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail, gitToken) => {
    try {
      const normalizedToken = typeof gitToken === 'string' ? gitToken.trim() : null;
      if (normalizedToken) {
        const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ?, git_token = ? WHERE id = ?');
        stmt.run(gitName, gitEmail, encryptGitToken(normalizedToken), userId);
        return;
      }

      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email, git_token FROM users WHERE id = ?').get(userId);
      if (!row) return row;
      return {
        git_name: row.git_name,
        git_email: row.git_email,
        git_token_configured: Boolean(row.git_token),
      };
    } catch (err) {
      throw err;
    }
  },

  getGitTokenForUser: (userId) => {
    try {
      const row = db.prepare('SELECT git_token FROM users WHERE id = ?').get(userId);
      return decryptGitToken(row?.git_token);
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  },

  ensureEnvForUser: (userId) => {
    try {
      const row = db.prepare('SELECT id, env FROM users WHERE id = ?').get(userId);
      return ensureUserEnvForRow(row);
    } catch (err) {
      throw err;
    }
  },

  getEnvForUser: (userId) => {
    try {
      const row = db.prepare('SELECT id, env, env_encrypted FROM users WHERE id = ?').get(userId);
      if (!row) {
        return {};
      }

      const env = ensureUserEnvForRow({ id: row.id, env: row.env });
      const encrypted = parseUserEnvEncryptedJson(row.env_encrypted);
      return decryptUserEnvForRuntime(env || {}, encrypted);
    } catch (err) {
      throw err;
    }
  },

  listClaudeEnvForUsers: () => {
    try {
      return db.prepare(`
        SELECT id, username, env, env_visibility, env_encrypted
        FROM users
        ORDER BY username COLLATE NOCASE ASC
      `).all().map(buildClaudeEnvListEntry);
    } catch (err) {
      throw err;
    }
  },

  updateClaudeEnvForUsers: ({ userIds, env, visibility, encrypted }) => {
    try {
      const uniqueUserIds = Array.from(new Set(
        (Array.isArray(userIds) ? userIds : [])
          .map((userId) => Number(userId))
          .filter((userId) => Number.isInteger(userId) && userId > 0),
      ));
      const envPatch = Object.fromEntries(
        Object.entries(env || {})
          .filter(([name, value]) => name && value != null)
          .map(([name, value]) => [String(name), String(value)]),
      );
      const visibilityPatch = Object.fromEntries(
        Object.keys(envPatch).map((name) => [name, visibility?.[name] === true]),
      );
      const encryptedPatch = Object.fromEntries(
        Object.keys(envPatch).map((name) => [name, encrypted?.[name] === true]),
      );

      const updateUsers = db.transaction(() => uniqueUserIds.map((userId) => {
        const row = db
          .prepare('SELECT id, username, env, env_visibility, env_encrypted FROM users WHERE id = ?')
          .get(userId);

        if (!row) {
          return { userId, success: false, error: 'User not found' };
        }

        return buildClaudeEnvUpdateResult(row, envPatch, visibilityPatch, encryptedPatch);
      }));

      return updateUsers();
    } catch (err) {
      throw err;
    }
  },
};

const codeHubDb = {
  listRepositories: (userId) => {
    try {
      return db.prepare(`
        SELECT *
        FROM codehub_repositories
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(Number(userId)).map(hydrateCodeHubRepository);
    } catch (err) {
      throw err;
    }
  },

  listRepositorySecrets: (userId) => {
    try {
      return db.prepare(`
        SELECT *
        FROM codehub_repositories
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC
      `).all(Number(userId));
    } catch (err) {
      throw err;
    }
  },

  createRepository: ({ userId, targetRepository, privateRepository, token }) => {
    try {
      const normalizedTargetRepository = requireCodeHubRepositoryValue(targetRepository, 'targetRepository');
      const normalizedPrivateRepository = requireCodeHubRepositoryValue(privateRepository, 'privateRepository');
      const tokenEncrypted = encryptCodeHubToken(requireCodeHubToken(token));
      const result = db.prepare(`
        INSERT INTO codehub_repositories (
          user_id,
          target_repository,
          private_repository,
          token_encrypted
        )
        VALUES (?, ?, ?, ?)
      `).run(
        Number(userId),
        normalizedTargetRepository,
        normalizedPrivateRepository,
        tokenEncrypted,
      );

      return hydrateCodeHubRepository(getCodeHubRepositoryRowForUser(userId, result.lastInsertRowid));
    } catch (err) {
      throw err;
    }
  },

  updateRepository: ({ userId, repositoryId, targetRepository, privateRepository, token }) => {
    try {
      const existing = getCodeHubRepositoryRowForUser(userId, repositoryId);
      if (!existing) {
        return null;
      }

      const normalizedTargetRepository = requireCodeHubRepositoryValue(targetRepository, 'targetRepository');
      const normalizedPrivateRepository = requireCodeHubRepositoryValue(privateRepository, 'privateRepository');
      const hasTokenUpdate = typeof token === 'string' && token.trim() !== '';
      if (hasTokenUpdate) {
        db.prepare(`
          UPDATE codehub_repositories
          SET
            target_repository = ?,
            private_repository = ?,
            token_encrypted = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(
          normalizedTargetRepository,
          normalizedPrivateRepository,
          encryptCodeHubToken(requireCodeHubToken(token)),
          Number(repositoryId),
          Number(userId),
        );
      } else {
        db.prepare(`
          UPDATE codehub_repositories
          SET
            target_repository = ?,
            private_repository = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(
          normalizedTargetRepository,
          normalizedPrivateRepository,
          Number(repositoryId),
          Number(userId),
        );
      }

      return hydrateCodeHubRepository(getCodeHubRepositoryRowForUser(userId, repositoryId));
    } catch (err) {
      throw err;
    }
  },

  deleteRepository: ({ userId, repositoryId }) => {
    try {
      const result = db.prepare(`
        DELETE FROM codehub_repositories
        WHERE id = ? AND user_id = ?
      `).run(Number(repositoryId), Number(userId));
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  getRepositorySecret: ({ userId, repositoryId }) => {
    try {
      const row = getCodeHubRepositoryRowForUser(userId, repositoryId);
      if (!row) {
        return null;
      }
      return {
        ...hydrateCodeHubRepository(row),
        token: decryptCodeHubToken(row.token_encrypted),
      };
    } catch (err) {
      throw err;
    }
  },

  recordTest: ({ userId, repositoryId, status, error = null, testedAt = new Date() }) => {
    try {
      const normalizedStatus = status === 'connected' ? 'connected' : 'failed';
      const errorText = error ? String(error).slice(0, 2000) : null;
      const checkedAt = testedAt instanceof Date ? testedAt.toISOString() : String(testedAt);
      db.prepare(`
        UPDATE codehub_repositories
        SET
          last_test_status = ?,
          last_test_error = ?,
          last_tested_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(
        normalizedStatus,
        errorText,
        checkedAt,
        Number(repositoryId),
        Number(userId),
      );
      return hydrateCodeHubRepository(getCodeHubRepositoryRowForUser(userId, repositoryId));
    } catch (err) {
      throw err;
    }
  },

  decryptRepositoryToken: (row) => decryptCodeHubToken(row.token_encrypted),
};

function hydrateCodeHubWorkspaceRepository(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    repo_relative_path: row.repo_relative_path,
    repository_url: row.repository_url,
    project_id: row.project_id,
    public_repository_url: row.public_repository_url,
    public_project_id: row.public_project_id,
    codehub_host: row.codehub_host,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeNullableInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

const codeHubWorkspaceRepositoriesDb = {
  listForWorkspace: ({ tenantId, userId, workspaceId }) => {
    return db.prepare(`
      SELECT *
      FROM codehub_workspace_repositories
      WHERE tenant_id = ? AND user_id = ? AND workspace_id = ?
      ORDER BY repo_relative_path COLLATE NOCASE ASC
    `).all(Number(tenantId), Number(userId), Number(workspaceId)).map(hydrateCodeHubWorkspaceRepository);
  },

  getById: ({ tenantId, userId, workspaceId, repositoryId }) => hydrateCodeHubWorkspaceRepository(db.prepare(`
    SELECT *
    FROM codehub_workspace_repositories
    WHERE id = ? AND tenant_id = ? AND user_id = ? AND workspace_id = ?
  `).get(Number(repositoryId), Number(tenantId), Number(userId), Number(workspaceId))),

  getByRelativePath: ({ tenantId, userId, workspaceId, repoRelativePath }) => hydrateCodeHubWorkspaceRepository(db.prepare(`
    SELECT *
    FROM codehub_workspace_repositories
    WHERE tenant_id = ? AND user_id = ? AND workspace_id = ? AND repo_relative_path = ?
  `).get(Number(tenantId), Number(userId), Number(workspaceId), String(repoRelativePath || ''))),

  upsert: ({
    tenantId,
    userId,
    workspaceId,
    repoRelativePath,
    repositoryUrl,
    projectId = null,
    publicRepositoryUrl = null,
    publicProjectId = null,
    codehubHost,
  }) => {
    const existing = codeHubWorkspaceRepositoriesDb.getByRelativePath({
      tenantId,
      userId,
      workspaceId,
      repoRelativePath,
    });
    if (existing) {
      db.prepare(`
        UPDATE codehub_workspace_repositories
        SET
          repository_url = ?,
          project_id = ?,
          public_repository_url = ?,
          public_project_id = ?,
          codehub_host = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        String(repositoryUrl || ''),
        normalizeNullableInteger(projectId),
        publicRepositoryUrl || null,
        normalizeNullableInteger(publicProjectId),
        String(codehubHost || ''),
        existing.id,
      );
      return hydrateCodeHubWorkspaceRepository(db.prepare('SELECT * FROM codehub_workspace_repositories WHERE id = ?').get(existing.id));
    }

    const result = db.prepare(`
      INSERT INTO codehub_workspace_repositories (
        tenant_id,
        user_id,
        workspace_id,
        repo_relative_path,
        repository_url,
        project_id,
        public_repository_url,
        public_project_id,
        codehub_host
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(tenantId),
      Number(userId),
      Number(workspaceId),
      String(repoRelativePath || ''),
      String(repositoryUrl || ''),
      normalizeNullableInteger(projectId),
      publicRepositoryUrl || null,
      normalizeNullableInteger(publicProjectId),
      String(codehubHost || ''),
    );
    return hydrateCodeHubWorkspaceRepository(db.prepare('SELECT * FROM codehub_workspace_repositories WHERE id = ?').get(result.lastInsertRowid));
  },
};

function hydrateAiMrSubmission(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    workspace_id: row.workspace_id,
    repo_relative_path: row.repo_relative_path,
    repository_url: row.repository_url,
    project_id: row.project_id,
    public_repository_url: row.public_repository_url,
    public_project_id: row.public_project_id,
    source_branch: row.source_branch,
    target_branch: row.target_branch,
    commit_sha: row.commit_sha,
    mr_id: row.mr_id,
    mr_iid: row.mr_iid,
    mr_project_id: row.mr_project_id,
    mr_url: row.mr_url,
    ticket_no: row.ticket_no,
    description: row.description,
    binary_source: row.binary_source,
    mr_title: row.mr_title,
    additions: Number(row.additions || 0),
    deletions: Number(row.deletions || 0),
    files_changed: Number(row.files_changed || 0),
    binary_files_changed: Number(row.binary_files_changed || 0),
    status: row.status,
    mr_state: row.mr_state,
    mr_created_at: row.mr_created_at,
    mr_updated_at: row.mr_updated_at,
    merged_at: row.merged_at,
    closed_at: row.closed_at,
    expires_at: row.expires_at,
    last_checked_at: row.last_checked_at,
    next_check_at: row.next_check_at,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

const aiMrSubmissionsDb = {
  create: ({ submission, files = [] }) => {
    const insertSubmission = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO ai_mr_submissions (
          tenant_id,
          user_id,
          workspace_id,
          repo_relative_path,
          repository_url,
          project_id,
          public_repository_url,
          public_project_id,
          source_branch,
          target_branch,
          commit_sha,
          mr_id,
          mr_iid,
          mr_project_id,
          mr_url,
          ticket_no,
          description,
          binary_source,
          mr_title,
          additions,
          deletions,
          files_changed,
          binary_files_changed,
          status,
          mr_state,
          mr_created_at,
          mr_updated_at,
          merged_at,
          closed_at,
          expires_at,
          next_check_at,
          last_error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Number(submission.tenantId),
        Number(submission.userId),
        Number(submission.workspaceId),
        submission.repoRelativePath,
        submission.repositoryUrl,
        normalizeNullableInteger(submission.projectId),
        submission.publicRepositoryUrl || null,
        normalizeNullableInteger(submission.publicProjectId),
        submission.sourceBranch,
        submission.targetBranch,
        submission.commitSha,
        submission.mrId == null ? null : String(submission.mrId),
        submission.mrIid == null ? null : String(submission.mrIid),
        normalizeNullableInteger(submission.mrProjectId),
        submission.mrUrl || null,
        submission.ticketNo,
        submission.description || null,
        submission.binarySource || null,
        submission.mrTitle || null,
        Number(submission.additions || 0),
        Number(submission.deletions || 0),
        Number(submission.filesChanged || 0),
        Number(submission.binaryFilesChanged || 0),
        submission.status || 'pending',
        submission.mrState || null,
        submission.mrCreatedAt || null,
        submission.mrUpdatedAt || null,
        submission.mergedAt || null,
        submission.closedAt || null,
        submission.expiresAt,
        submission.nextCheckAt || null,
        submission.lastError || null,
      );
      const submissionId = result.lastInsertRowid;
      const insertFile = db.prepare(`
        INSERT INTO ai_mr_submission_files (
          submission_id,
          file_path,
          status,
          additions,
          deletions,
          is_binary
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const file of files) {
        insertFile.run(
          submissionId,
          file.filePath,
          file.status || 'modified',
          Number(file.additions || 0),
          Number(file.deletions || 0),
          file.isBinary ? 1 : 0,
        );
      }
      return submissionId;
    });

    const id = insertSubmission();
    return aiMrSubmissionsDb.getById(id);
  },

  getById: (submissionId) => hydrateAiMrSubmission(db.prepare(`
    SELECT *
    FROM ai_mr_submissions
    WHERE id = ?
  `).get(Number(submissionId))),

  listActiveForHead: ({
    tenantId,
    userId,
    workspaceId,
    repoRelativePath,
    targetBranch,
    commitSha,
  }) => db.prepare(`
    SELECT *
    FROM ai_mr_submissions
    WHERE tenant_id = ?
      AND user_id = ?
      AND workspace_id = ?
      AND repo_relative_path = ?
      AND target_branch = ?
      AND commit_sha = ?
      AND status = 'pending'
      AND mr_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
  `).all(
    Number(tenantId),
    Number(userId),
    Number(workspaceId),
    String(repoRelativePath || ''),
    String(targetBranch || ''),
    String(commitSha || ''),
  ).map(hydrateAiMrSubmission),

  listActiveForBranches: ({
    tenantId,
    userId,
    workspaceId,
    repoRelativePath,
    sourceBranch,
    targetBranch,
    mrProjectId,
  }) => db.prepare(`
    SELECT *
    FROM ai_mr_submissions
    WHERE tenant_id = ?
      AND user_id = ?
      AND workspace_id = ?
      AND repo_relative_path = ?
      AND source_branch = ?
      AND target_branch = ?
      AND mr_project_id = ?
      AND status = 'pending'
      AND mr_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
  `).all(
    Number(tenantId),
    Number(userId),
    Number(workspaceId),
    String(repoRelativePath || ''),
    String(sourceBranch || ''),
    String(targetBranch || ''),
    Number(mrProjectId),
  ).map(hydrateAiMrSubmission),

  listPendingDue: ({ now = new Date(), limit = 50 } = {}) => db.prepare(`
    SELECT *
    FROM ai_mr_submissions
    WHERE status = 'pending'
      AND (next_check_at IS NULL OR next_check_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(now.toISOString(), Number(limit)).map(hydrateAiMrSubmission),

  markExpired: ({ submissionId, checkedAt = new Date() }) => {
    db.prepare(`
      UPDATE ai_mr_submissions
      SET status = 'expired',
          last_checked_at = ?,
          next_check_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(checkedAt.toISOString(), Number(submissionId));
    return aiMrSubmissionsDb.getById(submissionId);
  },

  attachMergeRequest: ({
    submissionId,
    mrId,
    mrIid,
    mrProjectId,
    mrUrl = null,
    mrState = 'opened',
    mrCreatedAt = null,
    mrUpdatedAt = null,
    nextCheckAt = null,
  }) => {
    db.prepare(`
      UPDATE ai_mr_submissions
      SET mr_id = ?,
          mr_iid = ?,
          mr_project_id = ?,
          mr_url = ?,
          mr_state = ?,
          mr_created_at = COALESCE(?, mr_created_at),
          mr_updated_at = COALESCE(?, mr_updated_at),
          status = 'pending',
          next_check_at = ?,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      mrId == null ? null : String(mrId),
      mrIid == null ? null : String(mrIid),
      normalizeNullableInteger(mrProjectId),
      mrUrl,
      mrState || null,
      mrCreatedAt,
      mrUpdatedAt,
      nextCheckAt,
      Number(submissionId),
    );
    return aiMrSubmissionsDb.getById(submissionId);
  },

  updateMrStatus: ({
    submissionId,
    status,
    mrState,
    mrCreatedAt = null,
    mrUpdatedAt = null,
    mergedAt = null,
    closedAt = null,
    lastError = null,
    nextCheckAt = null,
    checkedAt = new Date(),
  }) => {
    db.prepare(`
      UPDATE ai_mr_submissions
      SET status = ?,
          mr_state = ?,
          mr_created_at = COALESCE(?, mr_created_at),
          mr_updated_at = COALESCE(?, mr_updated_at),
          merged_at = COALESCE(?, merged_at),
          closed_at = COALESCE(?, closed_at),
          last_checked_at = ?,
          next_check_at = ?,
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      status,
      mrState || null,
      mrCreatedAt,
      mrUpdatedAt,
      mergedAt,
      closedAt,
      checkedAt.toISOString(),
      nextCheckAt,
      lastError,
      Number(submissionId),
    );
    return aiMrSubmissionsDb.getById(submissionId);
  },

  listAdminMrs: ({ status, tenantId, userId, from, to, limit = 100, offset = 0 } = {}) => {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('s.status = ?');
      params.push(String(status));
    }
    if (tenantId) {
      clauses.push('s.tenant_id = ?');
      params.push(Number(tenantId));
    }
    if (userId) {
      clauses.push('s.user_id = ?');
      params.push(Number(userId));
    }
    if (from) {
      clauses.push("COALESCE(s.merged_at, s.created_at) >= ?");
      params.push(String(from));
    }
    if (to) {
      clauses.push("COALESCE(s.merged_at, s.created_at) <= ?");
      params.push(String(to));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`
      SELECT s.*, u.username, t.name AS tenant_name, t.code AS tenant_code
      FROM ai_mr_submissions s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN tenants t ON t.id = s.tenant_id
      ${where}
      ORDER BY COALESCE(s.merged_at, s.created_at) DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset)).map((row) => ({
      ...hydrateAiMrSubmission(row),
      username: row.username || null,
      tenant_name: row.tenant_name || null,
      tenant_code: row.tenant_code || null,
    }));
  },

  getAdminStats: ({ tenantId, userId, from, to } = {}) => {
    const clauses = ["s.status = 'merged'"];
    const params = [];
    if (tenantId) {
      clauses.push('s.tenant_id = ?');
      params.push(Number(tenantId));
    }
    if (userId) {
      clauses.push('s.user_id = ?');
      params.push(Number(userId));
    }
    if (from) {
      clauses.push('s.merged_at >= ?');
      params.push(String(from));
    }
    if (to) {
      clauses.push('s.merged_at <= ?');
      params.push(String(to));
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const summary = db.prepare(`
      SELECT
        COUNT(*) AS merged_mr_count,
        COALESCE(SUM(additions), 0) AS additions,
        COALESCE(SUM(deletions), 0) AS deletions,
        COALESCE(SUM(files_changed), 0) AS files_changed,
        COALESCE(SUM(binary_files_changed), 0) AS binary_files_changed
      FROM ai_mr_submissions s
      ${where}
    `).get(...params);
    const byTenant = db.prepare(`
      SELECT
        s.tenant_id,
        t.name AS tenant_name,
        t.code AS tenant_code,
        COUNT(*) AS merged_mr_count,
        COALESCE(SUM(s.additions), 0) AS additions,
        COALESCE(SUM(s.deletions), 0) AS deletions,
        COALESCE(SUM(s.files_changed), 0) AS files_changed,
        COALESCE(SUM(s.binary_files_changed), 0) AS binary_files_changed
      FROM ai_mr_submissions s
      LEFT JOIN tenants t ON t.id = s.tenant_id
      ${where}
      GROUP BY s.tenant_id
      ORDER BY merged_mr_count DESC
    `).all(...params);
    const byUser = db.prepare(`
      SELECT
        s.tenant_id,
        t.name AS tenant_name,
        t.code AS tenant_code,
        s.user_id,
        u.username,
        COUNT(*) AS merged_mr_count,
        COALESCE(SUM(s.additions), 0) AS additions,
        COALESCE(SUM(s.deletions), 0) AS deletions,
        COALESCE(SUM(s.files_changed), 0) AS files_changed,
        COALESCE(SUM(s.binary_files_changed), 0) AS binary_files_changed
      FROM ai_mr_submissions s
      LEFT JOIN tenants t ON t.id = s.tenant_id
      LEFT JOIN users u ON u.id = s.user_id
      ${where}
      GROUP BY s.tenant_id, s.user_id
      ORDER BY merged_mr_count DESC
    `).all(...params);
    return {
      summary: {
        mergedMrCount: Number(summary?.merged_mr_count || 0),
        additions: Number(summary?.additions || 0),
        deletions: Number(summary?.deletions || 0),
        changedLines: Number(summary?.additions || 0) + Number(summary?.deletions || 0),
        filesChanged: Number(summary?.files_changed || 0),
        binaryFilesChanged: Number(summary?.binary_files_changed || 0),
      },
      byTenant,
      byUser,
    };
  },
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: false,
    stop: false,
    error: false
  },
  modelResponseHooks: DEFAULT_MODEL_RESPONSE_HOOK_CONFIG
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: false,
      stop: false,
      error: false
    },
    modelResponseHooks: normalizeModelResponseHookConfig(source.modelResponseHooks)
  };
};

const notificationPreferencesDb = {
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations
const sessionNamesDb = {
  // Set (insert or update) a custom session name
  setName: (sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (session_id, provider, custom_name)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(sessionId, provider, customName);
  },

  // Get a single custom session name
  getName: (sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE session_id = ? AND provider = ?'
    ).get(sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName>
  getNames: (sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE session_id IN (${placeholders}) AND provider = ?`
    ).all(...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name
  deleteName: (sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE session_id = ? AND provider = ?'
    ).run(sessionId, provider).changes > 0;
  },
};

// Apply custom session names from the database (overrides CLI-generated summaries)
function applyCustomSessionNames(sessions, provider) {
  if (!sessions?.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

function mapScheduledTaskFolder(row) {
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    provider: row.provider,
    scheduleType: row.schedule_type || 'interval',
    scheduleCron: row.schedule_cron || null,
    scheduleStartAt: row.schedule_start_at || row.next_run_at,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at || null,
    lastSessionId: row.last_session_id || null,
    sessionMode: row.session_mode || 'new',
  };
}

const scheduledTasksDb = {
  listWorkspaceTasks: ({ tenantId, userId, workspaceId }) => {
    return db.prepare(`
      SELECT *
      FROM scheduled_session_tasks
      WHERE tenant_id = ?
        AND user_id = ?
        AND workspace_id = ?
      ORDER BY enabled DESC, next_run_at ASC, updated_at DESC, id DESC
    `).all(tenantId, userId, workspaceId).map(mapScheduledTaskFolder);
  },

  getSessionTaskMap: ({ tenantId, userId, workspaceId = null, provider = null, sessionIds = [] } = {}) => {
    const normalizedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
      : [];

    if (!normalizedSessionIds.length) {
      return new Map();
    }

    const params = [tenantId, userId, ...normalizedSessionIds];
    let workspaceClause = '';
    let providerClause = '';

    if (workspaceId != null) {
      workspaceClause = 'AND workspace_id = ?';
      params.push(workspaceId);
    }

    if (provider != null) {
      providerClause = 'AND provider = ?';
      params.push(provider);
    }

    const placeholders = normalizedSessionIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        si.provider_session_id,
        t.*
      FROM session_index si
      JOIN scheduled_session_tasks t
        ON t.id = CASE
          WHEN json_valid(si.metadata_json) THEN CAST(json_extract(si.metadata_json, '$.scheduledTaskId') AS INTEGER)
          ELSE NULL
        END
        OR t.last_session_id = si.provider_session_id
      WHERE t.tenant_id = ?
        AND t.user_id = ?
        AND si.provider_session_id IN (${placeholders})
        AND si.status != 'deleted'
        ${workspaceClause ? 'AND t.workspace_id = ?' : ''}
        ${providerClause ? 'AND t.provider = ?' : ''}
      ORDER BY t.enabled DESC, t.updated_at DESC, t.id DESC
    `).all(...params);

    const result = new Map();
    for (const row of rows) {
      if (!result.has(row.provider_session_id)) {
        result.set(row.provider_session_id, mapScheduledTaskFolder(row));
      }
    }
    return result;
  },
};

function applyScheduledSessionTaskFlags(sessions, provider, { tenantId = null, userId = null, workspaceId = null } = {}) {
  if (!sessions?.length || !tenantId || !userId) return;
  try {
    const ids = sessions.map((session) => session.id);
    const taskMap = scheduledTasksDb.getSessionTaskMap({
      tenantId,
      userId,
      workspaceId,
      provider,
      sessionIds: ids,
    });
    for (const session of sessions) {
      const task = taskMap.get(session.id);
      if (task) {
        session.isScheduledTaskSession = true;
        session.scheduledTask = task;
      }
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply scheduled session flags for ${provider}:`, error.message);
  }
}

// App config database operations
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  codeHubDb,
  codeHubWorkspaceRepositoriesDb,
  aiMrSubmissionsDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  scheduledTasksDb,
  applyScheduledSessionTaskFlags,
  appConfigDb,
  githubTokensDb // Backward compatibility
};
