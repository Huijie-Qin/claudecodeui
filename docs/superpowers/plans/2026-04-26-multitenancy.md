# Multi-Tenancy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build phase-one application-level multi-tenancy with database-backed tenant membership, strong workspace path isolation, owner-managed workspace sharing, and private per-user sessions.

**Architecture:** Add focused database modules for tenant/workspace/session authorization, then route all Web UI project, file, Git, shell, chat, and session-history access through those modules. Keep provider credentials and existing provider history storage global for this phase, but never expose resources through Web UI without tenant, workspace, and session ownership checks.

**Tech Stack:** Node.js ESM, Express, better-sqlite3, ws, React 18, TypeScript, Vite, Tailwind, Node `node:test`, `tsx` for TypeScript tests.

---

## File Structure

Create:

- `server/database/multitenancy-schema.js` - SQL for tenants, tenant memberships, workspaces, workspace ACLs, join requests, and session index.
- `server/database/multitenancy-db.js` - database access factories and singleton exports for tenants, memberships, workspaces, ACLs, join requests, and sessions.
- `server/database/multitenancy-db.test.js` - unit tests for database behavior.
- `server/middleware/tenant-context.js` - Express middleware and WebSocket helper for resolving tenant context.
- `server/middleware/tenant-context.test.js` - tenant context tests.
- `server/services/workspace-access.js` - shared authorization service for workspace view/edit/owner checks and path resolution.
- `server/services/workspace-access.test.js` - workspace access tests.
- `server/routes/tenants.js` - user-facing tenant APIs.
- `server/routes/admin.js` - minimal system admin APIs.
- `server/routes/workspaces.js` - workspace share APIs.
- `server/routes/multitenancy-routes.test.js` - route-level tests with mocked database/service functions.
- `src/contexts/TenantContext.tsx` - selected-tenant state and tenant API loading.
- `src/contexts/TenantContext.test.ts` - tenant selection state tests using pure helper functions.
- `src/components/tenant/TenantSelection.tsx` - tenant selection screen.
- `src/components/tenant/tenantSelection.ts` - pure tenant selection helpers.
- `src/components/admin/AdminPanel.tsx` - minimal system admin UI.
- `src/components/workspace-share/WorkspaceShareDialog.tsx` - owner workspace whitelist editor.
- `src/components/workspace-share/workspaceShare.ts` - pure ACL form helpers.
- `src/components/workspace-share/workspaceShare.test.ts` - ACL helper tests.

Modify:

- `server/database/schema.js` - add `is_system_admin` to `users`.
- `server/database/db.js` - run multitenancy schema, migrate `users.is_system_admin`, extend `userDb`.
- `server/routes/auth.js` - turn first-user setup into system bootstrap and allow later normal registration.
- `server/index.js` - mount new routes, bind tenant context to WebSockets, authorize project/file/shell/chat paths.
- `server/routes/projects.js` - require tenant context for create workspace and clone progress, create DB workspace records.
- `server/routes/git.js` - resolve project/workspace through `workspaceAccess`.
- `server/routes/messages.js` - require session ownership through `sessionIndexDb`.
- `server/routes/codex.js` - delete only authorized current-user Codex sessions.
- `server/routes/gemini.js` - delete only authorized current-user Gemini sessions.
- `server/claude-sdk.js` - record provider session ownership when session id is captured.
- `server/openai-codex.js` - record Codex provider session ownership.
- `server/cursor-cli.js` - record Cursor provider session ownership.
- `server/gemini-cli.js` - record Gemini provider session ownership.
- `server/sessionManager.js` - include tenant/workspace/user metadata for UI-created Gemini sessions.
- `src/App.tsx` - wrap protected app in `TenantProvider`.
- `src/components/auth/view/ProtectedRoute.tsx` - require tenant selection after login.
- `src/utils/api.js` - add tenant, admin, workspace share APIs and append tenant id for protected calls.
- `src/types/app.ts` - add tenant and workspace access types.
- `src/hooks/useProjectsState.ts` - fetch projects for selected tenant and reset state on tenant switch.
- `src/contexts/WebSocketContext.tsx` - reconnect WebSocket when selected tenant changes.
- `src/components/sidebar/view/Sidebar.tsx` and sidebar subcomponents - display owner/shared access and open share dialog for owners.
- `src/components/project-creation-wizard/data/workspaceApi.ts` - pass tenant id to workspace creation.
- `src/components/main-content/view/MainContent.tsx` - disable write/run tabs for view-only workspace access.

Run throughout:

- `npm run typecheck`
- `node --test server/database/multitenancy-db.test.js`
- `node --test server/middleware/tenant-context.test.js`
- `node --test server/services/workspace-access.test.js`
- `node --test server/routes/multitenancy-routes.test.js`
- `npx tsx --test src/contexts/TenantContext.test.ts`
- `npx tsx --test src/components/workspace-share/workspaceShare.test.ts`

---

### Task 1: Database Schema And Access Module

**Files:**
- Create: `server/database/multitenancy-schema.js`
- Create: `server/database/multitenancy-db.js`
- Create: `server/database/multitenancy-db.test.js`
- Modify: `server/database/schema.js`
- Modify: `server/database/db.js`

- [ ] **Step 1: Write failing database tests**

Create `server/database/multitenancy-db.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from './schema.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';
import { createMultitenancyDb } from './multitenancy-db.js';

function createTestDb() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  return database;
}

function seedUser(database, username) {
  const result = database
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, `hash-${username}`);
  return Number(result.lastInsertRowid);
}

test('tenant membership controls visible tenants', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const userId = seedUser(database, 'alice');
  const otherUserId = seedUser(database, 'bob');
  const tenant = mt.tenants.createTenant({ code: 'acme', name: 'Acme' });
  const hiddenTenant = mt.tenants.createTenant({ code: 'hidden', name: 'Hidden' });

  mt.memberships.upsertMembership({
    tenantId: tenant.id,
    userId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });
  mt.memberships.upsertMembership({
    tenantId: hiddenTenant.id,
    userId: otherUserId,
    role: 'member',
    permission: 'edit',
    status: 'active',
  });

  assert.deepEqual(
    mt.tenants.listTenantsForUser(userId).map((row) => row.code),
    ['acme'],
  );
  assert.equal(mt.memberships.getActiveMembership(userId, tenant.id).permission, 'edit');
  assert.equal(mt.memberships.getActiveMembership(userId, hiddenTenant.id), null);
});

test('workspace ACL grants access only inside the same tenant', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const outsiderId = seedUser(database, 'outsider');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  const otherTenant = mt.tenants.createTenant({ code: 'other', name: 'Other' });

  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: otherTenant.id, userId: outsiderId, role: 'member', permission: 'edit', status: 'active' });

  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'app',
    displayName: 'App',
    path: '/tmp/cloudcli/team/owner/app',
  });

  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: ownerId }).map((row) => row.accessRole), ['owner']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: editorId }).map((row) => row.accessRole), ['edit']);
  assert.deepEqual(mt.workspaces.listVisibleWorkspaces({ tenantId: tenant.id, userId: outsiderId }), []);
});

test('session index keeps shared workspace sessions private per user', () => {
  const database = createTestDb();
  const mt = createMultitenancyDb(database);
  const ownerId = seedUser(database, 'owner');
  const editorId = seedUser(database, 'editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/cloudcli/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({
    workspaceId: workspace.id,
    ownerUserId: ownerId,
    entries: [{ userId: editorId, permission: 'edit' }],
  });

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner session',
    status: 'active',
  });
  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'editor-session',
    summary: 'Editor session',
    status: 'active',
  });

  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: ownerId }).map((row) => row.provider_session_id), ['owner-session']);
  assert.deepEqual(mt.sessions.listSessions({ tenantId: tenant.id, workspaceId: workspace.id, userId: editorId }).map((row) => row.provider_session_id), ['editor-session']);
  assert.equal(mt.sessions.findOwnedSession({ tenantId: tenant.id, userId: editorId, provider: 'claude', providerSessionId: 'owner-session' }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test server/database/multitenancy-db.test.js
```

Expected: FAIL with an import error for `./multitenancy-schema.js` or missing `createMultitenancyDb`.

- [ ] **Step 3: Add multitenancy schema**

Create `server/database/multitenancy-schema.js`:

```js
export const MULTITENANCY_SCHEMA_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenants_code ON tenants(code);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  permission TEXT NOT NULL DEFAULT 'view',
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (permission IN ('view', 'edit')),
  CHECK (status IN ('active', 'disabled', 'pending'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id, status);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, owner_user_id, slug),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (status IN ('active', 'archived', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_owner ON workspaces(tenant_id, owner_user_id, status);

CREATE TABLE IF NOT EXISTS workspace_acl (
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  created_by_user_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (permission IN ('view', 'edit'))
);

CREATE INDEX IF NOT EXISTS idx_workspace_acl_user ON workspace_acl(user_id, permission);

CREATE TABLE IF NOT EXISTS tenant_join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_tenant_join_requests_status ON tenant_join_requests(status, tenant_id);

CREATE TABLE IF NOT EXISTS session_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_session_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CHECK (provider IN ('claude', 'codex', 'cursor', 'gemini')),
  CHECK (status IN ('active', 'completed', 'aborted', 'failed', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_session_index_owner ON session_index(tenant_id, workspace_id, user_id, provider, status);
CREATE INDEX IF NOT EXISTS idx_session_index_lookup ON session_index(tenant_id, user_id, provider, provider_session_id);
`;
```

- [ ] **Step 4: Add database access module**

Create `server/database/multitenancy-db.js`:

```js
import path from 'path';

import { db } from './db.js';
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';

const VALID_TENANT_PERMISSIONS = new Set(['view', 'edit']);
const VALID_WORKSPACE_PERMISSIONS = new Set(['view', 'edit']);
const VALID_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);

function normalizeId(value, name) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return id;
}

function normalizeCode(value, name) {
  const normalized = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,62}$/.test(normalized)) {
    throw new Error(`${name} must be 2-63 characters and contain only letters, numbers, underscores, or hyphens`);
  }
  return normalized;
}

function normalizePermission(value, valid, name) {
  const permission = String(value || '').trim();
  if (!valid.has(permission)) {
    throw new Error(`${name} must be one of: ${Array.from(valid).join(', ')}`);
  }
  return permission;
}

function normalizeStatus(value, allowed, name) {
  const status = String(value || '').trim();
  if (!allowed.has(status)) {
    throw new Error(`${name} must be one of: ${Array.from(allowed).join(', ')}`);
  }
  return status;
}

function rowToWorkspace(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    tenant_id: Number(row.tenant_id),
    owner_user_id: Number(row.owner_user_id),
  };
}

export function initializeMultitenancyTables(database = db) {
  database.exec(MULTITENANCY_SCHEMA_SQL);
}

