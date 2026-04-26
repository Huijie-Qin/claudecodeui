import { db } from './db.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';

const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const TENANT_STATUSES = new Set(['active', 'disabled']);
const MEMBERSHIP_STATUSES = new Set(['active', 'disabled', 'pending']);
const WORKSPACE_STATUSES = new Set(['active', 'archived', 'deleted']);
const JOIN_REQUEST_STATUSES = new Set(['pending', 'approved', 'rejected']);
const SESSION_STATUSES = new Set(['active', 'completed', 'aborted', 'failed', 'deleted']);
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
          SELECT *
          FROM session_index
          WHERE tenant_id = ?
            AND user_id = ?
            AND provider = ?
            AND provider_session_id = ?
            AND status != 'deleted'
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
