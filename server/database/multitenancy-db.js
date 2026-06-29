import crypto from 'node:crypto';

import { db } from './db.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';

const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const TENANT_STATUSES = new Set(['active', 'disabled']);
const MEMBERSHIP_STATUSES = new Set(['active', 'disabled', 'pending']);
const WORKSPACE_STATUSES = new Set(['active', 'archived', 'deleted']);
const JOIN_REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const SESSION_STATUSES = new Set(['active', 'completed', 'aborted', 'failed', 'deleted']);
const RUNTIME_STATUSES = new Set(['pending', 'active', 'idle', 'failed', 'deleted']);
const MCP_PRESET_STATUSES = new Set(['draft', 'published', 'disabled']);
const MCP_TRANSPORTS = new Set(['http']);
const MCP_PREINSTALL_SCOPES = new Set(['none', 'all_workspaces']);
const PERMISSIONS = new Set(['view', 'edit']);
const PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);
const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function initializeMultitenancyTables(database = db) {
  database.exec(MULTITENANCY_SCHEMA_SQL);
  ensureColumn(database, 'tenants', 'prod_code', 'TEXT');
  migrateLegacyTenantProdCode(database);
}

function ensureColumn(database, tableName, columnName, columnDefinition) {
  if (hasColumn(database, tableName, columnName)) {
    return;
  }
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function hasColumn(database, tableName, columnName) {
  return database.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function migrateLegacyTenantProdCode(database) {
  if (!hasColumn(database, 'tenants', 'prod_tenant_id')) {
    return;
  }

  database.prepare(`
    UPDATE tenants
    SET prod_code = prod_tenant_id
    WHERE (prod_code IS NULL OR prod_code = '')
      AND prod_tenant_id IS NOT NULL
      AND prod_tenant_id != ''
  `).run();
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireEnum(value, allowed, name) {
  if (!allowed.has(value)) {
    throw new Error(`${name} must be one of: ${Array.from(allowed).join(', ')}`);
  }
  return value;
}

function requireCode(value, name = 'code') {
  const normalized = requireNonEmptyString(value, name).toLowerCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw new Error(`${name} must use lowercase letters, numbers, and hyphens`);
  }
  return normalized;
}

function requireSlug(value) {
  const normalized = requireNonEmptyString(value, 'slug').toLowerCase();
  if (!SLUG_PATTERN.test(normalized)) {
    throw new Error('slug must use lowercase letters, numbers, and hyphens');
  }
  return normalized;
}

function serializeMetadata(metadata) {
  if (metadata == null) return null;
  if (typeof metadata === 'string') return metadata;
  return JSON.stringify(metadata);
}

function serializeJson(value, name) {
  if (value == null) return null;
  if (typeof value === 'string') {
    JSON.parse(value);
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new Error(`${name} must be JSON serializable`);
  }
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function optionalNonEmptyString(value, name) {
  if (value == null || value === '') return null;
  return requireNonEmptyString(value, name);
}

function normalizeMcpServerName(value) {
  const normalized = requireNonEmptyString(value, 'name');
  if (!MCP_SERVER_NAME_PATTERN.test(normalized)) {
    throw new Error('name must use letters, numbers, dots, underscores, or hyphens');
  }
  return normalized;
}

function normalizeMcpConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be an object');
  }
  const transport = requireEnum(value.type || value.transport || 'http', MCP_TRANSPORTS, 'transport');
  return {
    transport,
    configJson: serializeJson({ ...value, type: transport }, 'config'),
  };
}

function normalizeMcpPreinstallScope(value = 'none') {
  return requireEnum(value || 'none', MCP_PREINSTALL_SCOPES, 'preinstallScope');
}

function normalizeToolsJson(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error('tools must be an array');
  }
  return serializeJson(value, 'tools');
}

function normalizeLimit(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('limit must be a non-negative integer or null');
  }
  return value;
}

function normalizeOffset(value) {
  const offset = value == null ? 0 : value;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return offset;
}

function normalizePositiveLimit(value, fallback = 50, max = 200) {
  const limit = value == null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, max);
}

function normalizeMonitorOffset(value) {
  return normalizeOffset(value == null || value === '' ? value : Number(value));
}

function normalizeOptionalPositiveInteger(value, name) {
  if (value == null || value === '') return null;
  return requirePositiveInteger(Number(value), name);
}

function normalizeSqlCheckRuleId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error('ruleId must be a non-empty string');
  }
  if (normalized.length > 256) {
    throw new Error('ruleId must be 256 characters or fewer');
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('ruleId must not contain control characters');
  }
  return normalized;
}