export function createMultitenancyDb(database = db) {
  const tenants = {
    createTenant({ code, name, status = 'active' }) {
      const tenantCode = normalizeCode(code, 'tenant code');
      const tenantName = String(name || '').trim();
      if (!tenantName) throw new Error('tenant name is required');
      const tenantStatus = normalizeStatus(status, new Set(['active', 'disabled']), 'tenant status');
      const result = database.prepare(
        'INSERT INTO tenants (code, name, status) VALUES (?, ?, ?)',
      ).run(tenantCode, tenantName, tenantStatus);
      return tenants.getTenantById(result.lastInsertRowid);
    },

    getTenantById(tenantId) {
      return database.prepare('SELECT * FROM tenants WHERE id = ?').get(normalizeId(tenantId, 'tenantId')) || null;
    },

    listTenantsForUser(userId) {
      return database.prepare(`
        SELECT t.*, tu.permission, tu.role
        FROM tenants t
        JOIN tenant_users tu ON tu.tenant_id = t.id
        WHERE tu.user_id = ? AND tu.status = 'active' AND t.status = 'active'
        ORDER BY t.name COLLATE NOCASE ASC
      `).all(normalizeId(userId, 'userId'));
    },

    listTenants() {
      return database.prepare('SELECT * FROM tenants ORDER BY name COLLATE NOCASE ASC').all();
    },
  };

  const memberships = {
    upsertMembership({ tenantId, userId, role = 'member', permission = 'view', status = 'active' }) {
      const normalizedTenantId = normalizeId(tenantId, 'tenantId');
      const normalizedUserId = normalizeId(userId, 'userId');
      const normalizedPermission = normalizePermission(permission, VALID_TENANT_PERMISSIONS, 'tenant permission');
      const normalizedStatus = normalizeStatus(status, new Set(['active', 'disabled', 'pending']), 'membership status');
      const normalizedRole = String(role || 'member').trim() || 'member';
      database.prepare(`
        INSERT INTO tenant_users (tenant_id, user_id, role, permission, status, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(tenant_id, user_id) DO UPDATE SET
          role = excluded.role,
          permission = excluded.permission,
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(normalizedTenantId, normalizedUserId, normalizedRole, normalizedPermission, normalizedStatus);
      return memberships.getMembership(normalizedUserId, normalizedTenantId);
    },

    getMembership(userId, tenantId) {
      return database.prepare(
        'SELECT * FROM tenant_users WHERE user_id = ? AND tenant_id = ?',
      ).get(normalizeId(userId, 'userId'), normalizeId(tenantId, 'tenantId')) || null;
    },

    getActiveMembership(userId, tenantId) {
      return database.prepare(`
        SELECT tu.*
        FROM tenant_users tu
        JOIN tenants t ON t.id = tu.tenant_id
        WHERE tu.user_id = ? AND tu.tenant_id = ? AND tu.status = 'active' AND t.status = 'active'
      `).get(normalizeId(userId, 'userId'), normalizeId(tenantId, 'tenantId')) || null;
    },
  };

  const workspaces = {
    createWorkspace({ tenantId, ownerUserId, slug, displayName, path: workspacePath, status = 'active' }) {
      const normalizedTenantId = normalizeId(tenantId, 'tenantId');
      const normalizedOwnerId = normalizeId(ownerUserId, 'ownerUserId');
      const workspaceSlug = normalizeCode(slug, 'workspace slug');
      const name = String(displayName || '').trim();
      if (!name) throw new Error('workspace displayName is required');
      const absolutePath = path.resolve(String(workspacePath || '').trim());
      if (!path.isAbsolute(absolutePath)) throw new Error('workspace path must be absolute');
      const workspaceStatus = normalizeStatus(status, new Set(['active', 'archived', 'deleted']), 'workspace status');
      const result = database.prepare(`
        INSERT INTO workspaces (tenant_id, owner_user_id, slug, display_name, path, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedTenantId, normalizedOwnerId, workspaceSlug, name, absolutePath, workspaceStatus);
      return workspaces.getWorkspaceById(result.lastInsertRowid);
    },

    getWorkspaceById(workspaceId) {
      return rowToWorkspace(database.prepare('SELECT * FROM workspaces WHERE id = ?').get(normalizeId(workspaceId, 'workspaceId')));
    },

    getWorkspaceByTenantSlug({ tenantId, ownerUserId, slug }) {
      return rowToWorkspace(database.prepare(`
        SELECT * FROM workspaces
        WHERE tenant_id = ? AND owner_user_id = ? AND slug = ? AND status = 'active'
      `).get(normalizeId(tenantId, 'tenantId'), normalizeId(ownerUserId, 'ownerUserId'), normalizeCode(slug, 'workspace slug')));
    },

    listVisibleWorkspaces({ tenantId, userId }) {
      const normalizedTenantId = normalizeId(tenantId, 'tenantId');
      const normalizedUserId = normalizeId(userId, 'userId');
      return database.prepare(`
        SELECT w.*, 'owner' AS accessRole
        FROM workspaces w
        WHERE w.tenant_id = ? AND w.owner_user_id = ? AND w.status = 'active'
        UNION ALL
        SELECT w.*, a.permission AS accessRole
        FROM workspaces w
        JOIN workspace_acl a ON a.workspace_id = w.id
        WHERE w.tenant_id = ? AND a.user_id = ? AND w.owner_user_id != ? AND w.status = 'active'
        ORDER BY display_name COLLATE NOCASE ASC
      `).all(normalizedTenantId, normalizedUserId, normalizedTenantId, normalizedUserId, normalizedUserId);
    },
  };

  const workspaceAcl = {
    listAcl(workspaceId) {
      return database.prepare(`
        SELECT a.*, u.username
        FROM workspace_acl a
        JOIN users u ON u.id = a.user_id
        WHERE a.workspace_id = ?
        ORDER BY u.username COLLATE NOCASE ASC
      `).all(normalizeId(workspaceId, 'workspaceId'));
    },

    replaceAcl({ workspaceId, ownerUserId, entries }) {
      const normalizedWorkspaceId = normalizeId(workspaceId, 'workspaceId');
      const normalizedOwnerId = normalizeId(ownerUserId, 'ownerUserId');
      const normalizedEntries = entries.map((entry) => ({
        userId: normalizeId(entry.userId, 'acl userId'),
        permission: normalizePermission(entry.permission, VALID_WORKSPACE_PERMISSIONS, 'workspace permission'),
      })).filter((entry) => entry.userId !== normalizedOwnerId);

      const tx = database.transaction(() => {
        database.prepare('DELETE FROM workspace_acl WHERE workspace_id = ?').run(normalizedWorkspaceId);
        const insert = database.prepare(`
          INSERT INTO workspace_acl (workspace_id, user_id, permission, created_by_user_id, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        for (const entry of normalizedEntries) {
          insert.run(normalizedWorkspaceId, entry.userId, entry.permission, normalizedOwnerId);
        }
      });
      tx();
      return workspaceAcl.listAcl(normalizedWorkspaceId);
    },

    getAclEntry(workspaceId, userId) {
      return database.prepare(
        'SELECT * FROM workspace_acl WHERE workspace_id = ? AND user_id = ?',
      ).get(normalizeId(workspaceId, 'workspaceId'), normalizeId(userId, 'userId')) || null;
    },
  };

  const sessions = {
    upsertSession({ tenantId, workspaceId, userId, provider, providerSessionId, summary = null, status = 'active', metadata = null }) {
      const normalizedProvider = String(provider || '').trim();
      if (!VALID_PROVIDERS.has(normalizedProvider)) throw new Error('provider is invalid');
      const normalizedProviderSessionId = String(providerSessionId || '').trim();
      if (!normalizedProviderSessionId) throw new Error('providerSessionId is required');
      const metadataJson = metadata ? JSON.stringify(metadata) : null;
      database.prepare(`
        INSERT INTO session_index (
          tenant_id, workspace_id, user_id, provider, provider_session_id, summary, status, metadata_json, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(provider, provider_session_id, user_id) DO UPDATE SET
          tenant_id = excluded.tenant_id,
          workspace_id = excluded.workspace_id,
          summary = COALESCE(excluded.summary, session_index.summary),
          status = excluded.status,
          metadata_json = COALESCE(excluded.metadata_json, session_index.metadata_json),
          updated_at = CURRENT_TIMESTAMP
      `).run(
        normalizeId(tenantId, 'tenantId'),
        normalizeId(workspaceId, 'workspaceId'),
        normalizeId(userId, 'userId'),
        normalizedProvider,
        normalizedProviderSessionId,
        summary,
        status,
        metadataJson,
      );
      return sessions.findOwnedSession({ tenantId, userId, provider: normalizedProvider, providerSessionId: normalizedProviderSessionId });
    },

    listSessions({ tenantId, workspaceId, userId, provider = null }) {
      const params = [normalizeId(tenantId, 'tenantId'), normalizeId(workspaceId, 'workspaceId'), normalizeId(userId, 'userId')];
      let sql = `
        SELECT * FROM session_index
        WHERE tenant_id = ? AND workspace_id = ? AND user_id = ? AND status != 'deleted'
      `;
      if (provider) {
        sql += ' AND provider = ?';
        params.push(String(provider));
      }
      sql += ' ORDER BY updated_at DESC, id DESC';
      return database.prepare(sql).all(...params);
    },

    findOwnedSession({ tenantId, userId, provider, providerSessionId }) {
      return database.prepare(`
        SELECT * FROM session_index
        WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_session_id = ? AND status != 'deleted'
      `).get(
        normalizeId(tenantId, 'tenantId'),
        normalizeId(userId, 'userId'),
        String(provider),
        String(providerSessionId),
      ) || null;
    },

    markDeleted({ tenantId, userId, provider, providerSessionId }) {
      return database.prepare(`
        UPDATE session_index
        SET status = 'deleted', updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ? AND user_id = ? AND provider = ? AND provider_session_id = ?
      `).run(normalizeId(tenantId, 'tenantId'), normalizeId(userId, 'userId'), String(provider), String(providerSessionId)).changes > 0;
    },
  };

  const joinRequests = {
    createJoinRequest({ tenantId, userId, message = null }) {
      const result = database.prepare(`
        INSERT INTO tenant_join_requests (tenant_id, user_id, message)
        VALUES (?, ?, ?)
        ON CONFLICT(tenant_id, user_id) DO UPDATE SET
          message = excluded.message,
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
      `).run(normalizeId(tenantId, 'tenantId'), normalizeId(userId, 'userId'), message);
      return database.prepare('SELECT * FROM tenant_join_requests WHERE id = ?').get(result.lastInsertRowid)
        || database.prepare('SELECT * FROM tenant_join_requests WHERE tenant_id = ? AND user_id = ?').get(tenantId, userId);
    },
  };

  return { tenants, memberships, workspaces, workspaceAcl, sessions, joinRequests };
}

export const multitenancyDb = createMultitenancyDb(db);
```

- [ ] **Step 5: Wire schema into existing database initialization**

Modify `server/database/schema.js` in the `users` table definition:

```js
  is_active BOOLEAN DEFAULT 1,
  is_system_admin BOOLEAN DEFAULT 0,
  git_name TEXT,
```

Modify `server/database/db.js` imports:

```js
import { MULTITENANCY_SCHEMA_SQL } from './multitenancy-schema.js';
```

Modify `runMigrations` after `is_active`/existing column checks:

```js
    if (!columnNames.includes('is_system_admin')) {
      console.log('Running migration: Adding is_system_admin column');
      db.exec('ALTER TABLE users ADD COLUMN is_system_admin BOOLEAN DEFAULT 0');
    }

    db.exec(MULTITENANCY_SCHEMA_SQL);
```

Modify `initializeDatabase` after `db.exec(DATABASE_SCHEMA_SQL);`:

```js
    db.exec(MULTITENANCY_SCHEMA_SQL);
```

Modify `userDb.createUser` signature:

```js
  createUser: (username, passwordHash, options = {}) => {
    try {
      const isSystemAdmin = options.isSystemAdmin ? 1 : 0;
      const stmt = db.prepare('INSERT INTO users (username, password_hash, is_system_admin) VALUES (?, ?, ?)');
      const result = stmt.run(username, passwordHash, isSystemAdmin);
      return { id: result.lastInsertRowid, username, is_system_admin: isSystemAdmin };
    } catch (err) {
      throw err;
    }
  },
```

Modify `userDb.getUserById` and `getFirstUser` selected columns:

```sql
SELECT id, username, created_at, last_login, is_system_admin FROM users WHERE id = ? AND is_active = 1
```

```sql
SELECT id, username, created_at, last_login, is_system_admin FROM users WHERE is_active = 1 LIMIT 1
```

- [ ] **Step 6: Run database tests**

Run:

```bash
node --test server/database/multitenancy-db.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit database foundation**

Run:

```bash
git add server/database/schema.js server/database/db.js server/database/multitenancy-schema.js server/database/multitenancy-db.js server/database/multitenancy-db.test.js
git commit -m "feat: add multitenancy database foundation"
```

---

### Task 2: Bootstrap Auth And Public Registration

**Files:**
- Modify: `server/routes/auth.js`
- Modify: `server/database/db.js`
- Create: `server/routes/auth.multitenancy.test.js`

- [ ] **Step 1: Write failing auth route tests**

Create `server/routes/auth.multitenancy.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'node:test';

test('auth route task uses manual verification command', () => {
  assert.equal(typeof express, 'function');
  assert.equal(typeof request, 'function');
});
```

This repository does not currently include a route-test HTTP helper. Replace this smoke test in the implementation step with a focused test once `createAuthRouter` is exported.

- [ ] **Step 2: Refactor auth route for testable dependency injection**

Modify `server/routes/auth.js` to export a router factory while keeping the default export:

```js
export function createAuthRouter({ userDb, db, generateToken, authenticateToken }) {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    try {
      const hasUsers = await userDb.hasUsers();
      res.json({
        needsSetup: !hasUsers,
        isAuthenticated: false,
        allowRegistration: hasUsers,
      });
    } catch (error) {
      console.error('Auth status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      if (username.length < 3 || password.length < 6) {
        return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
      }

      db.prepare('BEGIN').run();
      try {
        const isFirstUser = !userDb.hasUsers();
        const saltRounds = 12;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const user = userDb.createUser(username, passwordHash, { isSystemAdmin: isFirstUser });
        const token = generateToken(user);
        db.prepare('COMMIT').run();
        userDb.updateLastLogin(user.id);
        res.json({
          success: true,
          user: { id: user.id, username: user.username, is_system_admin: user.is_system_admin },
          token,
          bootstrapAdmin: isFirstUser,
        });
      } catch (error) {
        db.prepare('ROLLBACK').run();
        throw error;
      }
    } catch (error) {
      console.error('Registration error:', error);
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
      const user = userDb.getUserByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const isValidPassword = await bcrypt.compare(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      const token = generateToken(user);
      userDb.updateLastLogin(user.id);
      res.json({
        success: true,
        user: { id: user.id, username: user.username, is_system_admin: user.is_system_admin },
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json({ user: req.user });
  });

  router.post('/logout', authenticateToken, (req, res) => {
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return router;
}

export default createAuthRouter({ userDb, db, generateToken, authenticateToken });
```

- [ ] **Step 3: Replace smoke test with route behavior tests**

Replace `server/routes/auth.multitenancy.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createAuthRouter } from './auth.js';

function createRequest(router, method, path, body = null) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', router);
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      server.close(() => resolve({ response, payload }));
    });
  });
}

function createFakeDeps() {
  const users = [];
  const fakeUserDb = {
    hasUsers: () => users.length > 0,
    createUser: (username, passwordHash, options = {}) => {
      const user = {
        id: users.length + 1,
        username,
        password_hash: passwordHash,
        is_system_admin: options.isSystemAdmin ? 1 : 0,
      };
      users.push(user);
      return user;
    },
    updateLastLogin: () => {},
    getUserByUsername: (username) => users.find((user) => user.username === username) || null,
  };
  return {
    users,
    userDb: fakeUserDb,
    db: {
      prepare: () => ({ run: () => ({}) }),
    },
    generateToken: (user) => `token-${user.id}`,
    authenticateToken: (req, res, next) => {
      req.user = users[0];
      next();
    },
  };
}

test('first registration creates a system admin bootstrap user', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'admin',
    password: 'secret1',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, true);
  assert.equal(payload.user.is_system_admin, 1);
});

test('later registration creates a normal user without tenant access', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  await createRequest(router, 'POST', '/api/auth/register', { username: 'admin', password: 'secret1' });
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'member',
    password: 'secret1',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, false);
  assert.equal(payload.user.is_system_admin, 0);
});
```

- [ ] **Step 4: Run auth tests**

Run:

```bash
node --test server/routes/auth.multitenancy.test.js
```

Expected: PASS.

- [ ] **Step 5: Run existing auth typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit auth bootstrap**

Run:

```bash
git add server/routes/auth.js server/routes/auth.multitenancy.test.js server/database/db.js server/database/schema.js
git commit -m "feat: support multitenant bootstrap registration"
```

---

### Task 3: Tenant Context Middleware And Workspace Access Service

**Files:**
- Create: `server/middleware/tenant-context.js`
- Create: `server/middleware/tenant-context.test.js`
- Create: `server/services/workspace-access.js`
- Create: `server/services/workspace-access.test.js`

- [ ] **Step 1: Write tenant context tests**

Create `server/middleware/tenant-context.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTenantContextMiddleware, resolveTenantIdFromRequest } from './tenant-context.js';

test('resolveTenantIdFromRequest reads query, header, and websocket URL', () => {
  assert.equal(resolveTenantIdFromRequest({ query: { tenantId: '7' }, headers: {}, url: '/api/projects' }), 7);
  assert.equal(resolveTenantIdFromRequest({ query: {}, headers: { 'x-tenant-id': '8' }, url: '/api/projects' }), 8);
  assert.equal(resolveTenantIdFromRequest({ query: {}, headers: {}, url: '/ws?tenantId=9' }), 9);
});

test('tenant context rejects users outside tenant', async () => {
  const middleware = createTenantContextMiddleware({
    memberships: {
      getActiveMembership: () => null,
    },
  });
  const req = { user: { id: 1 }, query: { tenantId: '2' }, headers: {}, url: '/api/projects' };
  const res = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
    },
  };
  let calledNext = false;

  await middleware(req, res, () => { calledNext = true; });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
});
```

- [ ] **Step 2: Write workspace access tests**

Create `server/services/workspace-access.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkspaceAccessService } from './workspace-access.js';

