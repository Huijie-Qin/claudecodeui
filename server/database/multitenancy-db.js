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
const PERMISSIONS = new Set(['view', 'edit']);
const PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);

export function initializeMultitenancyTables(database = db) {
  database.exec(MULTITENANCY_SCHEMA_SQL);
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

function optionalNonEmptyString(value, name) {
  if (value == null || value === '') return null;
  return requireNonEmptyString(value, name);
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

function parseNormalizedMessageRow(row) {
  try {
    return JSON.parse(row.normalized_json);
  } catch (error) {
    return {
      id: row.message_id,
      sessionId: row.provider_session_id,
      timestamp: row.provider_timestamp,
      provider: row.provider,
      kind: row.kind,
      role: row.role || undefined,
      content: row.content_text || undefined,
    };
  }
}

function extractContentText(message) {
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  return null;
}

function normalizeMessageRole(role) {
  return role === 'user' || role === 'assistant' ? role : null;
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

  return {
    tenants: {
      createTenant: ({ code, name, status = 'active' }) => {
        const tenantCode = requireCode(code);
        const tenantName = requireNonEmptyString(name, 'name');
        const tenantStatus = requireEnum(status, TENANT_STATUSES, 'status');

        const result = database.prepare(`
          INSERT INTO tenants (code, name, status)
          VALUES (?, ?, ?)
        `).run(tenantCode, tenantName, tenantStatus);

        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(result.lastInsertRowid));
      },

      getTenantById: (tenantId) => {
        return database.prepare('SELECT * FROM tenants WHERE id = ?').get(requirePositiveInteger(tenantId, 'tenantId')) ?? null;
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
        const params = [
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(workspaceId, 'workspaceId'),
          requirePositiveInteger(userId, 'userId'),
        ];
        let providerFilter = '';

        if (provider != null) {
          providerFilter = 'AND provider = ?';
          params.push(requireEnum(provider, PROVIDERS, 'provider'));
        }

        return database.prepare(`
          SELECT *
          FROM session_index
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND user_id = ?
            AND status != 'deleted'
            ${providerFilter}
          ORDER BY updated_at DESC, id DESC
        `).all(...params);
      },

      findOwnedSession: ({ tenantId, userId, provider, providerSessionId }) => {
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
        `).get(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
        ) ?? null;
      },

      markDeleted: ({ tenantId, userId, provider, providerSessionId }) => {
        const result = database.prepare(`
          UPDATE session_index
          SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
        `).run(
          requirePositiveInteger(tenantId, 'tenantId'),
          requirePositiveInteger(userId, 'userId'),
          requireEnum(provider, PROVIDERS, 'provider'),
          requireNonEmptyString(providerSessionId, 'providerSessionId'),
        );

        return result.changes > 0;
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
    },

    sessionMessages: {
      upsertMessages: (input) => upsertSessionMessagesTransaction(input),

      bindProviderSession: ({ runtimeId, providerSessionId }) => {
        const normalizedRuntimeId = requireNonEmptyString(runtimeId, 'runtimeId');
        const normalizedProviderSessionId = requireNonEmptyString(providerSessionId, 'providerSessionId');
        const result = database.prepare(`
          UPDATE agent_session_messages
          SET
            provider_session_id = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE runtime_id = ?
            AND provider_session_id IS NULL
        `).run(normalizedProviderSessionId, normalizedRuntimeId);

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

        const total = database.prepare(`
          SELECT COUNT(*) AS total
          FROM agent_session_messages
          WHERE tenant_id = ?
            AND workspace_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
        `).get(
          normalizedTenantId,
          normalizedWorkspaceId,
          normalizedUserId,
          normalizedProvider,
          normalizedProviderSessionId,
        ).total;

        if (total === 0 || (normalizedLimit !== null && normalizedOffset >= total)) {
          return {
            messages: [],
            total,
            hasMore: false,
            offset: normalizedOffset,
            limit: normalizedLimit,
          };
        }

        let rows;
        let hasMore = false;
        if (normalizedLimit === null) {
          rows = database.prepare(`
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
          );
        } else {
          const startIndex = Math.max(0, total - normalizedOffset - normalizedLimit);
          hasMore = startIndex > 0;
          rows = database.prepare(`
            SELECT *
            FROM agent_session_messages
            WHERE tenant_id = ?
              AND workspace_id = ?
              AND user_id = ?
              AND provider = ?
              AND provider_session_id = ?
            ORDER BY sequence ASC, id ASC
            LIMIT ? OFFSET ?
          `).all(
            normalizedTenantId,
            normalizedWorkspaceId,
            normalizedUserId,
            normalizedProvider,
            normalizedProviderSessionId,
            normalizedLimit,
            startIndex,
          );
        }

        return {
          messages: rows.map(parseNormalizedMessageRow),
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