function normalizeSqlCheckRuleIds(ruleIds) {
  if (!Array.isArray(ruleIds)) {
    throw new Error('ruleIds must be an array');
  }

  const seen = new Set();
  const normalized = [];
  for (const ruleId of ruleIds) {
    const value = normalizeSqlCheckRuleId(ruleId);
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function normalizeFavoriteProjectKey({ tenantId = null, workspaceId = null, projectName = null }) {
  if (workspaceId != null) {
    const normalizedTenantId = tenantId != null
      ? requirePositiveInteger(tenantId, 'tenantId')
      : 0;
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    return `workspace:${normalizedTenantId}:${normalizedWorkspaceId}`;
  }

  return `project:${requireNonEmptyString(projectName, 'projectName')}`;
}

function normalizeRuntimeMonitorFilters(filters = {}) {
  return {
    tenantId: normalizeOptionalPositiveInteger(filters.tenantId, 'tenantId'),
    userId: normalizeOptionalPositiveInteger(filters.userId, 'userId'),
    workspaceId: normalizeOptionalPositiveInteger(filters.workspaceId, 'workspaceId'),
    provider: filters.provider ? requireEnum(filters.provider, PROVIDERS, 'provider') : null,
    status: filters.status ? requireEnum(filters.status, RUNTIME_STATUSES, 'status') : null,
    q: typeof filters.q === 'string' && filters.q.trim() ? `%${filters.q.trim().toLowerCase()}%` : null,
    limit: normalizePositiveLimit(filters.limit, 50, 200),
    offset: normalizeMonitorOffset(filters.offset),
  };
}

function parseNormalizedMessageRow(row) {
  try {
    return cleanStoredNormalizedMessage(row, JSON.parse(row.normalized_json));
  } catch (error) {
    return cleanStoredNormalizedMessage(row, {
      id: row.message_id,
      sessionId: row.provider_session_id,
      timestamp: row.provider_timestamp,
      provider: row.provider,
      kind: row.kind,
      role: row.role || undefined,
      content: row.content_text || undefined,
    });
  }
}

function cleanStoredNormalizedMessage(row, message) {
  if (
    row.provider === 'claude' &&
    message?.role === 'assistant' &&
    typeof message.content === 'string'
  ) {
    return {
      ...message,
      content: message.content.replace(/<\|assistant\|>/g, ''),
    };
  }

  return message;
}

const CLAUDE_HIDDEN_CONTENT_PREFIXES = [
  '<local-command-caveat>',
  'Base directory for this skill:',
];

function hasHiddenMessageFlag(message) {
  return (
    message?.isMeta === true ||
    message?.is_meta === true ||
    message?.isSidechain === true ||
    message?.is_sidechain === true ||
    message?.message?.isMeta === true ||
    message?.message?.is_meta === true ||
    message?.message?.isSidechain === true ||
    message?.message?.is_sidechain === true
  );
}

function startsWithHiddenClaudeContent(content) {
  if (typeof content !== 'string') return false;
  const normalizedContent = content.trimStart();
  return CLAUDE_HIDDEN_CONTENT_PREFIXES.some((prefix) => normalizedContent.startsWith(prefix));
}

function isHiddenSessionMessage(provider, message) {
  return hasHiddenMessageFlag(message) || (
    provider === 'claude' &&
    startsWithHiddenClaudeContent(extractContentText(message))
  );
}

function extractContentText(message) {
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  return null;
}

function normalizeMessageRole(role) {
  return role === 'user' || role === 'assistant' ? role : null;
}

function hydrateMcpPresetRow(row) {
  if (!row) return null;
  return {
    ...row,
    preinstall_scope: row.preinstall_scope || 'none',
    docker_compatible: row.docker_compatible === 1 ? 1 : 0,
    config: parseJson(row.config_json, {}),
    tools: parseJson(row.tools_json, []),
  };
}

function hydrateMcpInstallRow(row) {
  if (!row) return null;
  return {
    ...row,
    tools: parseJson(row.tools_json, []),
  };
}

function hydrateMcpHelperScriptRow(row) {
  if (!row) return null;
  return {
    ...row,
    size_bytes: Number(row.size_bytes || 0),
  };
}

function hydrateSkillMarketImportRow(row) {
  if (!row) return null;
  return {
    name: row.skill_name,
    skillId: row.skill_id,
    id: row.remote_id,
    skillName: row.display_name,
    nspPath: row.nsp_path || '',
    createUserId: row.create_user_id || undefined,
    version: Number(row.version || 0),
    source: row.source || 'skill-market-api',
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSkillMarketImportEntry(skillName, entry = {}) {
  const name = requireNonEmptyString(entry.name || skillName, 'skillName');
  const skillId = requireNonEmptyString(entry.skillId || entry.id || entry.remoteId || name, 'skillId');
  const remoteId = requireNonEmptyString(entry.id || entry.remoteId || entry.skillId || skillId, 'id');
  const displayName = requireNonEmptyString(entry.skillName || entry.displayName || entry.name || name, 'displayName');
  const version = Number(entry.version ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error('version must be a non-negative integer');
  }

  return {
    name,
    skillId,
    remoteId,
    displayName,
    nspPath: typeof entry.nspPath === 'string' ? entry.nspPath : '',
    createUserId: entry.createUserId == null || entry.createUserId === ''
      ? null
      : String(entry.createUserId),
    version,
    source: typeof entry.source === 'string' && entry.source.trim()
      ? entry.source.trim()
      : 'skill-market-api',
    importedAt: typeof entry.importedAt === 'string' && entry.importedAt.trim()
      ? entry.importedAt.trim()
      : null,
    updatedAt: typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
      ? entry.updatedAt.trim()
      : null,
  };
}

export function createMultitenancyDb(database = db) {
  const assertActiveTenantMember = (tenantId, userId) => {
    const row = database.prepare(`
      SELECT 1
      FROM tenant_users
      WHERE tenant_id = ? AND user_id = ? AND status = 'active'
    `).get(tenantId, userId);

    if (!row) {
      throw new Error('user must be an active member of the workspace tenant');
    }
  };

  const replaceAclTransaction = database.transaction(({ workspaceId, ownerUserId, entries }) => {
    const workspace = database.prepare(`
      SELECT id, tenant_id, owner_user_id
      FROM workspaces
      WHERE id = ? AND status != 'deleted'
    `).get(workspaceId);
    if (!workspace) {
      throw new Error('workspace not found');
    }
    if (workspace.owner_user_id !== ownerUserId) {
      throw new Error('only the workspace owner can replace workspace ACL');
    }

    database.prepare('DELETE FROM workspace_acl WHERE workspace_id = ?').run(workspaceId);

    const insertAcl = database.prepare(`
      INSERT INTO workspace_acl (workspace_id, user_id, permission, created_by_user_id)
      VALUES (?, ?, ?, ?)
    `);

    for (const entry of entries) {
      const userId = requirePositiveInteger(entry.userId, 'entry.userId');
      if (userId === ownerUserId) continue;

      const permission = requireEnum(entry.permission, PERMISSIONS, 'entry.permission');
      assertActiveTenantMember(workspace.tenant_id, userId);
      insertAcl.run(workspaceId, userId, permission, ownerUserId);
    }
  });

  const upsertSystemAdminMembership = ({ tenantId, userId }) => {
    database.prepare(`
      INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
      VALUES (?, ?, 'system_admin', 'edit', 'active')
      ON CONFLICT(tenant_id, user_id)
      DO UPDATE SET
        role = 'system_admin',
        permission = 'edit',
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    `).run(tenantId, userId);

    return database.prepare(`
      SELECT *
      FROM tenant_users
      WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, userId);
  };

  const grantSystemAdminAccessToAllTenantsTransaction = database.transaction((userId) => {
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const tenants = database.prepare(`
      SELECT id
      FROM tenants
      WHERE status = 'active'
      ORDER BY id ASC
    `).all();

    return tenants.map((tenant) => upsertSystemAdminMembership({
      tenantId: tenant.id,
      userId: normalizedUserId,
    }));
  });

  const upsertSessionMessagesTransaction = database.transaction(({
    tenantId,
    workspaceId,
    userId,
    runtimeId,
    provider,
    providerSessionId = null,
    messages,
  }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
    const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
    const normalizedProviderSessionId = optionalNonEmptyString(providerSessionId, 'providerSessionId');

    if (!Array.isArray(messages)) {
      throw new Error('messages must be an array');
    }

    const runtime = database.prepare(`
      SELECT tenant_id, workspace_id, user_id, provider
      FROM agent_session_runtime
      WHERE runtime_id = ?
    `).get(normalizedRuntimeId);

    if (!runtime) {
      throw new Error('runtime not found');
    }
    if (
      runtime.tenant_id !== normalizedTenantId ||
      runtime.workspace_id !== normalizedWorkspaceId ||
      runtime.user_id !== normalizedUserId ||
      runtime.provider !== normalizedProvider
    ) {
      throw new Error('runtime does not belong to the supplied tenant workspace user');
    }

    let nextSequence = database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM agent_session_messages
      WHERE runtime_id = ?
    `).get(normalizedRuntimeId).next_sequence;

    const insertMessage = database.prepare(`
      INSERT INTO agent_session_messages (
        tenant_id,
        workspace_id,
        user_id,
        runtime_id,
        provider,
        provider_session_id,
        message_id,
        kind,
        role,
        content_text,
        normalized_json,
        provider_timestamp,
        sequence
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id, message_id)
      DO UPDATE SET
        provider_session_id = CASE
          WHEN excluded.provider_session_id IS NOT NULL THEN excluded.provider_session_id
          ELSE agent_session_messages.provider_session_id
        END,
        kind = excluded.kind,
        role = excluded.role,
        content_text = excluded.content_text,
        normalized_json = excluded.normalized_json,
        provider_timestamp = excluded.provider_timestamp,
        updated_at = CURRENT_TIMESTAMP
    `);

    let changed = 0;
    for (const message of messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      if (isHiddenSessionMessage(normalizedProvider, message)) {
        continue;
      }

      const messageId = requireNonEmptyString(message.id || message.messageId, 'message.id');
      const kind = requireNonEmptyString(message.kind, 'message.kind');
      const sequence = Number.isInteger(message.sequence) && message.sequence > 0
        ? message.sequence
        : nextSequence++;

      const result = insertMessage.run(
        normalizedTenantId,
        normalizedWorkspaceId,
        normalizedUserId,
        normalizedRuntimeId,
        normalizedProvider,
        normalizedProviderSessionId,
        messageId,
        kind,
        normalizeMessageRole(message.role),
        extractContentText(message),
        JSON.stringify(message),
        typeof message.timestamp === 'string' ? message.timestamp : null,
        sequence,
      );
      changed += result.changes;
    }

    return changed;
  });

  const replaceSkillMarketImportsTransaction = database.transaction(({ workspaceId, imports }) => {
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const importEntries = imports && typeof imports === 'object' && !Array.isArray(imports)
      ? Object.entries(imports)
      : [];

    database.prepare('DELETE FROM workspace_skill_market_imports WHERE workspace_id = ?').run(normalizedWorkspaceId);

    const insertImport = database.prepare(`
      INSERT INTO workspace_skill_market_imports (
        workspace_id,
        skill_name,
        skill_id,
        remote_id,
        display_name,
        nsp_path,
        create_user_id,
        version,
        source,
        imported_at,
        updated_at
      )
      VALUES (
        @workspaceId,
        @name,
        @skillId,
        @remoteId,
        @displayName,
        @nspPath,
        @createUserId,
        @version,
        @source,
        COALESCE(@importedAt, CURRENT_TIMESTAMP),
        COALESCE(@updatedAt, CURRENT_TIMESTAMP)
      )
    `);

    for (const [skillName, entry] of importEntries) {
      insertImport.run({
        workspaceId: normalizedWorkspaceId,
        ...normalizeSkillMarketImportEntry(skillName, entry),
      });
    }
  });

  const listTenantSqlCheckRuleIds = (tenantId) => {
    const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
    return database.prepare(`
      SELECT rule_id
      FROM tenant_sql_check_rules
      WHERE tenant_id = ?
      ORDER BY sort_order ASC, rule_id COLLATE NOCASE ASC
    `).all(normalizedTenantId).map((row) => row.rule_id);
  };

  const listUserSqlCheckRuleIds = ({ workspaceId, userId }) => {
    const normalizedWorkspaceId = requirePositiveInteger(Number(workspaceId), 'workspaceId');
    const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
    return database.prepare(`
      SELECT rule_id
      FROM user_sql_check_rules
      WHERE workspace_id = ? AND user_id = ?
      ORDER BY sort_order ASC, rule_id COLLATE NOCASE ASC
    `).all(normalizedWorkspaceId, normalizedUserId).map((row) => row.rule_id);
  };

  const replaceTenantSqlCheckRulesTransaction = database.transaction(({ tenantId, ruleIds }) => {
    const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
    const normalizedRuleIds = normalizeSqlCheckRuleIds(ruleIds);
    database.prepare('DELETE FROM tenant_sql_check_rules WHERE tenant_id = ?').run(normalizedTenantId);

    const insertRule = database.prepare(`
      INSERT INTO tenant_sql_check_rules (tenant_id, rule_id, sort_order)
      VALUES (?, ?, ?)
    `);
    normalizedRuleIds.forEach((ruleId, index) => {
      insertRule.run(normalizedTenantId, ruleId, index);
    });

    return listTenantSqlCheckRuleIds(normalizedTenantId);
  });

  const setUserSqlCheckPreferenceTransaction = database.transaction(({ tenantId, workspaceId, userId, customEnabled, ruleIds }) => {
    const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(Number(workspaceId), 'workspaceId');
    const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
    const enabled = customEnabled === true || customEnabled === 1 ? 1 : 0;
    const normalizedRuleIds = normalizeSqlCheckRuleIds(ruleIds);

    database.prepare(`
      INSERT INTO user_sql_check_preferences (tenant_id, workspace_id, user_id, custom_enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id)
      DO UPDATE SET
        tenant_id = excluded.tenant_id,
        custom_enabled = excluded.custom_enabled,
        updated_at = CURRENT_TIMESTAMP
    `).run(normalizedTenantId, normalizedWorkspaceId, normalizedUserId, enabled);

    if (enabled === 1) {
      database.prepare(`
        DELETE FROM user_sql_check_rules
        WHERE workspace_id = ? AND user_id = ?
      `).run(normalizedWorkspaceId, normalizedUserId);

      const insertRule = database.prepare(`
        INSERT INTO user_sql_check_rules (tenant_id, workspace_id, user_id, rule_id, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);
      normalizedRuleIds.forEach((ruleId, index) => {
        insertRule.run(normalizedTenantId, normalizedWorkspaceId, normalizedUserId, ruleId, index);
      });
    }

    return {
      customEnabled: enabled === 1,
      ruleIds: listUserSqlCheckRuleIds({ workspaceId: normalizedWorkspaceId, userId: normalizedUserId }),
    };
  });

  const getUserSqlCheckPreference = ({ tenantId, workspaceId, userId }) => {
    const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(Number(workspaceId), 'workspaceId');
    const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
    const preference = database.prepare(`
      SELECT custom_enabled
      FROM user_sql_check_preferences
      WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?
    `).get(normalizedTenantId, normalizedWorkspaceId, normalizedUserId);

    return {
      tenantId: normalizedTenantId,
      workspaceId: normalizedWorkspaceId,
      userId: normalizedUserId,
      hasUserPreference: Boolean(preference),
      customEnabled: preference?.custom_enabled === 1,
      ruleIds: listUserSqlCheckRuleIds({ workspaceId: normalizedWorkspaceId, userId: normalizedUserId }),
    };
  };

  const resolveUserSqlCheckConfig = ({ tenantId, workspaceId, userId }) => {
    const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(Number(workspaceId), 'workspaceId');
    const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
    const tenantRuleIds = listTenantSqlCheckRuleIds(normalizedTenantId);
    const userPreference = getUserSqlCheckPreference({
      tenantId: normalizedTenantId,
      workspaceId: normalizedWorkspaceId,
      userId: normalizedUserId,
    });
    const effectiveRuleIds = userPreference.customEnabled
      ? userPreference.ruleIds
      : tenantRuleIds;

    return {
      tenantId: normalizedTenantId,
      workspaceId: normalizedWorkspaceId,
      userId: normalizedUserId,
      tenantRuleIds,
      hasUserPreference: userPreference.hasUserPreference,
      customEnabled: userPreference.customEnabled,
      userRuleIds: userPreference.ruleIds,
      effectiveRuleIds,
      source: userPreference.customEnabled ? 'user' : 'tenant',
    };
  };

  return {
    tenants: {
      createTenant: ({
        code,
        name,
        status = 'active',
        prodCode = null,
      }) => {
        const tenantCode = requireCode(code);
        const tenantName = requireNonEmptyString(name, 'name');
        const tenantStatus = requireEnum(status, TENANT_STATUSES, 'status');
        const tenantProdCode = optionalNonEmptyString(prodCode, 'prodCode');

        const result = database.prepare(`
          INSERT INTO tenants (code, name, prod_code, status)
          VALUES (?, ?, ?, ?)
        `).run(tenantCode, tenantName, tenantProdCode, tenantStatus);

        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(result.lastInsertRowid));
      },

      getTenantById: (tenantId) => {
        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(requirePositiveInteger(tenantId, 'tenantId')) ?? null;
      },

      updateTenantCodes: ({ id, code, prodCode = null }) => {
        const normalizedId = requirePositiveInteger(Number(id), 'tenantId');
        const tenantCode = requireCode(code);
        const tenantProdCode = optionalNonEmptyString(prodCode, 'prodCode');

        const result = database.prepare(`
          UPDATE tenants
          SET code = ?,
              prod_code = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(tenantCode, tenantProdCode, normalizedId);

        if (result.changes === 0) {
          throw new Error('tenant not found');
        }

        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(normalizedId);
      },

      listTenantsForUser: (userId) => {
        return database.prepare(`
          SELECT t.*
          FROM tenants t
          JOIN tenant_users tu ON tu.tenant_id = t.id
          WHERE tu.user_id = ?
            AND tu.status = 'active'
            AND t.status = 'active'
          ORDER BY t.code ASC
        `).all(requirePositiveInteger(userId, 'userId'));
      },

      listTenants: () => {
        return database.prepare('SELECT * FROM tenants ORDER BY code ASC').all();
      },
    },

    memberships: {
      upsertMembership: ({ tenantId, userId, role = 'member', permission = 'view', status = 'active' }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedRole = requireNonEmptyString(role, 'role');
        const normalizedPermission = requireEnum(permission, PERMISSIONS, 'permission');
        const normalizedStatus = requireEnum(status, MEMBERSHIP_STATUSES, 'status');

        database.prepare(`
          INSERT INTO tenant_users (tenant_id, user_id, role, permission, status)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, user_id)
          DO UPDATE SET
            role = excluded.role,
            permission = excluded.permission,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP
        `).run(normalizedTenantId, normalizedUserId, normalizedRole, normalizedPermission, normalizedStatus);

        return database.prepare(`
          SELECT *
          FROM tenant_users
          WHERE tenant_id = ? AND user_id = ?
        `).get(normalizedTenantId, normalizedUserId);
      },

      listMemberships: ({ tenantId, userId } = {}) => {
        const filters = [];
        const params = [];

        if (tenantId != null) {
          filters.push('tu.tenant_id = ?');
          params.push(requirePositiveInteger(tenantId, 'tenantId'));
        }

        if (userId != null) {
          filters.push('tu.user_id = ?');
          params.push(requirePositiveInteger(userId, 'userId'));
        }

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        return database.prepare(`
          SELECT
            tu.tenant_id,
            tu.user_id,
            tu.role,
            tu.permission,
            tu.status,
            tu.created_at,
            tu.updated_at,
            t.code AS tenant_code,
            t.name AS tenant_name,
            t.status AS tenant_status,
            u.username,
            u.is_active AS user_is_active,
            u.is_system_admin
          FROM tenant_users tu
          JOIN tenants t ON t.id = tu.tenant_id
          JOIN users u ON u.id = tu.user_id
          ${whereClause}
          ORDER BY t.code COLLATE NOCASE ASC, u.username COLLATE NOCASE ASC
        `).all(...params);
      },

      deleteMembership: ({ tenantId, userId }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');

        const removeMembership = database.transaction(() => {
          database.prepare(`
            DELETE FROM workspace_acl
            WHERE user_id = ?
              AND workspace_id IN (
                SELECT id
                FROM workspaces
                WHERE tenant_id = ?
              )
          `).run(normalizedUserId, normalizedTenantId);

          const result = database.prepare(`
            DELETE FROM tenant_users
            WHERE tenant_id = ? AND user_id = ?
          `).run(normalizedTenantId, normalizedUserId);

          return result.changes > 0;
        });

        return removeMembership();
      },

      getMembership: (userId, tenantId) => {
        return database.prepare(`
          SELECT *
          FROM tenant_users
          WHERE user_id = ? AND tenant_id = ?
        `).get(
          requirePositiveInteger(userId, 'userId'),
          requirePositiveInteger(tenantId, 'tenantId'),
        ) ?? null;
      },

      getActiveMembership: (userId, tenantId) => {
        return database.prepare(`
          SELECT *
          FROM tenant_users
          WHERE user_id = ? AND tenant_id = ? AND status = 'active'
        `).get(
          requirePositiveInteger(userId, 'userId'),
          requirePositiveInteger(tenantId, 'tenantId'),
        ) ?? null;
      },

      grantSystemAdminAccessToTenant: ({ userId, tenantId }) => {
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const tenant = database.prepare(`
          SELECT id
          FROM tenants
          WHERE id = ? AND status = 'active'
        `).get(normalizedTenantId);

        if (!tenant) return null;

        return upsertSystemAdminMembership({
          tenantId: normalizedTenantId,
          userId: normalizedUserId,
        });
      },

      grantSystemAdminAccessToAllTenants: (userId) => grantSystemAdminAccessToAllTenantsTransaction(userId),
    },

    workspaces: {
      createWorkspace: ({ tenantId, ownerUserId, slug, displayName, path: workspacePath, status = 'active' }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedOwnerId = requirePositiveInteger(ownerUserId, 'ownerUserId');
        const normalizedSlug = requireSlug(slug);
        const normalizedDisplayName = requireNonEmptyString(displayName, 'displayName');
        const normalizedPath = requireNonEmptyString(workspacePath, 'path');
        const normalizedStatus = requireEnum(status, WORKSPACE_STATUSES, 'status');

        assertActiveTenantMember(normalizedTenantId, normalizedOwnerId);

        const result = database.prepare(`
          INSERT INTO workspaces (tenant_id, owner_user_id, slug, display_name, path, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          normalizedTenantId,
          normalizedOwnerId,
          normalizedSlug,
          normalizedDisplayName,
          normalizedPath,
          normalizedStatus,
        );

        return database.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(result.lastInsertRowid));
      },

      getWorkspaceById: (workspaceId) => {
        return database.prepare('SELECT * FROM workspaces WHERE id = ?').get(requirePositiveInteger(workspaceId, 'workspaceId')) ?? null;
      },

      getWorkspaceByTenantSlug: ({ tenantId, ownerUserId, slug }) => {
        return database.prepare(`
          SELECT *
          FROM workspaces
          WHERE tenant_id = ? AND owner_user_id = ? AND slug = ?
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(ownerUserId, 'ownerUserId'),
          requireSlug(slug),
        ) ?? null;
      },

      getWorkspaceByTenantSlugForUser: ({ tenantId, userId, slug }) => {
        return database.prepare(`
          SELECT *
          FROM (
            SELECT
              w.*,
              'owner' AS accessRole,
              'edit' AS accessPermission
            FROM workspaces w
            JOIN tenant_users tu ON tu.tenant_id = w.tenant_id AND tu.user_id = ?
            WHERE w.tenant_id = ?
              AND w.owner_user_id = ?
              AND w.slug = ?
              AND w.status = 'active'
              AND tu.status = 'active'

            UNION

            SELECT
              w.*,
              wa.permission AS accessRole,
              wa.permission AS accessPermission
            FROM workspaces w
            JOIN workspace_acl wa ON wa.workspace_id = w.id
            JOIN tenant_users tu ON tu.tenant_id = w.tenant_id AND tu.user_id = wa.user_id
            WHERE w.tenant_id = ?
              AND wa.user_id = ?
              AND w.slug = ?
              AND w.status = 'active'
              AND tu.status = 'active'
          ) AS visibleWorkspaces
          ORDER BY accessRole = 'edit' DESC, id ASC
          LIMIT 1
        `).get(
          requirePositiveInteger(userId, 'userId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireSlug(slug),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireSlug(slug),
        ) ?? null;
      },

      updateDisplayName: ({ workspaceId, displayName }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedDisplayName = requireNonEmptyString(displayName, 'displayName');

        const result = database.prepare(`
          UPDATE workspaces
          SET display_name = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status != 'deleted'
        `).run(normalizedDisplayName, normalizedWorkspaceId);

        if (!result.changes) {
          throw new Error('Workspace not found');
        }

        return database.prepare('SELECT * FROM workspaces WHERE id = ?').get(normalizedWorkspaceId);
      },

      markDeleted: ({ workspaceId }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const result = database.prepare(`
          UPDATE workspaces
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status != 'deleted'
        `).run(normalizedWorkspaceId);

        return result.changes > 0;
      },

      listVisibleWorkspaces: ({ tenantId, userId }) => {
        return database.prepare(`
          SELECT w.*, 'owner' AS "accessRole", 'edit' AS "accessPermission"
          FROM workspaces w
          JOIN tenant_users tu ON tu.tenant_id = w.tenant_id AND tu.user_id = ?
          WHERE w.tenant_id = ?
            AND w.owner_user_id = ?
            AND w.status = 'active'
            AND tu.status = 'active'

          UNION

          SELECT w.*, wa.permission AS "accessRole", wa.permission AS "accessPermission"
          FROM workspaces w
          JOIN workspace_acl wa ON wa.workspace_id = w.id
          JOIN tenant_users tu ON tu.tenant_id = w.tenant_id AND tu.user_id = wa.user_id
          WHERE w.tenant_id = ?
            AND wa.user_id = ?
            AND w.status = 'active'
            AND tu.status = 'active'

          ORDER BY display_name ASC, id ASC
        `).all(
          requirePositiveInteger(userId, 'userId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
        );
      },
    },

    workspaceAcl: {
      listAcl: (workspaceId) => {
        return database.prepare(`
          SELECT wa.*, u.username
          FROM workspace_acl wa
          JOIN users u ON u.id = wa.user_id
          WHERE wa.workspace_id = ?
          ORDER BY u.username ASC
        `).all(requirePositiveInteger(workspaceId, 'workspaceId'));
      },

      replaceAcl: ({ workspaceId, ownerUserId, entries }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedOwnerId = requirePositiveInteger(ownerUserId, 'ownerUserId');
        if (!Array.isArray(entries)) {
          throw new Error('entries must be an array');
        }

        replaceAclTransaction({
          workspaceId: normalizedWorkspaceId,
          ownerUserId: normalizedOwnerId,
          entries,
        });

        return database.prepare('SELECT * FROM workspace_acl WHERE workspace_id = ? ORDER BY user_id ASC').all(normalizedWorkspaceId);
      },

      getAclEntry: (workspaceId, userId) => {
        return database.prepare(`
          SELECT *
          FROM workspace_acl
          WHERE workspace_id = ? AND user_id = ?
        `).get(
          requirePositiveInteger(workspaceId, 'workspaceId'),
          requirePositiveInteger(userId, 'userId'),
        ) ?? null;
      },
    },

    sqlCheck: {
      getTenantConfig: (tenantId) => {
        const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
        return {
          tenantId: normalizedTenantId,
          ruleIds: listTenantSqlCheckRuleIds(normalizedTenantId),
        };
      },

      replaceTenantConfig: ({ tenantId, ruleIds }) => {
        const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
        return {
          tenantId: normalizedTenantId,
          ruleIds: replaceTenantSqlCheckRulesTransaction({ tenantId: normalizedTenantId, ruleIds }),
        };
      },

      getUserPreference: getUserSqlCheckPreference,

      setUserPreference: ({ tenantId, workspaceId, userId, customEnabled, ruleIds = [] }) => {
        const normalizedTenantId = requirePositiveInteger(Number(tenantId), 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(Number(workspaceId), 'workspaceId');
        const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
        const saved = setUserSqlCheckPreferenceTransaction({
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
          userId: normalizedUserId,
          customEnabled,
          ruleIds,
        });

        return {
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
          userId: normalizedUserId,
          customEnabled: saved.customEnabled,
          ruleIds: saved.ruleIds,
        };
      },

      resolveUserConfig: resolveUserSqlCheckConfig,
    },

    mcpPresets: {
      createPreset: ({
        tenantId,
        name,
        displayName,
        description = '',
        config,
        preinstallScope = 'none',
        status = 'draft',
        createdByUserId,
        updatedByUserId = createdByUserId,
      }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedName = normalizeMcpServerName(name);
        const normalizedDisplayName = requireNonEmptyString(displayName, 'displayName');
        const normalizedDescription = typeof description === 'string' ? description.trim() : '';
        const { transport, configJson } = normalizeMcpConfig(config);
        const normalizedPreinstallScope = normalizeMcpPreinstallScope(preinstallScope);
        const normalizedStatus = requireEnum(status, MCP_PRESET_STATUSES, 'status');
        const normalizedCreatedBy = requirePositiveInteger(createdByUserId, 'createdByUserId');
        const normalizedUpdatedBy = requirePositiveInteger(updatedByUserId, 'updatedByUserId');

        const result = database.prepare(`
          INSERT INTO mcp_server_presets (
            tenant_id,
            name,
            display_name,
            description,
            transport,
            config_json,
            preinstall_scope,
            status,
            created_by_user_id,
            updated_by_user_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedTenantId,
          normalizedName,
          normalizedDisplayName,
          normalizedDescription,
          transport,
          configJson,
          normalizedPreinstallScope,
          normalizedStatus,
          normalizedCreatedBy,
          normalizedUpdatedBy,
        );

        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE id = ?
        `).get(Number(result.lastInsertRowid)));
      },

      updatePreset: ({
        presetId,
        tenantId,
        name,
        displayName,
        description = '',
        config,
        preinstallScope = 'none',
        status,
        updatedByUserId,
      }) => {
        const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedName = normalizeMcpServerName(name);
        const normalizedDisplayName = requireNonEmptyString(displayName, 'displayName');
        const normalizedDescription = typeof description === 'string' ? description.trim() : '';
        const { transport, configJson } = normalizeMcpConfig(config);
        const normalizedPreinstallScope = normalizeMcpPreinstallScope(preinstallScope);
        const normalizedStatus = requireEnum(status, MCP_PRESET_STATUSES, 'status');
        const normalizedUpdatedBy = requirePositiveInteger(updatedByUserId, 'updatedByUserId');

        database.prepare(`
          UPDATE mcp_server_presets
          SET
            name = ?,
            display_name = ?,
            description = ?,
            transport = ?,
            config_json = ?,
            preinstall_scope = ?,
            status = ?,
            last_test_status = NULL,
            last_test_error = NULL,
            last_tested_at = NULL,
            tool_count = 0,
            tools_json = NULL,
            docker_compatible = 0,
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND tenant_id = ?
        `).run(
          normalizedName,
          normalizedDisplayName,
          normalizedDescription,
          transport,
          configJson,
          normalizedPreinstallScope,
          normalizedStatus,
          normalizedUpdatedBy,
          normalizedPresetId,
          normalizedTenantId,
        );

        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE id = ? AND tenant_id = ?
        `).get(normalizedPresetId, normalizedTenantId));
      },

      getPresetById: ({ tenantId, presetId }) => {
        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE tenant_id = ? AND id = ?
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        ));
      },

      listPresets: ({ tenantId, includeDisabled = true, status = null, preinstallScope = null }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const whereClauses = ['tenant_id = ?'];
        const params = [normalizedTenantId];

        if (status != null) {
          whereClauses.push('status = ?');
          params.push(requireEnum(status, MCP_PRESET_STATUSES, 'status'));
        } else if (!includeDisabled) {
          whereClauses.push("status != 'disabled'");
        }

        if (preinstallScope != null) {
          whereClauses.push('preinstall_scope = ?');
          params.push(normalizeMcpPreinstallScope(preinstallScope));
        }

        return database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE ${whereClauses.join(' AND ')}
          ORDER BY display_name ASC, id ASC
        `).all(...params).map(hydrateMcpPresetRow);
      },

      publishPreset: ({ tenantId, presetId, updatedByUserId }) => {
        database.prepare(`
          UPDATE mcp_server_presets
          SET
            status = 'published',
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND id = ?
        `).run(
          requirePositiveInteger(updatedByUserId, 'updatedByUserId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        );

        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE tenant_id = ? AND id = ?
        `).get(tenantId, presetId));
      },

      disablePreset: ({ tenantId, presetId, updatedByUserId }) => {
        database.prepare(`
          UPDATE mcp_server_presets
          SET
            status = 'disabled',
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND id = ?
        `).run(
          requirePositiveInteger(updatedByUserId, 'updatedByUserId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        );

        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE tenant_id = ? AND id = ?
        `).get(tenantId, presetId));
      },

      deletePreset: ({ tenantId, presetId }) => {
        const result = database.prepare(`
          DELETE FROM mcp_server_presets
          WHERE tenant_id = ?
            AND id = ?
        `).run(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        );

        return result.changes > 0;
      },

      recordPresetTest: ({
        tenantId,
        presetId,
        status,
        error = null,
        toolCount = 0,
        tools = [],
        dockerCompatible = false,
        updatedByUserId,
      }) => {
        const normalizedToolsJson = normalizeToolsJson(tools);
        database.prepare(`
          UPDATE mcp_server_presets
          SET
            last_test_status = ?,
            last_test_error = ?,
            last_tested_at = CURRENT_TIMESTAMP,
            tool_count = ?,
            tools_json = ?,
            docker_compatible = ?,
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND id = ?
        `).run(
          requireNonEmptyString(status, 'status'),
          error == null ? null : String(error),
          Number.isInteger(toolCount) && toolCount >= 0 ? toolCount : 0,
          normalizedToolsJson,
          dockerCompatible ? 1 : 0,
          requirePositiveInteger(updatedByUserId, 'updatedByUserId'),
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        );

        return hydrateMcpPresetRow(database.prepare(`
          SELECT *
          FROM mcp_server_presets
          WHERE tenant_id = ? AND id = ?
        `).get(tenantId, presetId));
      },
    },

    mcpPresetHelperScripts: {
      upsertScript: ({
        tenantId,
        presetId,
        fileName,
        content,
        uploadedByUserId,
      }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
        const normalizedFileName = requireNonEmptyString(fileName, 'fileName');
        const normalizedContent = typeof content === 'string' ? content : String(content ?? '');
        const normalizedUploadedBy = requirePositiveInteger(uploadedByUserId, 'uploadedByUserId');
        const sizeBytes = Buffer.byteLength(normalizedContent, 'utf8');
        const sha256 = crypto.createHash('sha256').update(normalizedContent).digest('hex');

        database.prepare(`
          INSERT INTO mcp_preset_helper_scripts (
            preset_id,
            tenant_id,
            file_name,
            content,
            size_bytes,
            sha256,
            uploaded_by_user_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(preset_id)
          DO UPDATE SET
            tenant_id = excluded.tenant_id,
            file_name = excluded.file_name,
            content = excluded.content,
            size_bytes = excluded.size_bytes,
            sha256 = excluded.sha256,
            uploaded_by_user_id = excluded.uploaded_by_user_id,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          normalizedPresetId,
          normalizedTenantId,
          normalizedFileName,
          normalizedContent,
          sizeBytes,
          sha256,
          normalizedUploadedBy,
        );
        database.prepare(`
          UPDATE mcp_server_presets
          SET
            status = 'draft',
            last_test_status = NULL,
            last_test_error = NULL,
            last_tested_at = NULL,
            tool_count = 0,
            tools_json = NULL,
            docker_compatible = 0,
            updated_by_user_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND id = ?
        `).run(normalizedUploadedBy, normalizedTenantId, normalizedPresetId);

        return hydrateMcpHelperScriptRow(database.prepare(`
          SELECT *
          FROM mcp_preset_helper_scripts
          WHERE tenant_id = ?
            AND preset_id = ?
        `).get(normalizedTenantId, normalizedPresetId));
      },

      getScript: ({ tenantId, presetId }) => {
        return hydrateMcpHelperScriptRow(database.prepare(`
          SELECT *
          FROM mcp_preset_helper_scripts
          WHERE tenant_id = ?
            AND preset_id = ?
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        ));
      },

      deleteScript: ({ tenantId, presetId }) => {
        const result = database.prepare(`
          DELETE FROM mcp_preset_helper_scripts
          WHERE tenant_id = ?
            AND preset_id = ?
        `).run(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(presetId, 'presetId'),
        );
        return result.changes > 0;
      },
    },

    mcpInstalls: {
      upsertInstall: ({
        workspaceId,
        presetId,
        installedByUserId,
        probeStatus = null,
        probeError = null,
        toolCount = 0,
        tools = [],
      }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
        const normalizedInstalledBy = requirePositiveInteger(installedByUserId, 'installedByUserId');
        const normalizedToolsJson = normalizeToolsJson(tools);
        const normalizedToolCount = Number.isInteger(toolCount) && toolCount >= 0 ? toolCount : 0;

        database.prepare(`
          INSERT INTO workspace_mcp_preset_installs (
            workspace_id,
            preset_id,
            installed_by_user_id,
            status,
            last_probe_status,
            last_probe_error,
            tool_count,
            tools_json
          )
          VALUES (?, ?, ?, 'installed', ?, ?, ?, ?)
          ON CONFLICT(workspace_id, preset_id)
          DO UPDATE SET
            installed_by_user_id = excluded.installed_by_user_id,
            status = 'installed',
            updated_at = CURRENT_TIMESTAMP,
            last_applied_at = CURRENT_TIMESTAMP,
            last_probe_status = excluded.last_probe_status,
            last_probe_error = excluded.last_probe_error,
            tool_count = excluded.tool_count,
            tools_json = excluded.tools_json
        `).run(
          normalizedWorkspaceId,
          normalizedPresetId,
          normalizedInstalledBy,
          probeStatus == null ? null : String(probeStatus),
          probeError == null ? null : String(probeError),
          normalizedToolCount,
          normalizedToolsJson,
        );

        return hydrateMcpInstallRow(database.prepare(`
          SELECT *
          FROM workspace_mcp_preset_installs
          WHERE workspace_id = ? AND preset_id = ?
        `).get(normalizedWorkspaceId, normalizedPresetId));
      },

      removeInstall: ({ workspaceId, presetId }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
        database.prepare(`
          UPDATE workspace_mcp_preset_installs
          SET
            status = 'removed',
            updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ?
            AND preset_id = ?
        `).run(normalizedWorkspaceId, normalizedPresetId);

        return hydrateMcpInstallRow(database.prepare(`
          SELECT *
          FROM workspace_mcp_preset_installs
          WHERE workspace_id = ? AND preset_id = ?
        `).get(normalizedWorkspaceId, normalizedPresetId));
      },

      recordProbe: ({
        workspaceId,
        presetId,
        probeStatus = null,
        probeError = null,
        toolCount = 0,
        tools = [],
      }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
        const normalizedToolsJson = normalizeToolsJson(tools);
        const normalizedToolCount = Number.isInteger(toolCount) && toolCount >= 0 ? toolCount : 0;

        database.prepare(`
          UPDATE workspace_mcp_preset_installs
          SET
            last_probe_status = ?,
            last_probe_error = ?,
            tool_count = ?,
            tools_json = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = ?
            AND preset_id = ?
            AND status = 'installed'
        `).run(
          probeStatus == null ? null : String(probeStatus),
          probeError == null ? null : String(probeError),
          normalizedToolCount,
          normalizedToolsJson,
          normalizedWorkspaceId,
          normalizedPresetId,
        );

        return hydrateMcpInstallRow(database.prepare(`
          SELECT *
          FROM workspace_mcp_preset_installs
          WHERE workspace_id = ? AND preset_id = ?
        `).get(normalizedWorkspaceId, normalizedPresetId));
      },

      listInstallsForWorkspace: ({ workspaceId, includeRemoved = false }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const whereStatus = includeRemoved ? '' : "AND i.status = 'installed'";
        return database.prepare(`
          SELECT
            i.*,
            p.tenant_id,
            p.name,
            p.display_name,
            p.description,
            p.transport,
            p.status AS preset_status,
            p.docker_compatible,
            p.config_json,
            p.tools_json AS preset_tools_json
          FROM workspace_mcp_preset_installs i
          JOIN mcp_server_presets p ON p.id = i.preset_id
          WHERE i.workspace_id = ?
            ${whereStatus}
          ORDER BY p.display_name ASC, p.id ASC
        `).all(normalizedWorkspaceId).map(hydrateMcpInstallRow);
      },
    },

    skillMarketImports: {
      listForWorkspace: ({ workspaceId }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        return database.prepare(`
          SELECT *
          FROM workspace_skill_market_imports
          WHERE workspace_id = ?
          ORDER BY skill_name COLLATE NOCASE ASC
        `).all(normalizedWorkspaceId).map(hydrateSkillMarketImportRow);
      },

      replaceForWorkspace: ({ workspaceId, imports }) => {
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        replaceSkillMarketImportsTransaction({ workspaceId: normalizedWorkspaceId, imports });
        return database.prepare(`
          SELECT *
          FROM workspace_skill_market_imports
          WHERE workspace_id = ?
          ORDER BY skill_name COLLATE NOCASE ASC
        `).all(normalizedWorkspaceId).map(hydrateSkillMarketImportRow);
      },

      deleteForWorkspace: ({ workspaceId, skillName }) => {
        const result = database.prepare(`
          DELETE FROM workspace_skill_market_imports
          WHERE workspace_id = ?
            AND skill_name = ?
        `).run(
          requirePositiveInteger(workspaceId, 'workspaceId'),
          requireNonEmptyString(skillName, 'skillName'),
        );
        return result.changes > 0;
      },
    },

    sessions: {
      upsertSession: ({
        tenantId,
        workspaceId,
        userId,
        provider,
        providerSessionId,
        summary = null,
        status = 'active',
        metadata = null,
      }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedStatus = requireEnum(status, SESSION_STATUSES, 'status');
        const normalizedSummary = summary == null ? null : requireNonEmptyString(summary, 'summary');
        const metadataJson = serializeMetadata(metadata);

        database.prepare(`
          INSERT INTO session_index (
            tenant_id,
            workspace_id,
            user_id,
            provider,
            provider_session_id,
            summary,
            status,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, provider_session_id, user_id)
          DO UPDATE SET
            tenant_id = excluded.tenant_id,
            workspace_id = excluded.workspace_id,
            summary = excluded.summary,
            status = excluded.status,
            metadata_json = excluded.metadata_json,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
          normalizedProvider,
          normalizedProviderSessionId,
          normalizedSummary,
          normalizedStatus,
          metadataJson,
        );

        return database.prepare(`
          SELECT *
          FROM session_index
          WHERE provider = ? AND provider_session_id = ? AND user_id = ?
        `).get(normalizedProvider, normalizedProviderSessionId, normalizedUserId);
      },

      listSessions: ({ tenantId, workspaceId, userId, provider = null }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const projectKey = normalizeFavoriteProjectKey({
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
        });
        const params = [
          projectKey,
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
        ];
        let providerFilter = '';

        if (provider != null) {
          providerFilter = 'AND si.provider = ?';
          params.push(requireEnum(provider, PROVIDERS, 'provider'));
        }

        return database.prepare(`
          SELECT
            si.*,
            CASE WHEN usf.user_id IS NULL THEN 0 ELSE 1 END AS is_favorited
          FROM session_index si
          LEFT JOIN user_session_favorites usf
            ON usf.user_id = si.user_id
            AND usf.project_key = ?
            AND usf.provider = si.provider
            AND usf.provider_session_id = si.provider_session_id
          WHERE si.tenant_id = ?
            AND si.workspace_id = ?
            AND si.user_id = ?
            AND si.status != 'deleted'
            ${providerFilter}
          ORDER BY is_favorited DESC, si.updated_at DESC, si.id DESC
        `).all(...params);
      },

      findOwnedSession: ({ tenantId, userId, provider, providerSessionId, workspaceId }) => {
        const normalizedWorkspaceId = workspaceId != null
          ? requirePositiveInteger(workspaceId, 'workspaceId')
          : null;

        return database.prepare(`
          SELECT
            si.*,
            w.slug AS workspace_slug,
            w.path AS workspace_path
          FROM session_index si
          JOIN workspaces w ON w.id = si.workspace_id
          WHERE si.tenant_id = ?
            AND si.user_id = ?
            AND si.provider = ?
            AND si.provider_session_id = ?
            AND si.status != 'deleted'
            ${normalizedWorkspaceId != null ? 'AND si.workspace_id = ?' : ''}
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
          ...(normalizedWorkspaceId != null ? [normalizedWorkspaceId] : []),
        ) ?? null;
      },

      markDeleted: ({
        tenantId,
        userId,
        provider,
        providerSessionId,
        workspaceId,
      }) => {
        const normalizedWorkspaceId = workspaceId != null
          ? requirePositiveInteger(workspaceId, 'workspaceId')
          : null;

        const result = database.prepare(`
          UPDATE session_index
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
            ${normalizedWorkspaceId != null ? 'AND workspace_id = ?' : ''}
        `).run(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
          ...(normalizedWorkspaceId != null ? [normalizedWorkspaceId] : []),
        );

        return result.changes > 0;
      },

      renameSummary: ({
        tenantId,
        userId,
        provider,
        providerSessionId,
        workspaceId,
        summary,
      }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedSummary = requireNonEmptyString(summary, 'summary');
        const normalizedWorkspaceId = workspaceId != null
          ? requirePositiveInteger(workspaceId, 'workspaceId')
          : null;

        const result = database.prepare(`
          UPDATE session_index
          SET summary = ?, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
            AND status != 'deleted'
            ${normalizedWorkspaceId != null ? 'AND workspace_id = ?' : ''}
        `).run(
          normalizedSummary,
          normalizedTenantId,
          normalizedUserId,
          normalizedProvider,
          normalizedProviderSessionId,
          ...(normalizedWorkspaceId != null ? [normalizedWorkspaceId] : []),
        );

        return result.changes > 0;
      },
    },

    sessionFavorites: {
      setFavorite: ({
        tenantId = null,
        workspaceId = null,
        userId,
        projectName = null,
        provider,
        providerSessionId,
        favorited = true,
      }) => {
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedTenantId = tenantId == null ? null : requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = workspaceId == null ? null : requirePositiveInteger(workspaceId, 'workspaceId');
        const projectKey = normalizeFavoriteProjectKey({
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
          projectName,
        });

        if (!favorited) {
          const result = database.prepare(`
            DELETE FROM user_session_favorites
            WHERE user_id = ?
              AND project_key = ?
              AND provider = ?
              AND provider_session_id = ?
          `).run(normalizedUserId, projectKey, normalizedProvider, normalizedProviderSessionId);

          return {
            isFavorited: false,
            changed: result.changes > 0,
          };
        }

        database.prepare(`
          INSERT INTO user_session_favorites (
            user_id,
            project_key,
            provider,
            provider_session_id,
            tenant_id,
            workspace_id
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, project_key, provider, provider_session_id)
          DO UPDATE SET
            tenant_id = excluded.tenant_id,
            workspace_id = excluded.workspace_id,
            updated_at = CURRENT_TIMESTAMP
        `).run(
          normalizedUserId,
          projectKey,
          normalizedProvider,
          normalizedProviderSessionId,
          normalizedTenantId,
          normalizedWorkspaceId,
        );

        return {
          isFavorited: true,
          changed: true,
        };
      },

      listFavoritesForScope: ({
        tenantId = null,
        workspaceId = null,
        userId,
        projectName = null,
      }) => {
        const projectKey = normalizeFavoriteProjectKey({ tenantId, workspaceId, projectName });
        return database.prepare(`
          SELECT provider, provider_session_id
          FROM user_session_favorites
          WHERE user_id = ?
            AND project_key = ?
          ORDER BY updated_at DESC, created_at DESC
        `).all(
          requirePositiveInteger(userId, 'userId'),
          projectKey,
        );
      },

      isFavorite: ({
        tenantId = null,
        workspaceId = null,
        userId,
        projectName = null,
        provider,
        providerSessionId,
      }) => {
        const projectKey = normalizeFavoriteProjectKey({ tenantId, workspaceId, projectName });
        const row = database.prepare(`
          SELECT 1
          FROM user_session_favorites
          WHERE user_id = ?
            AND project_key = ?
            AND provider = ?
            AND provider_session_id = ?
        `).get(
          requirePositiveInteger(userId, 'userId'),
          projectKey,
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
        );

        return Boolean(row);
      },
    },

    runtimes: {
      createRuntime: ({
        runtimeId,
        tenantId,
        workspaceId,
        userId,
        provider,
        providerSessionId = null,
        containerName,
        image,
        workspaceHostPath,
        runtimeHomePath,
        status = 'pending',
      }) => {
        const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const normalizedProviderSessionId = optionalNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedContainerName = requireNonEmptyString(containerName, 'containerName');
        const normalizedImage = requireNonEmptyString(image, 'image');
        const normalizedWorkspaceHostPath = requireNonEmptyString(workspaceHostPath, 'workspaceHostPath');
        const normalizedRuntimeHomePath = requireNonEmptyString(runtimeHomePath, 'runtimeHomePath');
        const normalizedStatus = requireEnum(status, RUNTIME_STATUSES, 'status');

        database.prepare(`
          INSERT INTO agent_session_runtime (
            runtime_id,
            tenant_id,
            workspace_id,
            user_id,
            provider,
            provider_session_id,
            container_name,
            image,
            workspace_host_path,
            runtime_home_path,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalizedRuntimeId,
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
          normalizedProvider,
          normalizedProviderSessionId,
          normalizedContainerName,
          normalizedImage,
          normalizedWorkspaceHostPath,
          normalizedRuntimeHomePath,
          normalizedStatus,
        );

        return database.prepare('SELECT * FROM agent_session_runtime WHERE runtime_id = ?').get(normalizedRuntimeId);
      },

      findByRuntimeId: (runtimeId) => {
        return database.prepare(`
          SELECT *
          FROM agent_session_runtime
          WHERE runtime_id = ?
            AND status != 'deleted'
        `).get(requireNonEmptyString(runtimeId, 'runtimeId')) ?? null;
      },

      findByProviderSession: ({ tenantId, workspaceId, userId, provider, providerSessionId }) => {
        return database.prepare(`
          SELECT *
          FROM agent_session_runtime
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
            AND status != 'deleted'
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(workspaceId, 'workspaceId'),
          requirePositiveInteger(userId, 'userId'),
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
        ) ?? null;
      },

      findByOwner: ({ tenantId, workspaceId, userId, provider, workspaceHostPath = null }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const params = [
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
          normalizedProvider,
        ];
        let workspacePathFilter = '';
        if (workspaceHostPath != null) {
          workspacePathFilter = 'AND workspace_host_path = ?';
          params.push(requireNonEmptyString(workspaceHostPath, 'workspaceHostPath'));
        }

        return database.prepare(`
          SELECT *
          FROM agent_session_runtime
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND user_id = ?
            AND provider = ?
            ${workspacePathFilter}
            AND status != 'deleted'
          ORDER BY
            CASE status
              WHEN 'active' THEN 0
              WHEN 'idle' THEN 1
              WHEN 'pending' THEN 2
              WHEN 'failed' THEN 3
              ELSE 4
            END,
            last_used_at DESC,
            id DESC
          LIMIT 1
        `).get(...params) ?? null;
      },

      listForWorkspace: ({ tenantId, workspaceId, includeDeleted = false }) => {
        return database.prepare(`
          SELECT *
          FROM agent_session_runtime
          WHERE tenant_id = ?
            AND workspace_id = ?
            ${includeDeleted ? '' : "AND status != 'deleted'"}
          ORDER BY updated_at DESC, id DESC
        `).all(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(workspaceId, 'workspaceId'),
        );
      },

      bindProviderSession: ({ runtimeId, providerSessionId }) => {
        const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');

        database.prepare(`
          UPDATE agent_session_runtime
          SET
            provider_session_id = ?,
            status = 'active',
            last_used_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE runtime_id = ?
            AND status != 'deleted'
        `).run(normalizedProviderSessionId, normalizedRuntimeId);

        return database.prepare('SELECT * FROM agent_session_runtime WHERE runtime_id = ?').get(normalizedRuntimeId) ?? null;
      },

      updateStatus: ({ runtimeId, status }) => {
        const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
        const normalizedStatus = requireEnum(status, RUNTIME_STATUSES, 'status');

        database.prepare(`
          UPDATE agent_session_runtime
          SET
            status = ?,
            last_used_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE runtime_id = ?
        `).run(normalizedStatus, normalizedRuntimeId);

        return database.prepare('SELECT * FROM agent_session_runtime WHERE runtime_id = ?').get(normalizedRuntimeId) ?? null;
      },

      listForMonitor: (filters = {}) => {
        const normalized = normalizeRuntimeMonitorFilters(filters);
        const whereClauses = [
          "r.status != 'deleted'",
        ];
        const params = [];

        if (normalized.tenantId !== null) {
          whereClauses.push('r.tenant_id = ?');
          params.push(normalized.tenantId);
        }
        if (normalized.userId !== null) {
          whereClauses.push('r.user_id = ?');
          params.push(normalized.userId);
        }
        if (normalized.workspaceId !== null) {
          whereClauses.push('r.workspace_id = ?');
          params.push(normalized.workspaceId);
        }
        if (normalized.provider !== null) {
          whereClauses.push('r.provider = ?');
          params.push(normalized.provider);
        }
        if (normalized.status !== null) {
          whereClauses.push('r.status = ?');
          params.push(normalized.status);
        }
        if (normalized.q !== null) {
          whereClauses.push(`(
            lower(r.runtime_id) LIKE ?
            OR lower(COALESCE(r.provider_session_id, '')) LIKE ?
            OR lower(r.container_name) LIKE ?
            OR lower(r.image) LIKE ?
            OR lower(r.workspace_host_path) LIKE ?
            OR lower(r.runtime_home_path) LIKE ?
            OR lower(t.code) LIKE ?
            OR lower(t.name) LIKE ?
            OR lower(u.username) LIKE ?
            OR lower(w.slug) LIKE ?
            OR lower(w.display_name) LIKE ?
            OR lower(w.path) LIKE ?
          )`);
          params.push(...Array(12).fill(normalized.q));
        }

        const whereSql = whereClauses.join('\n            AND ');
        const total = database.prepare(`
          SELECT COUNT(*) AS total
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE ${whereSql}
        `).get(...params).total;

        const rows = database.prepare(`
          SELECT
            r.*,
            t.code AS tenant_code,
            t.name AS tenant_name,
            u.username,
            w.slug AS workspace_slug,
            w.display_name AS workspace_display_name,
            w.path AS workspace_path
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE ${whereSql}
          ORDER BY r.updated_at DESC, r.id DESC
          LIMIT ? OFFSET ?
        `).all(...params, normalized.limit, normalized.offset);

        return {
          rows,
          total,
          limit: normalized.limit,
          offset: normalized.offset,
        };
      },

      listAllForMonitor: (filters = {}) => {
        const normalized = normalizeRuntimeMonitorFilters({
          ...filters,
          limit: filters.limit ?? 50,
          offset: filters.offset ?? 0,
        });
        const whereClauses = [
          "r.status != 'deleted'",
        ];
        const params = [];

        if (normalized.tenantId !== null) {
          whereClauses.push('r.tenant_id = ?');
          params.push(normalized.tenantId);
        }
        if (normalized.userId !== null) {
          whereClauses.push('r.user_id = ?');
          params.push(normalized.userId);
        }
        if (normalized.workspaceId !== null) {
          whereClauses.push('r.workspace_id = ?');
          params.push(normalized.workspaceId);
        }
        if (normalized.provider !== null) {
          whereClauses.push('r.provider = ?');
          params.push(normalized.provider);
        }
        if (normalized.status !== null) {
          whereClauses.push('r.status = ?');
          params.push(normalized.status);
        }
        if (normalized.q !== null) {
          whereClauses.push(`(
            lower(r.runtime_id) LIKE ?
            OR lower(COALESCE(r.provider_session_id, '')) LIKE ?
            OR lower(r.container_name) LIKE ?
            OR lower(r.image) LIKE ?
            OR lower(r.workspace_host_path) LIKE ?
            OR lower(r.runtime_home_path) LIKE ?
            OR lower(t.code) LIKE ?
            OR lower(t.name) LIKE ?
            OR lower(u.username) LIKE ?
            OR lower(w.slug) LIKE ?
            OR lower(w.display_name) LIKE ?
            OR lower(w.path) LIKE ?
          )`);
          params.push(...Array(12).fill(normalized.q));
        }

        const whereSql = whereClauses.join('\n            AND ');
        const rows = database.prepare(`
          SELECT
            r.*,
            t.code AS tenant_code,
            t.name AS tenant_name,
            u.username,
            w.slug AS workspace_slug,
            w.display_name AS workspace_display_name,
            w.path AS workspace_path
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE ${whereSql}
          ORDER BY r.updated_at DESC, r.id DESC
        `).all(...params);

        return {
          rows,
          total: rows.length,
        };
      },

      getMonitorRowByRuntimeId: (runtimeId) => {
        return database.prepare(`
          SELECT
            r.*,
            t.code AS tenant_code,
            t.name AS tenant_name,
            u.username,
            w.slug AS workspace_slug,
            w.display_name AS workspace_display_name,
            w.path AS workspace_path
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE r.runtime_id = ?
            AND r.status != 'deleted'
        `).get(requireNonEmptyString(runtimeId, 'runtimeId')) ?? null;
      },

      listExpiredIdleRuntimes: ({ olderThanMinutes, limit = 100 }) => {
        const normalizedOlderThanMinutes = requirePositiveInteger(
          Number(olderThanMinutes),
          'olderThanMinutes',
        );
        const normalizedLimit = normalizePositiveLimit(limit, 100, 200);

        return database.prepare(`
          SELECT
            r.*,
            t.code AS tenant_code,
            t.name AS tenant_name,
            u.username,
            w.slug AS workspace_slug,
            w.display_name AS workspace_display_name,
            w.path AS workspace_path
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE r.status = 'idle'
            AND r.last_used_at <= datetime('now', ?)
          ORDER BY r.last_used_at ASC, r.id ASC
          LIMIT ?
        `).all(`-${normalizedOlderThanMinutes} minutes`, normalizedLimit);
      },

      findExpiredIdleRuntimeById: ({ runtimeId, olderThanMinutes }) => {
        const normalizedOlderThanMinutes = requirePositiveInteger(
          Number(olderThanMinutes),
          'olderThanMinutes',
        );

        return database.prepare(`
          SELECT
            r.*,
            t.code AS tenant_code,
            t.name AS tenant_name,
            u.username,
            w.slug AS workspace_slug,
            w.display_name AS workspace_display_name,
            w.path AS workspace_path
          FROM agent_session_runtime r
          JOIN tenants t ON t.id = r.tenant_id
          JOIN users u ON u.id = r.user_id
          JOIN workspaces w ON w.id = r.workspace_id
          WHERE r.runtime_id = ?
            AND r.status = 'idle'
            AND r.last_used_at <= datetime('now', ?)
        `).get(
          requireNonEmptyString(runtimeId, 'runtimeId'),
          `-${normalizedOlderThanMinutes} minutes`,
        ) ?? null;
      },
    },

    sessionMessages: {
      upsertMessages: (input) => upsertSessionMessagesTransaction(input),

      bindProviderSession: ({ runtimeId, providerSessionId, fromProviderSessionId = null }) => {
        const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedFromProviderSessionId = optionalNonEmptyString(
          fromProviderSessionId,
          'fromProviderSessionId',
        );
        const sourceFilter = normalizedFromProviderSessionId === null
          ? 'provider_session_id IS NULL'
          : 'provider_session_id = ?';
        const params = normalizedFromProviderSessionId === null
          ? [normalizedProviderSessionId, normalizedRuntimeId]
          : [normalizedProviderSessionId, normalizedRuntimeId, normalizedFromProviderSessionId];

        const result = database.prepare(`
          UPDATE agent_session_messages
          SET
            provider_session_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE runtime_id = ?
            AND ${sourceFilter}
        `).run(...params);

        return result.changes;
      },

      listMessages: ({
        tenantId,
        workspaceId,
        userId,
        provider,
        providerSessionId,
        limit = null,
        offset = 0,
      }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedProvider = requireEnum(provider, PROVIDERS, 'provider');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const normalizedLimit = normalizeLimit(limit);
        const normalizedOffset = normalizeOffset(offset);

        const visibleRows = database.prepare(`
          SELECT *
          FROM agent_session_messages
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
          ORDER BY sequence ASC, id ASC
        `).all(
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
          normalizedProvider,
          normalizedProviderSessionId,
        ).map((row) => ({
          row,
          message: parseNormalizedMessageRow(row),
        })).filter(({ row, message }) => (
          !isHiddenSessionMessage(row.provider, message) &&
          !(row.provider === 'claude' && startsWithHiddenClaudeContent(row.content_text))
        ));

        const total = visibleRows.length;

        if (total === 0 || (normalizedLimit !== null && normalizedOffset >= total)) {
          return {
            messages: [],
            total,
            hasMore: false,
            offset: normalizedOffset,
            limit: normalizedLimit,
          };
        }

        let pageRows;
        let hasMore = false;
        if (normalizedLimit === null) {
          pageRows = visibleRows;
        } else {
          const startIndex = Math.max(0, total - normalizedOffset - normalizedLimit);
          hasMore = startIndex > 0;
          pageRows = visibleRows.slice(startIndex, startIndex + normalizedLimit);
        }

        return {
          messages: pageRows.map(({ message }) => message),
          total,
          hasMore,
          offset: normalizedOffset,
          limit: normalizedLimit,
        };
      },
    },

    joinRequests: {
      createJoinRequest: ({ tenantId, userId, message = null }) => {
        const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
        const normalizedUserId = requirePositiveInteger(userId, 'userId');
        const normalizedMessage = message == null ? null : requireNonEmptyString(message, 'message');
        const status = requireEnum('pending', JOIN_REQUEST_STATUSES, 'status');

        database.prepare(`
          INSERT INTO tenant_join_requests (tenant_id, user_id, message, status)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tenant_id, user_id)
          DO UPDATE SET
            message = excluded.message,
            status = excluded.status,
            updated_at = CURRENT_TIMESTAMP
        `).run(normalizedTenantId, normalizedUserId, normalizedMessage, status);

        return database.prepare(`
          SELECT *
          FROM tenant_join_requests
          WHERE tenant_id = ? AND user_id = ?
        `).get(normalizedTenantId, normalizedUserId);
      },
    },
  };
}

export const multitenancyDb = createMultitenancyDb(db);