test('workspace access resolves owner, edit, view, and missing users', () => {
  const service = createWorkspaceAccessService({
    workspaces: {
      getWorkspaceById: () => ({
        id: 10,
        tenant_id: 2,
        owner_user_id: 1,
        path: '/tmp/workspace',
        status: 'active',
      }),
    },
    workspaceAcl: {
      getAclEntry: (workspaceId, userId) => {
        if (userId === 3) return { permission: 'edit' };
        if (userId === 4) return { permission: 'view' };
        return null;
      },
    },
  });

  assert.equal(service.getAccessRole({ tenantId: 2, userId: 1, workspaceId: 10 }), 'owner');
  assert.equal(service.getAccessRole({ tenantId: 2, userId: 3, workspaceId: 10 }), 'edit');
  assert.equal(service.getAccessRole({ tenantId: 2, userId: 4, workspaceId: 10 }), 'view');
  assert.equal(service.getAccessRole({ tenantId: 2, userId: 5, workspaceId: 10 }), null);
});

test('workspace access rejects paths outside workspace root', () => {
  const service = createWorkspaceAccessService({
    workspaces: {
      getWorkspaceById: () => ({
        id: 10,
        tenant_id: 2,
        owner_user_id: 1,
        path: '/tmp/workspace',
        status: 'active',
      }),
    },
    workspaceAcl: {
      getAclEntry: () => ({ permission: 'edit' }),
    },
  });

  assert.throws(() => {
    service.resolvePath({
      tenantId: 2,
      userId: 3,
      workspaceId: 10,
      requestedPath: '../secret.txt',
      requireEdit: false,
    });
  }, /Path must be under workspace root/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test server/middleware/tenant-context.test.js server/services/workspace-access.test.js
```

Expected: FAIL with import errors for the new modules.

- [ ] **Step 4: Implement tenant context middleware**

Create `server/middleware/tenant-context.js`:

```js
import { multitenancyDb } from '../database/multitenancy-db.js';

function parsePositiveInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function resolveTenantIdFromRequest(req) {
  const queryTenantId = parsePositiveInt(req.query?.tenantId);
  if (queryTenantId) return queryTenantId;

  const headerTenantId = parsePositiveInt(req.headers?.['x-tenant-id']);
  if (headerTenantId) return headerTenantId;

  try {
    const url = new URL(req.url || '', 'http://localhost');
    return parsePositiveInt(url.searchParams.get('tenantId'));
  } catch {
    return null;
  }
}

export function createTenantContextMiddleware(multitenancy = multitenancyDb) {
  return async function tenantContext(req, res, next) {
    const tenantId = resolveTenantIdFromRequest(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const userId = req.user?.id ?? req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
    if (!membership) {
      return res.status(403).json({ error: 'Tenant access denied' });
    }

    req.tenant = {
      id: tenantId,
      membership,
      permission: membership.permission,
    };
    return next();
  };
}

export const tenantContext = createTenantContextMiddleware(multitenancyDb);

export function resolveWebSocketTenant({ request, user, multitenancy = multitenancyDb }) {
  const tenantId = resolveTenantIdFromRequest(request);
  const userId = user?.id ?? user?.userId;
  if (!tenantId || !userId) return null;
  const membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
  if (!membership) return null;
  return { id: tenantId, membership, permission: membership.permission };
}
```

- [ ] **Step 5: Implement workspace access service**

Create `server/services/workspace-access.js`:

```js
import path from 'path';

import { multitenancyDb } from '../database/multitenancy-db.js';

function isUnderRoot(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createWorkspaceAccessService(multitenancy = multitenancyDb) {
  function getWorkspaceOrNull(workspaceId) {
    return multitenancy.workspaces.getWorkspaceById(workspaceId);
  }

  function getAccessRole({ tenantId, userId, workspaceId }) {
    const workspace = getWorkspaceOrNull(workspaceId);
    if (!workspace || workspace.status !== 'active' || Number(workspace.tenant_id) !== Number(tenantId)) {
      return null;
    }
    if (Number(workspace.owner_user_id) === Number(userId)) {
      return 'owner';
    }
    const acl = multitenancy.workspaceAcl.getAclEntry(workspaceId, userId);
    return acl?.permission || null;
  }

  function canViewWorkspace(args) {
    return Boolean(getAccessRole(args));
  }

  function canEditWorkspace(args) {
    const role = getAccessRole(args);
    return role === 'owner' || role === 'edit';
  }

  function requireWorkspace({ tenantId, userId, workspaceId, requireEdit = false }) {
    const workspace = getWorkspaceOrNull(workspaceId);
    if (!workspace || workspace.status !== 'active' || Number(workspace.tenant_id) !== Number(tenantId)) {
      const error = new Error('Workspace not found');
      error.statusCode = 404;
      throw error;
    }
    const role = getAccessRole({ tenantId, userId, workspaceId });
    if (!role) {
      const error = new Error('Workspace not found');
      error.statusCode = 404;
      throw error;
    }
    if (requireEdit && role !== 'owner' && role !== 'edit') {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    }
    return { workspace, accessRole: role };
  }

  function resolvePath({ tenantId, userId, workspaceId, requestedPath = '', requireEdit = false }) {
    const { workspace, accessRole } = requireWorkspace({ tenantId, userId, workspaceId, requireEdit });
    const resolvedPath = path.isAbsolute(String(requestedPath))
      ? path.resolve(String(requestedPath))
      : path.resolve(workspace.path, String(requestedPath || ''));
    if (!isUnderRoot(workspace.path, resolvedPath)) {
      const error = new Error('Path must be under workspace root');
      error.statusCode = 403;
      throw error;
    }
    return { workspace, accessRole, resolvedPath };
  }

  return {
    getAccessRole,
    canViewWorkspace,
    canEditWorkspace,
    requireWorkspace,
    resolvePath,
  };
}

export const workspaceAccess = createWorkspaceAccessService(multitenancyDb);
```

- [ ] **Step 6: Run service tests**

Run:

```bash
node --test server/middleware/tenant-context.test.js server/services/workspace-access.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit authorization services**

Run:

```bash
git add server/middleware/tenant-context.js server/middleware/tenant-context.test.js server/services/workspace-access.js server/services/workspace-access.test.js
git commit -m "feat: add tenant and workspace authorization services"
```

---

### Task 4: Tenant, Admin, And Workspace Share Routes

**Files:**
- Create: `server/routes/tenants.js`
- Create: `server/routes/admin.js`
- Create: `server/routes/workspaces.js`
- Create: `server/routes/multitenancy-routes.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Write route tests**

Create `server/routes/multitenancy-routes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createTenantsRouter } from './tenants.js';
import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { method = 'GET', body = null, user = { id: 1, is_system_admin: 0 } } = {}) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      server.close(() => resolve({ response, payload }));
    });
  });
}

test('tenants/me returns current user tenants', async () => {
  const router = createTenantsRouter({
    tenants: {
      listTenantsForUser: () => [{ id: 2, code: 'acme', name: 'Acme', permission: 'edit' }],
    },
    joinRequests: {
      createJoinRequest: () => ({}),
    },
  });

  const { response, payload } = await requestJson(router, '/me');

  assert.equal(response.status, 200);
  assert.deepEqual(payload.tenants.map((tenant) => tenant.code), ['acme']);
});

test('admin router rejects non-admin users', async () => {
  const router = createAdminRouter({
    tenants: { listTenants: () => [] },
  });

  const { response } = await requestJson(router, '/tenants', {
    user: { id: 1, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --test server/routes/multitenancy-routes.test.js
```

Expected: FAIL with missing route module imports.

- [ ] **Step 3: Implement user tenant routes**

Create `server/routes/tenants.js`:

```js
import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';

export function createTenantsRouter(multitenancy = multitenancyDb) {
  const router = express.Router();

  router.get('/me', (req, res) => {
    const tenants = multitenancy.tenants.listTenantsForUser(req.user.id);
    res.json({ tenants });
  });

  router.get('/:tenantId/validate', (req, res) => {
    const tenantId = Number(req.params.tenantId);
    const membership = multitenancy.memberships.getActiveMembership(req.user.id, tenantId);
    if (!membership) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    res.json({ valid: true, membership });
  });

  router.post('/:tenantId/join-requests', (req, res) => {
    const tenantId = Number(req.params.tenantId);
    const request = multitenancy.joinRequests.createJoinRequest({
      tenantId,
      userId: req.user.id,
      message: typeof req.body?.message === 'string' ? req.body.message.trim() : null,
    });
    res.status(201).json({ request });
  });

  return router;
}

export default createTenantsRouter(multitenancyDb);
```

- [ ] **Step 4: Implement admin routes**

Create `server/routes/admin.js`:

```js
import express from 'express';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

function requireSystemAdmin(req, res, next) {
  if (req.user?.is_system_admin !== 1 && req.user?.is_system_admin !== true) {
    return res.status(403).json({ error: 'System admin access required' });
  }
  return next();
}

export function createAdminRouter(multitenancy = multitenancyDb, users = userDb) {
  const router = express.Router();
  router.use(requireSystemAdmin);

  router.get('/tenants', (req, res) => {
    res.json({ tenants: multitenancy.tenants.listTenants() });
  });

  router.post('/tenants', (req, res) => {
    const tenant = multitenancy.tenants.createTenant({
      code: req.body?.code,
      name: req.body?.name,
      status: req.body?.status || 'active',
    });
    res.status(201).json({ tenant });
  });

  router.get('/users', (req, res) => {
    const rows = users.listUsers ? users.listUsers() : [];
    res.json({ users: rows });
  });

  router.put('/tenants/:tenantId/users/:userId', (req, res) => {
    const membership = multitenancy.memberships.upsertMembership({
      tenantId: Number(req.params.tenantId),
      userId: Number(req.params.userId),
      role: req.body?.role || 'member',
      permission: req.body?.permission || 'view',
      status: req.body?.status || 'active',
    });
    res.json({ membership });
  });

  return router;
}

export { requireSystemAdmin };
export default createAdminRouter(multitenancyDb, userDb);
```

Add `userDb.listUsers` in `server/database/db.js`:

```js
  listUsers: () => {
    try {
      return db.prepare(`
        SELECT id, username, created_at, last_login, is_active, is_system_admin
        FROM users
        ORDER BY username COLLATE NOCASE ASC
      `).all();
    } catch (err) {
      throw err;
    }
  },
```

- [ ] **Step 5: Implement workspace share routes**

Create `server/routes/workspaces.js`:

```js
import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';

export function createWorkspacesRouter({ multitenancy = multitenancyDb, access = workspaceAccess } = {}) {
  const router = express.Router();
  router.use(tenantContext);

  router.get('/:workspaceId/share', (req, res) => {
    const workspaceId = Number(req.params.workspaceId);
    const { workspace, accessRole } = access.requireWorkspace({
      tenantId: req.tenant.id,
      userId: req.user.id,
      workspaceId,
    });
    if (accessRole !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owner can view share settings' });
    }
    res.json({ workspace, acl: multitenancy.workspaceAcl.listAcl(workspaceId) });
  });

  router.put('/:workspaceId/share', (req, res) => {
    const workspaceId = Number(req.params.workspaceId);
    const { workspace, accessRole } = access.requireWorkspace({
      tenantId: req.tenant.id,
      userId: req.user.id,
      workspaceId,
      requireEdit: true,
    });
    if (accessRole !== 'owner') {
      return res.status(403).json({ error: 'Only workspace owner can update share settings' });
    }

    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    for (const entry of entries) {
      const membership = multitenancy.memberships.getActiveMembership(Number(entry.userId), workspace.tenant_id);
      if (!membership) {
        return res.status(422).json({ error: 'Workspace ACL users must belong to the workspace tenant' });
      }
    }

    const acl = multitenancy.workspaceAcl.replaceAcl({
      workspaceId,
      ownerUserId: req.user.id,
      entries,
    });
    res.json({ acl });
  });

  return router;
}

export default createWorkspacesRouter();
```

- [ ] **Step 6: Mount routes**

Modify `server/index.js` imports:

```js
import tenantsRoutes from './routes/tenants.js';
import adminRoutes from './routes/admin.js';
import workspacesRoutes from './routes/workspaces.js';
```

Mount after auth and before project routes:

```js
app.use('/api/tenants', authenticateToken, tenantsRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/workspaces', authenticateToken, workspacesRoutes);
```

- [ ] **Step 7: Run route tests**

Run:

```bash
node --test server/routes/multitenancy-routes.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit tenant routes**

Run:

```bash
git add server/routes/tenants.js server/routes/admin.js server/routes/workspaces.js server/routes/multitenancy-routes.test.js server/index.js server/database/db.js
git commit -m "feat: add tenant admin and workspace share routes"
```

---

### Task 5: Database-Backed Workspace Creation And Listing

**Files:**
- Modify: `server/routes/projects.js`
- Modify: `server/index.js`
- Modify: `src/types/app.ts`
- Modify: `src/utils/api.js`
- Modify: `src/components/project-creation-wizard/data/workspaceApi.ts`

- [ ] **Step 1: Add workspace API types**

Modify `src/types/app.ts`:

```ts
export type TenantPermission = 'view' | 'edit';
export type WorkspaceAccessRole = 'owner' | 'view' | 'edit';

export interface Tenant {
  id: number;
  code: string;
  name: string;
  permission: TenantPermission;
  role?: string;
}
```

Extend `Project`:

```ts
  workspaceId?: number;
  tenantId?: number;
  ownerUserId?: number;
  accessRole?: WorkspaceAccessRole;
```

- [ ] **Step 2: Modify project listing to use DB workspaces**

In `server/index.js`, replace the body of `app.get('/api/projects', ...)` with:

```js
app.get('/api/projects', authenticateToken, tenantContext, async (req, res) => {
    try {
        const rows = multitenancyDb.workspaces.listVisibleWorkspaces({
            tenantId: req.tenant.id,
            userId: req.user.id,
        });
        const projects = [];
        for (const row of rows) {
            const projectName = row.slug;
            const sessionRows = multitenancyDb.sessions.listSessions({
                tenantId: req.tenant.id,
                workspaceId: row.id,
                userId: req.user.id,
            });
            projects.push({
                name: projectName,
                workspaceId: row.id,
                tenantId: row.tenant_id,
                ownerUserId: row.owner_user_id,
                path: row.path,
                fullPath: row.path,
                displayName: row.display_name,
                accessRole: row.accessRole,
                isCustomName: true,
                sessions: sessionRows.filter((session) => session.provider === 'claude').map((session) => ({
                    id: session.provider_session_id,
                    summary: session.summary || 'New Session',
                    lastActivity: session.updated_at,
                    __provider: 'claude',
                    __workspaceId: row.id,
                })),
                codexSessions: sessionRows.filter((session) => session.provider === 'codex').map((session) => ({
                    id: session.provider_session_id,
                    summary: session.summary || 'New Session',
                    lastActivity: session.updated_at,
                    __provider: 'codex',
                    __workspaceId: row.id,
                })),
                cursorSessions: sessionRows.filter((session) => session.provider === 'cursor').map((session) => ({
                    id: session.provider_session_id,
                    summary: session.summary || 'New Session',
                    lastActivity: session.updated_at,
                    __provider: 'cursor',
                    __workspaceId: row.id,
                })),
                geminiSessions: sessionRows.filter((session) => session.provider === 'gemini').map((session) => ({
                    id: session.provider_session_id,
                    summary: session.summary || 'New Session',
                    lastActivity: session.updated_at,
                    __provider: 'gemini',
                    __workspaceId: row.id,
                })),
                sessionMeta: {
                    hasMore: false,
                    total: sessionRows.length,
                },
            });
        }
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

Add imports:

```js
import { multitenancyDb } from './database/multitenancy-db.js';
import { tenantContext } from './middleware/tenant-context.js';
import { workspaceAccess } from './services/workspace-access.js';
```

- [ ] **Step 3: Modify workspace creation route**

In `server/routes/projects.js`, add imports:

```js
import { multitenancyDb } from '../database/multitenancy-db.js';
```

Add helper:

```js
function slugifyWorkspaceName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
```

At the start of `router.post('/create-workspace', ...)`, after required field validation:

```js
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    if (!tenantId || !req.user?.id) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const membership = multitenancyDb.memberships.getActiveMembership(req.user.id, tenantId);
    if (!membership) {
      return res.status(403).json({ error: 'Tenant access denied' });
    }
    if (membership.permission !== 'edit') {
      return res.status(403).json({ error: 'Tenant edit permission is required to create workspaces' });
    }
```

Replace direct use of `workspacePath` for new workspace destination with generated path:

```js
    const requestedName = path.basename(path.resolve(workspacePath));
    const workspaceSlug = slugifyWorkspaceName(requestedName);
    if (!workspaceSlug) {
      return res.status(400).json({ error: 'Workspace name must contain letters or numbers' });
    }
    const generatedWorkspacePath = path.join(WORKSPACES_ROOT, String(tenantId), String(req.user.id), workspaceSlug);
```

Use `generatedWorkspacePath` for validation and creation. After creating or cloning, replace `addProjectManually(...)` response creation with:

```js
      const workspace = multitenancyDb.workspaces.createWorkspace({
        tenantId,
        ownerUserId: req.user.id,
        slug: workspaceSlug,
        displayName: requestedName || workspaceSlug,
        path: clonePath,
      });

      return res.json({
        success: true,
        project: {
          name: workspace.slug,
          workspaceId: workspace.id,
          tenantId: workspace.tenant_id,
          ownerUserId: workspace.owner_user_id,
          displayName: workspace.display_name,
          fullPath: workspace.path,
          path: workspace.path,
          accessRole: 'owner',
        },
        message: 'New workspace created successfully',
      });
```

For non-clone workspace creation, use `generatedWorkspacePath` as `path`.

- [ ] **Step 4: Update frontend API helpers**

Modify `src/utils/api.js`:

```js
const getCurrentTenantId = () => localStorage.getItem('currentTenantId');

const withTenantParam = (url) => {
  const tenantId = getCurrentTenantId();
  if (!tenantId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}tenantId=${encodeURIComponent(tenantId)}`;
};
```

Change:

```js
projects: () => authenticatedFetch(withTenantParam('/api/projects')),
```

Change workspace creation:

```js
createWorkspace: (workspaceData) =>
  authenticatedFetch(withTenantParam('/api/projects/create-workspace'), {
    method: 'POST',
    body: JSON.stringify(workspaceData),
  }),
```

Add tenant APIs:

```js
tenants: {
  mine: () => authenticatedFetch('/api/tenants/me'),
  validate: (tenantId) => authenticatedFetch(`/api/tenants/${tenantId}/validate`),
  requestJoin: (tenantId, message) =>
    authenticatedFetch(`/api/tenants/${tenantId}/join-requests`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
},
admin: {
  tenants: () => authenticatedFetch('/api/admin/tenants'),
  createTenant: (payload) =>
    authenticatedFetch('/api/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  users: () => authenticatedFetch('/api/admin/users'),
  upsertTenantUser: (tenantId, userId, payload) =>
    authenticatedFetch(`/api/admin/tenants/${tenantId}/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
},
workspaceShare: {
  get: (workspaceId) => authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/share`)),
  update: (workspaceId, entries) =>
    authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/share`), {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    }),
},
```

- [ ] **Step 5: Run checks**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit workspace listing and creation**

Run:

```bash
git add server/index.js server/routes/projects.js src/types/app.ts src/utils/api.js src/components/project-creation-wizard/data/workspaceApi.ts
git commit -m "feat: list and create tenant workspaces"
```

---

### Task 6: Authorize File, Git, Shell, And Chat Workspace Access

**Files:**
- Modify: `server/index.js`
- Modify: `server/routes/git.js`
- Modify: `server/routes/messages.js`
- Modify: `server/routes/codex.js`
- Modify: `server/routes/gemini.js`

- [ ] **Step 1: Add shared request helpers in `server/index.js`**

Add near `validatePathInProject`:

```js
function getRequestTenantId(req) {
    return Number(req.query.tenantId || req.headers['x-tenant-id']);
}

function getRequestWorkspaceId(req) {
    return Number(req.query.workspaceId || req.body?.workspaceId || req.params.workspaceId);
}

function getRequestUserId(req) {
    return req.user?.id ?? req.user?.userId;
}

function handleWorkspaceError(res, error) {
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({ error: error.message });
}

function resolveWorkspaceForRequest(req, { requireEdit = false } = {}) {
    const tenantId = getRequestTenantId(req);
    const userId = getRequestUserId(req);
    const workspaceId = getRequestWorkspaceId(req);
    if (!tenantId || !workspaceId || !userId) {
        const error = new Error('tenantId and workspaceId are required');
        error.statusCode = 400;
        throw error;
    }
    return workspaceAccess.requireWorkspace({ tenantId, userId, workspaceId, requireEdit });
}
```

- [ ] **Step 2: Update file routes to use workspaceId**

For each file route in `server/index.js`, replace `extractProjectDirectory(projectName)` with:

```js
        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: false });
        const projectRoot = workspace.path;
```

For write routes (`PUT /file`, create, rename, delete, upload), use:

```js
        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
        const projectRoot = workspace.path;
```

Wrap each route catch:

```js
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        }
```

- [ ] **Step 3: Update Git routes**

In `server/routes/git.js`, add imports:

```js
import { workspaceAccess } from '../services/workspace-access.js';
```

Add helper:

```js
function resolveTenantWorkspace(req, { requireEdit = false } = {}) {
  const tenantId = Number(req.query.tenantId || req.body?.tenantId || req.headers['x-tenant-id']);
  const workspaceId = Number(req.query.workspaceId || req.body?.workspaceId);
  const userId = req.user?.id ?? req.user?.userId;
  if (!tenantId || !workspaceId || !userId) {
    const error = new Error('tenantId and workspaceId are required');
    error.statusCode = 400;
    throw error;
  }
  return workspaceAccess.requireWorkspace({ tenantId, userId, workspaceId, requireEdit }).workspace.path;
}
```

Replace calls to `getActualProjectPath(project)` in read-only routes with:

```js
const projectPath = resolveTenantWorkspace(req, { requireEdit: false });
```

Replace calls in write routes such as commit, branch, checkout, revert, push, pull, and generate commit message with:

```js
const projectPath = resolveTenantWorkspace(req, { requireEdit: true });
```

- [ ] **Step 4: Update chat WebSocket authorization**

In `handleChatConnection`, before provider command dispatch, resolve workspace:

```js
                const tenant = request?.tenant;
                const userId = request?.user?.id ?? request?.user?.userId;
                const workspaceId = Number(data.options?.workspaceId);
                if (!tenant?.id || !workspaceId || !userId) {
                    writer.send(createNormalizedMessage({ kind: 'error', content: 'tenantId and workspaceId are required', provider: data.type?.replace('-command', '') || 'claude' }));
                    return;
                }
                const { workspace } = workspaceAccess.requireWorkspace({
                    tenantId: tenant.id,
                    userId,
                    workspaceId,
                    requireEdit: true,
                });
                data.options = {
                    ...data.options,
                    tenantId: tenant.id,
                    workspaceId,
                    userId,
                    cwd: workspace.path,
                    projectPath: workspace.path,
                };
```

Use this block for `claude-command`, `cursor-command`, `codex-command`, and `gemini-command`.

- [ ] **Step 5: Update shell WebSocket authorization**

Change `handleShellConnection(ws)` to `handleShellConnection(ws, request)` and caller to `handleShellConnection(ws, request)`.

Inside `data.type === 'init'`, replace frontend `projectPath` trust with:

```js
                const tenant = request?.tenant;
                const userId = request?.user?.id ?? request?.user?.userId;
                const workspaceId = Number(data.workspaceId);
                if (!tenant?.id || !workspaceId || !userId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'tenantId and workspaceId are required' }));
                    return;
                }
                const { workspace } = workspaceAccess.requireWorkspace({
                    tenantId: tenant.id,
                    userId,
                    workspaceId,
                    requireEdit: true,
                });
                const projectPath = workspace.path;
```

- [ ] **Step 6: Bind tenant during WebSocket verify**

In `verifyClient`, after `info.req.user = user`, add:

```js
        const tenant = resolveWebSocketTenant({ request: info.req, user });
        if (!tenant) {
            console.log('[WARN] WebSocket tenant authentication failed');
            return false;
        }
        info.req.tenant = tenant;
```

Import:

```js
import { resolveWebSocketTenant } from './middleware/tenant-context.js';
```

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit route authorization**

Run:

```bash
git add server/index.js server/routes/git.js server/routes/messages.js server/routes/codex.js server/routes/gemini.js
git commit -m "feat: enforce workspace authorization on web routes"
```

---

### Task 7: Session Index Integration

**Files:**
- Modify: `server/claude-sdk.js`
- Modify: `server/openai-codex.js`
- Modify: `server/cursor-cli.js`
- Modify: `server/gemini-cli.js`
- Modify: `server/sessionManager.js`
- Modify: `server/routes/messages.js`
- Modify: `server/routes/codex.js`
- Modify: `server/routes/gemini.js`

- [ ] **Step 1: Update message history route**

In `server/routes/messages.js`, import:

```js
import { multitenancyDb } from '../database/multitenancy-db.js';
```

Before calling `sessionsService.fetchHistory`, add:

```js
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    const userId = req.user?.id ?? req.user?.userId;
    if (!tenantId || !userId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    const ownedSession = multitenancyDb.sessions.findOwnedSession({
      tenantId,
      userId,
      provider,
      providerSessionId: sessionId,
    });
    if (!ownedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }
```

Use owned workspace fields:

```js
      projectName,
      projectPath,
      workspaceId: ownedSession.workspace_id,
```

- [ ] **Step 2: Record Claude sessions**

In `server/claude-sdk.js`, import:

```js
import { multitenancyDb } from './database/multitenancy-db.js';
```

Add helper:

```js
function recordSessionOwnership(options, providerSessionId, status = 'active') {
  if (!options?.tenantId || !options?.workspaceId || !options?.userId || !providerSessionId) return;
  multitenancyDb.sessions.upsertSession({
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
    userId: options.userId,
    provider: 'claude',
    providerSessionId,
    summary: options.sessionSummary || null,
    status,
  });
}
```

After `capturedSessionId = message.session_id;`, add:

```js
        recordSessionOwnership(options, capturedSessionId, 'active');
```

Before completion notification, add:

```js
    recordSessionOwnership(options, capturedSessionId || sessionId, 'completed');
```

In catch block, add:

```js
    recordSessionOwnership(options, capturedSessionId || sessionId, 'failed');
```

- [ ] **Step 3: Record Codex sessions**

In `server/openai-codex.js`, import:

```js
import { multitenancyDb } from './database/multitenancy-db.js';
```

After `currentSessionId = thread.id || sessionId || ...`, add:

```js
    if (tenantId && workspaceId && userId && currentSessionId) {
      multitenancyDb.sessions.upsertSession({
        tenantId,
        workspaceId,
        userId,
        provider: 'codex',
        providerSessionId: currentSessionId,
        summary: sessionSummary || null,
        status: 'active',
      });
    }
```

Destructure from options at the top:

```js
    tenantId,
    workspaceId,
    userId,
```

On completion/error, upsert with `completed` or `failed`.

- [ ] **Step 4: Record Cursor and Gemini sessions**

In `server/cursor-cli.js` and `server/gemini-cli.js`, import `multitenancyDb` and add the same ownership upsert when a provider session id is captured or generated. Use provider values `cursor` and `gemini`.

The code shape in each file:

```js
function recordProviderSession(options, providerSessionId, provider, status = 'active') {
  if (!options?.tenantId || !options?.workspaceId || !options?.userId || !providerSessionId) return;
  multitenancyDb.sessions.upsertSession({
    tenantId: options.tenantId,
    workspaceId: options.workspaceId,
    userId: options.userId,
    provider,
    providerSessionId,
    summary: options.sessionSummary || null,
    status,
  });
}
```

- [ ] **Step 5: Mark deleted provider sessions only for owner**

In `server/routes/codex.js`, before `deleteCodexSession(sessionId)`:

```js
    const tenantId = Number(req.query.tenantId || req.headers['x-tenant-id']);
    const userId = req.user?.id ?? req.user?.userId;
    const ownedSession = multitenancyDb.sessions.findOwnedSession({
      tenantId,
      userId,
      provider: 'codex',
      providerSessionId: sessionId,
    });
    if (!ownedSession) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
```

After deletion:

```js
    multitenancyDb.sessions.markDeleted({ tenantId, userId, provider: 'codex', providerSessionId: sessionId });
```

Repeat in `server/routes/gemini.js` with provider `gemini`.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit session ownership**

Run:

```bash
git add server/claude-sdk.js server/openai-codex.js server/cursor-cli.js server/gemini-cli.js server/sessionManager.js server/routes/messages.js server/routes/codex.js server/routes/gemini.js
git commit -m "feat: index provider sessions by tenant and user"
```

---

### Task 8: Tenant Context Frontend Foundation

**Files:**
- Create: `src/components/tenant/tenantSelection.ts`
- Create: `src/contexts/TenantContext.tsx`
- Create: `src/contexts/TenantContext.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/auth/view/ProtectedRoute.tsx`
- Modify: `src/contexts/WebSocketContext.tsx`

- [ ] **Step 1: Write tenant selection helper tests**

Create `src/contexts/TenantContext.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseInitialTenant } from '../components/tenant/tenantSelection';

test('chooseInitialTenant keeps saved tenant when still visible', () => {
  const tenant = chooseInitialTenant('2', [
    { id: 1, code: 'one', name: 'One', permission: 'view' },
    { id: 2, code: 'two', name: 'Two', permission: 'edit' },
  ]);

  assert.equal(tenant?.id, 2);
});

test('chooseInitialTenant requires explicit choice when saved tenant is gone', () => {
  const tenant = chooseInitialTenant('99', [
    { id: 1, code: 'one', name: 'One', permission: 'view' },
  ]);

  assert.equal(tenant, null);
});
```

- [ ] **Step 2: Implement tenant selection helper**

Create `src/components/tenant/tenantSelection.ts`:

```ts
import type { Tenant } from '../../types/app';

export const CURRENT_TENANT_STORAGE_KEY = 'currentTenantId';

export function chooseInitialTenant(savedTenantId: string | null, tenants: Tenant[]): Tenant | null {
  if (!savedTenantId) {
    return null;
  }
  const numericId = Number(savedTenantId);
  if (!Number.isInteger(numericId)) {
    return null;
  }
  return tenants.find((tenant) => tenant.id === numericId) ?? null;
}
```

- [ ] **Step 3: Implement TenantContext**

Create `src/contexts/TenantContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import type { Tenant } from '../types/app';
import { chooseInitialTenant, CURRENT_TENANT_STORAGE_KEY } from '../components/tenant/tenantSelection';
import { useAuth } from '../components/auth/context/AuthContext';

type TenantContextValue = {
  tenants: Tenant[];
  currentTenant: Tenant | null;
  isLoadingTenants: boolean;
  needsTenantSelection: boolean;
  refreshTenants: () => Promise<void>;
  selectTenant: (tenant: Tenant) => void;
  clearTenant: () => void;
};

const TenantContext = createContext<TenantContextValue | null>(null);

export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
}

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null);
  const [isLoadingTenants, setIsLoadingTenants] = useState(false);

  const selectTenant = useCallback((tenant: Tenant) => {
    setCurrentTenant(tenant);
    localStorage.setItem(CURRENT_TENANT_STORAGE_KEY, String(tenant.id));
  }, []);

  const clearTenant = useCallback(() => {
    setCurrentTenant(null);
    localStorage.removeItem(CURRENT_TENANT_STORAGE_KEY);
  }, []);

  const refreshTenants = useCallback(async () => {
    if (!user) {
      setTenants([]);
      setCurrentTenant(null);
      return;
    }
    setIsLoadingTenants(true);
    try {
      const response = await api.tenants.mine();
      if (!response.ok) {
        setTenants([]);
        setCurrentTenant(null);
        return;
      }
      const payload = await response.json();
      const nextTenants = payload.tenants || [];
      setTenants(nextTenants);
      const saved = localStorage.getItem(CURRENT_TENANT_STORAGE_KEY);
      const chosen = chooseInitialTenant(saved, nextTenants);
      setCurrentTenant((previous) => {
        if (previous && nextTenants.some((tenant: Tenant) => tenant.id === previous.id)) {
          return previous;
        }
        return chosen;
      });
    } finally {
      setIsLoadingTenants(false);
    }
  }, [user]);

  useEffect(() => {
    void refreshTenants();
  }, [refreshTenants]);

  const value = useMemo<TenantContextValue>(() => ({
    tenants,
    currentTenant,
    isLoadingTenants,
    needsTenantSelection: Boolean(user) && !isLoadingTenants && !currentTenant,
    refreshTenants,
    selectTenant,
    clearTenant,
  }), [clearTenant, currentTenant, isLoadingTenants, refreshTenants, selectTenant, tenants, user]);

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}
```

- [ ] **Step 4: Wrap app with TenantProvider**

Modify `src/App.tsx`:

```tsx
import { TenantProvider } from './contexts/TenantContext';
```

Wrap providers:

```tsx
        <AuthProvider>
          <TenantProvider>
            <WebSocketProvider>
              <PluginsProvider>
```

Close before `</AuthProvider>`.

- [ ] **Step 5: Reconnect WebSocket by tenant**

Modify `src/contexts/WebSocketContext.tsx`:

```tsx
import { useTenant } from './TenantContext';
```

Inside provider state:

```tsx
  const { currentTenant } = useTenant();
```

Change URL builder:

```tsx
const buildWebSocketUrl = (token: string | null, tenantId: number | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tenantPart = tenantId ? `tenantId=${encodeURIComponent(String(tenantId))}` : '';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws${tenantPart ? `?${tenantPart}` : ''}`;
  if (!token) return null;
  const params = new URLSearchParams({ token });
  if (tenantId) params.set('tenantId', String(tenantId));
  return `${protocol}//${window.location.host}/ws?${params.toString()}`;
};
```

Use:

```tsx
const wsUrl = buildWebSocketUrl(token, currentTenant?.id ?? null);
```

Update `useEffect` dependency:

```tsx
  }, [token, currentTenant?.id]);
```

- [ ] **Step 6: Run frontend helper test**

Run:

```bash
npx tsx --test src/contexts/TenantContext.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit frontend tenant foundation**

Run:

```bash
git add src/components/tenant/tenantSelection.ts src/contexts/TenantContext.tsx src/contexts/TenantContext.test.ts src/App.tsx src/components/auth/view/ProtectedRoute.tsx src/contexts/WebSocketContext.tsx
git commit -m "feat: add frontend tenant context"
```

---

### Task 9: Tenant Selection UI And Project Fetching

**Files:**
- Create: `src/components/tenant/TenantSelection.tsx`
- Modify: `src/components/auth/view/ProtectedRoute.tsx`
- Modify: `src/hooks/useProjectsState.ts`
- Modify: `src/utils/api.js`

- [ ] **Step 1: Implement tenant selection screen**

Create `src/components/tenant/TenantSelection.tsx`:

```tsx
import { Building2, Check, RefreshCw } from 'lucide-react';
import { Button, Card } from '../../shared/view/ui';
import { useTenant } from '../../contexts/TenantContext';

export default function TenantSelection() {
  const { tenants, isLoadingTenants, refreshTenants, selectTenant } = useTenant();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">Select tenant</h1>
          <p className="text-sm text-muted-foreground">Choose the organization workspace for this session.</p>
        </div>

        <Card className="space-y-2 p-3">
          {tenants.length === 0 && !isLoadingTenants ? (
            <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              No tenant access is available for this account.
            </div>
          ) : null}

          {tenants.map((tenant) => (
            <button
              key={tenant.id}
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-accent"
              onClick={() => selectTenant(tenant)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Building2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-foreground">{tenant.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{tenant.code} · {tenant.permission}</span>
                </span>
              </span>
              <Check className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </Card>

        <Button variant="outline" onClick={() => void refreshTenants()} disabled={isLoadingTenants}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Gate protected route by tenant selection**

Modify `src/components/auth/view/ProtectedRoute.tsx`:

```tsx
import { useTenant } from '../../../contexts/TenantContext';
import TenantSelection from '../../tenant/TenantSelection';
```

Inside component:

```tsx
  const { isLoadingTenants, needsTenantSelection } = useTenant();
```

Before onboarding:

```tsx
  if (isLoadingTenants) {
    return <AuthLoadingScreen />;
  }

  if (needsTenantSelection) {
    return <TenantSelection />;
  }
```

- [ ] **Step 3: Refetch projects on tenant switch**

Modify `src/hooks/useProjectsState.ts`:

```ts
import { useTenant } from '../contexts/TenantContext';
```

Inside `useProjectsState`:

```ts
  const { currentTenant } = useTenant();
```

In `fetchProjects`, short-circuit without tenant:

```ts
      if (!currentTenant) {
        setProjects([]);
        setSelectedProject(null);
        setSelectedSession(null);
        return;
      }
```

Add `currentTenant?.id` to `fetchProjects` dependency list.

Add effect:

```ts
  useEffect(() => {
    setProjects([]);
    setSelectedProject(null);
    setSelectedSession(null);
    void fetchProjects();
  }, [currentTenant?.id, fetchProjects]);
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit tenant selection UI**

Run:

```bash
git add src/components/tenant/TenantSelection.tsx src/components/auth/view/ProtectedRoute.tsx src/hooks/useProjectsState.ts src/utils/api.js
git commit -m "feat: require tenant selection in web ui"
```

---

### Task 10: Minimal System Admin UI

**Files:**
- Create: `src/components/admin/AdminPanel.tsx`
- Modify: `src/components/app/AppContent.tsx`
- Modify: `src/components/sidebar/view/Sidebar.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarFooter.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- Modify: `src/components/sidebar/types/types.ts`

- [ ] **Step 1: Implement AdminPanel**

Create `src/components/admin/AdminPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Shield, Plus, RefreshCw } from 'lucide-react';
import { api } from '../../utils/api';
import { Button, Dialog, Input } from '../../shared/view/ui';

type AdminTenant = {
  id: number;
  code: string;
  name: string;
  status: string;
};

type AdminUser = {
  id: number;
  username: string;
  is_active: number;
  is_system_admin: number;
};

type AdminPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function AdminPanel({ open, onOpenChange }: AdminPanelProps) {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tenantCode, setTenantCode] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [permission, setPermission] = useState<'view' | 'edit'>('edit');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [tenantResponse, userResponse] = await Promise.all([
        api.admin.tenants(),
        api.admin.users(),
      ]);
      if (!tenantResponse.ok || !userResponse.ok) {
        setError('Failed to load admin data');
        return;
      }
      const tenantPayload = await tenantResponse.json();
      const userPayload = await userResponse.json();
      setTenants(tenantPayload.tenants || []);
      setUsers(userPayload.users || []);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open]);

  const createTenant = async () => {
    setError(null);
    const response = await api.admin.createTenant({ code: tenantCode, name: tenantName });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error || 'Failed to create tenant');
      return;
    }
    setTenantCode('');
    setTenantName('');
    await load();
  };

  const grantMembership = async () => {
    setError(null);
    const tenantId = Number(selectedTenantId);
    const userId = Number(selectedUserId);
    if (!tenantId || !userId) {
      setError('Select a tenant and a user');
      return;
    }
    const response = await api.admin.upsertTenantUser(tenantId, userId, {
      role: 'member',
      permission,
      status: 'active',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setError(payload.error || 'Failed to grant membership');
      return;
    }
    setSelectedTenantId('');
    setSelectedUserId('');
    setPermission('edit');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="System administration">
      <div className="space-y-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Shield className="h-4 w-4" />
          <span>Manage tenants, users, and tenant memberships.</span>
        </div>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-foreground">Create tenant</h2>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input value={tenantCode} onChange={(event) => setTenantCode(event.target.value)} aria-label="Tenant code" />
            <Input value={tenantName} onChange={(event) => setTenantName(event.target.value)} aria-label="Tenant name" />
            <Button onClick={createTenant}>
              <Plus className="mr-2 h-4 w-4" />
              Create
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-foreground">Grant tenant access</h2>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
            <select className="rounded-md border border-border bg-background px-2 py-2 text-sm" value={selectedTenantId} onChange={(event) => setSelectedTenantId(event.target.value)}>
              <option value="">Tenant</option>
              {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
            </select>
            <select className="rounded-md border border-border bg-background px-2 py-2 text-sm" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)}>
              <option value="">User</option>
              {users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
            </select>
            <select className="rounded-md border border-border bg-background px-2 py-2 text-sm" value={permission} onChange={(event) => setPermission(event.target.value as 'view' | 'edit')}>
              <option value="edit">Edit</option>
              <option value="view">View</option>
            </select>
            <Button onClick={grantMembership}>Grant</Button>
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-foreground">Tenants</h2>
            <Button variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-h-48 overflow-auto rounded-md border border-border">
            {tenants.map((tenant) => (
              <div key={tenant.id} className="flex items-center justify-between border-b border-border px-3 py-2 text-sm last:border-b-0">
                <span>{tenant.name}</span>
                <span className="text-muted-foreground">{tenant.code}</span>
              </div>
            ))}
          </div>
        </section>

        {error ? <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div> : null}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 2: Add admin panel state to AppContent**

Modify `src/components/app/AppContent.tsx` imports:

```tsx
import { useState } from 'react';
import { useAuth } from '../auth/context/AuthContext';
import AdminPanel from '../admin/AdminPanel';
```

Inside component:

```tsx
const { user } = useAuth();
const [showAdminPanel, setShowAdminPanel] = useState(false);
const isSystemAdmin = user?.is_system_admin === 1 || user?.is_system_admin === true;
```

Pass to `Sidebar`:

```tsx
<Sidebar
  {...sidebarSharedProps}
  showAdminEntry={isSystemAdmin}
  onShowAdminPanel={() => setShowAdminPanel(true)}
/>
```

Render near settings/modal area:

```tsx
<AdminPanel open={showAdminPanel} onOpenChange={setShowAdminPanel} />
```

- [ ] **Step 3: Add sidebar admin entry**

In `src/components/sidebar/types/types.ts`, add props:

```ts
showAdminEntry?: boolean;
onShowAdminPanel?: () => void;
```

In `Sidebar.tsx`, accept and pass those props to `SidebarContent`.

In `SidebarContent.tsx`, pass them to `SidebarFooter`.

In `SidebarFooter.tsx`, import `Shield`:

```tsx
import { Settings, ArrowUpCircle, Bug, Shield } from 'lucide-react';
```

Add props:

```ts
  showAdminEntry?: boolean;
  onShowAdminPanel?: () => void;
```

Render above Settings:

```tsx
{showAdminEntry && (
  <div className="hidden px-2 md:block">
    <button
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      onClick={onShowAdminPanel}
    >
      <Shield className="h-3.5 w-3.5" />
      <span className="text-sm">Admin</span>
    </button>
  </div>
)}
```

Add mobile entry:

```tsx
{showAdminEntry && (
  <div className="px-3 pt-2 md:hidden">
    <button
      className="flex h-12 w-full items-center gap-3.5 rounded-xl bg-muted/40 px-4 transition-all hover:bg-muted/60 active:scale-[0.98]"
      onClick={onShowAdminPanel}
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-background/80">
        <Shield className="w-4.5 h-4.5 text-muted-foreground" />
      </div>
      <span className="text-base font-medium text-foreground">Admin</span>
    </button>
  </div>
)}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit admin UI**

Run:

```bash
git add src/components/admin/AdminPanel.tsx src/components/app/AppContent.tsx src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarFooter.tsx src/components/sidebar/view/subcomponents/SidebarContent.tsx src/components/sidebar/types/types.ts
git commit -m "feat: add minimal system admin ui"
```

---

### Task 11: Workspace Sharing UI

**Files:**
- Create: `src/components/workspace-share/workspaceShare.ts`
- Create: `src/components/workspace-share/workspaceShare.test.ts`
- Create: `src/components/workspace-share/WorkspaceShareDialog.tsx`
- Modify: `src/components/sidebar/view/Sidebar.tsx`
- Modify: `src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx`
- Modify: `src/components/sidebar/types/types.ts`

- [ ] **Step 1: Write ACL helper tests**

Create `src/components/workspace-share/workspaceShare.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWorkspaceAclEntries } from './workspaceShare';

test('normalizeWorkspaceAclEntries removes owner and invalid users', () => {
  const entries = normalizeWorkspaceAclEntries(1, [
    { userId: 1, permission: 'edit' },
    { userId: 2, permission: 'edit' },
    { userId: 0, permission: 'view' },
    { userId: 3, permission: 'bad' },
  ]);

  assert.deepEqual(entries, [{ userId: 2, permission: 'edit' }]);
});
```

- [ ] **Step 2: Implement ACL helper**

Create `src/components/workspace-share/workspaceShare.ts`:

```ts
export type WorkspaceSharePermission = 'view' | 'edit';

export type WorkspaceAclEntryInput = {
  userId: number;
  permission: string;
};

export function normalizeWorkspaceAclEntries(ownerUserId: number, entries: WorkspaceAclEntryInput[]) {
  return entries
    .filter((entry) => Number.isInteger(Number(entry.userId)) && Number(entry.userId) > 0)
    .filter((entry) => Number(entry.userId) !== Number(ownerUserId))
    .filter((entry) => entry.permission === 'view' || entry.permission === 'edit')
    .map((entry) => ({
      userId: Number(entry.userId),
      permission: entry.permission as WorkspaceSharePermission,
    }));
}
```

- [ ] **Step 3: Implement share dialog**

Create `src/components/workspace-share/WorkspaceShareDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Share2, Trash2 } from 'lucide-react';
import { api } from '../../utils/api';
import { Button, Dialog, Input } from '../../shared/view/ui';
import type { Project } from '../../types/app';
import { normalizeWorkspaceAclEntries } from './workspaceShare';

type WorkspaceShareDialogProps = {
  project: Project | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export default function WorkspaceShareDialog({ project, open, onOpenChange }: WorkspaceShareDialogProps) {
  const [entries, setEntries] = useState<Array<{ userId: number; permission: 'view' | 'edit'; username?: string }>>([]);
  const [newUserId, setNewUserId] = useState('');
  const [newPermission, setNewPermission] = useState<'view' | 'edit'>('edit');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project?.workspaceId) return;
    void api.workspaceShare.get(project.workspaceId).then(async (response) => {
      if (!response.ok) {
        setError('Failed to load sharing settings');
        return;
      }
      const payload = await response.json();
      setEntries(payload.acl || []);
    });
  }, [open, project?.workspaceId]);

  const addEntry = () => {
    const parsedUserId = Number(newUserId);
    const normalized = normalizeWorkspaceAclEntries(Number(project?.ownerUserId), [
      ...entries,
      { userId: parsedUserId, permission: newPermission },
    ]);
    setEntries(normalized);
    setNewUserId('');
    setNewPermission('edit');
  };

  const save = async () => {
    if (!project?.workspaceId) return;
    setIsSaving(true);
    setError(null);
    try {
      const payload = normalizeWorkspaceAclEntries(Number(project.ownerUserId), entries);
      const response = await api.workspaceShare.update(project.workspaceId, payload);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error || 'Failed to save sharing settings');
        return;
      }
      onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Share workspace">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Share2 className="h-4 w-4" />
          <span>{project?.displayName}</span>
        </div>

        <div className="space-y-2">
          {entries.map((entry) => (
            <div key={entry.userId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">User #{entry.userId}{entry.username ? ` · ${entry.username}` : ''}</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={entry.permission}
                onChange={(event) => {
                  setEntries((prev) => prev.map((item) => item.userId === entry.userId ? { ...item, permission: event.target.value as 'view' | 'edit' } : item));
                }}
              >
                <option value="view">View</option>
                <option value="edit">Edit</option>
              </select>
              <Button variant="ghost" size="icon" onClick={() => setEntries((prev) => prev.filter((item) => item.userId !== entry.userId))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <Input value={newUserId} onChange={(event) => setNewUserId(event.target.value)} aria-label="User ID" />
          <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={newPermission} onChange={(event) => setNewPermission(event.target.value as 'view' | 'edit')}>
            <option value="edit">Edit</option>
            <option value="view">View</option>
          </select>
          <Button variant="outline" onClick={addEntry}>Add</Button>
        </div>

        {error ? <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{error}</div> : null}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={isSaving}>Save</Button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire owner share control in sidebar**

In sidebar project item actions, add a share button only when:

```ts
project.accessRole === 'owner'
```

Pass `onShareProject(project)` from `Sidebar.tsx` to the project item. In `Sidebar.tsx`, keep state:

```tsx
const [shareProject, setShareProject] = useState<Project | null>(null);
```

Render:

```tsx
<WorkspaceShareDialog
  project={shareProject}
  open={Boolean(shareProject)}
  onOpenChange={(open) => {
    if (!open) setShareProject(null);
  }}
/>
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx tsx --test src/components/workspace-share/workspaceShare.test.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit sharing UI**

Run:

```bash
git add src/components/workspace-share src/components/sidebar/view/Sidebar.tsx src/components/sidebar/view/subcomponents/SidebarProjectItem.tsx src/components/sidebar/types/types.ts
git commit -m "feat: add workspace sharing ui"
```

---

### Task 12: View-Only UI Restrictions And Workspace IDs In Commands

**Files:**
- Modify: `src/components/main-content/view/MainContent.tsx`
- Modify: `src/components/chat/hooks/useChatSessionState.ts`
- Modify: `src/components/chat/view/ChatInterface.tsx`
- Modify: `src/components/shell/hooks/useShellConnection.ts`
- Modify: `src/components/git-panel/hooks/useGitPanelController.ts`
- Modify: `src/utils/api.js`

- [ ] **Step 1: Add tenant and workspace id to session message fetch**

In `src/stores/useSessionStore.ts`, add `workspaceId?: number` to fetch opts and append:

```ts
if (opts.workspaceId) params.append('workspaceId', String(opts.workspaceId));
```

In `useChatSessionState`, pass:

```ts
workspaceId: selectedProject.workspaceId as number | undefined,
```

- [ ] **Step 2: Add workspace id to chat command options**

Where chat sends provider command options, ensure options include:

```ts
workspaceId: selectedProject?.workspaceId,
```

and do not send raw `projectPath` as authority. Keep `projectPath` only for display when needed.

- [ ] **Step 3: Add workspace id to shell init**

In `src/components/shell/hooks/useShellConnection.ts`, include:

```ts
workspaceId: selectedProject?.workspaceId,
```

in the `init` message.

- [ ] **Step 4: Add workspace id to Git API calls**

In `src/components/git-panel/hooks/useGitPanelController.ts`, replace URLs like:

```ts
`/api/git/status?project=${encodeURIComponent(projectName)}`
```

with:

```ts
`/api/git/status?workspaceId=${encodeURIComponent(String(selectedProject.workspaceId))}`
```

Keep `project` only where the backend still needs a legacy display string; authorization must use `workspaceId`.

- [ ] **Step 5: Disable write/run tabs for view-only access**

In `src/components/main-content/view/MainContent.tsx`, derive:

```tsx
const isViewOnlyWorkspace = selectedProject?.accessRole === 'view';
```

Disable or hide tabs/actions:

```tsx
const disabledTabs = isViewOnlyWorkspace ? new Set(['chat', 'shell', 'git']) : new Set();
```

For file editor save/create/upload/delete props, pass disabled state when `isViewOnlyWorkspace` is true.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit frontend authorization wiring**

Run:

```bash
git add src/stores/useSessionStore.ts src/components/main-content/view/MainContent.tsx src/components/chat/hooks/useChatSessionState.ts src/components/chat/view/ChatInterface.tsx src/components/shell/hooks/useShellConnection.ts src/components/git-panel/hooks/useGitPanelController.ts src/utils/api.js
git commit -m "feat: pass workspace context through frontend workflows"
```

---

### Task 13: End-To-End Permission Verification

**Files:**
- Create: `server/tests/multitenancy-permissions.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add permission integration test**

Create `server/tests/multitenancy-permissions.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { DATABASE_SCHEMA_SQL } from '../database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from '../database/multitenancy-schema.js';
import { createMultitenancyDb } from '../database/multitenancy-db.js';
import { createWorkspaceAccessService } from '../services/workspace-access.js';

function setup() {
  const database = new Database(':memory:');
  database.exec(DATABASE_SCHEMA_SQL);
  database.exec(MULTITENANCY_SCHEMA_SQL);
  const mt = createMultitenancyDb(database);
  const user = (username) => Number(database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, 'hash').lastInsertRowid);
  return { database, mt, user, access: createWorkspaceAccessService(mt) };
}

test('shared edit workspace can be edited but sessions stay private', () => {
  const { mt, user, access } = setup();
  const ownerId = user('owner');
  const editorId = user('editor');
  const tenant = mt.tenants.createTenant({ code: 'team', name: 'Team' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: ownerId, role: 'member', permission: 'edit', status: 'active' });
  mt.memberships.upsertMembership({ tenantId: tenant.id, userId: editorId, role: 'member', permission: 'edit', status: 'active' });
  const workspace = mt.workspaces.createWorkspace({
    tenantId: tenant.id,
    ownerUserId: ownerId,
    slug: 'repo',
    displayName: 'Repo',
    path: '/tmp/team/owner/repo',
  });
  mt.workspaceAcl.replaceAcl({ workspaceId: workspace.id, ownerUserId: ownerId, entries: [{ userId: editorId, permission: 'edit' }] });

  assert.equal(access.canEditWorkspace({ tenantId: tenant.id, userId: editorId, workspaceId: workspace.id }), true);

  mt.sessions.upsertSession({
    tenantId: tenant.id,
    workspaceId: workspace.id,
    userId: ownerId,
    provider: 'claude',
    providerSessionId: 'owner-session',
    summary: 'Owner',
  });

  assert.equal(mt.sessions.findOwnedSession({
    tenantId: tenant.id,
    userId: editorId,
    provider: 'claude',
    providerSessionId: 'owner-session',
  }), null);
});
```

- [ ] **Step 2: Add test script**

Modify `package.json` scripts:

```json
"test:multitenancy": "node --test server/database/multitenancy-db.test.js server/middleware/tenant-context.test.js server/services/workspace-access.test.js server/routes/multitenancy-routes.test.js server/tests/multitenancy-permissions.test.js && npx tsx --test src/contexts/TenantContext.test.ts src/components/workspace-share/workspaceShare.test.ts"
```

- [ ] **Step 3: Run multitenancy tests**

Run:

```bash
npm run test:multitenancy
```

Expected: PASS.

- [ ] **Step 4: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit verification harness**

Run:

```bash
git add server/tests/multitenancy-permissions.test.js package.json package-lock.json
git commit -m "test: add multitenancy permission verification"
```

---

## Manual Verification

- [ ] Start the app:

```bash
npm run dev
```

Expected: Vite and server start without errors.

- [ ] Visit `http://localhost:5173`.

Expected: Existing first-user setup appears if there are no users, otherwise login appears.

- [ ] Create the first user.

Expected: user is marked system admin and can open admin panel.

- [ ] Create a tenant and grant the admin `edit` membership.

Expected: tenant appears in tenant selection.

- [ ] Select the tenant and create a workspace.

Expected: workspace appears in sidebar and path is under `WORKSPACES_ROOT/<tenantId>/<userId>/<slug>`.

- [ ] Create a second user and grant tenant `edit`.

Expected: second user can select the tenant but cannot see owner workspace.

- [ ] Owner shares workspace with second user as `edit`.

Expected: second user sees workspace, can edit a file, can open Git status, can launch chat/shell.

- [ ] Owner starts a Claude session.

Expected: owner sees session in sidebar.

- [ ] Second user refreshes shared workspace.

Expected: second user does not see owner session.

## Plan Self-Review

Spec coverage:

- Tenant persistence: Task 1, Task 4.
- User membership and permissions: Task 1, Task 4, Task 8, Task 9.
- Strong workspace paths: Task 5.
- Workspace ACL sharing: Task 1, Task 3, Task 4, Task 11.
- Session privacy: Task 1, Task 7, Task 13.
- Web UI tenant selection: Task 8, Task 9.
- Admin UI/API: Task 4, Task 10.
- API key and `/api/agent` exclusion: no tasks alter those routes.

Red-flag scan:

- No unresolved filler tokens are intentionally present.
- Every task has a concrete test command and expected result.

Type consistency:

- `tenantId`, `workspaceId`, `userId`, `accessRole`, and `providerSessionId` names are consistent across backend and frontend tasks.
- Database column names use snake_case; API payload fields use camelCase.
