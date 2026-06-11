import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createTenantsRouter } from './tenants.js';
import { createAdminRouter } from './admin.js';
import { createWorkspacesRouter } from './workspaces.js';

async function requestJson(
  router,
  path,
  { method = 'GET', body = null, user = { id: 1, is_system_admin: 0 } } = {},
) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);

    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
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

test('tenants/me grants system admins access to all active tenants', async () => {
  const seen = {};
  const router = createTenantsRouter({
    tenants: {
      listTenants: () => [{ id: 2, code: 'acme', name: 'Acme', status: 'active' }],
    },
    memberships: {
      grantSystemAdminAccessToAllTenants: (userId) => {
        seen.userId = userId;
        return [{ tenant_id: 2, user_id: userId, role: 'system_admin', permission: 'edit', status: 'active' }];
      },
    },
    joinRequests: {
      createJoinRequest: () => ({}),
    },
  });

  const { response, payload } = await requestJson(router, '/me', {
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.userId, 7);
  assert.deepEqual(payload.tenants, [{
    id: 2,
    code: 'acme',
    name: 'Acme',
    status: 'active',
    role: 'system_admin',
    permission: 'edit',
  }]);
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

test('admin router returns 400 for invalid tenant creation input', async () => {
  const router = createAdminRouter({
    tenants: {
      createTenant: () => {
        throw new Error('code must use lowercase letters, numbers, and hyphens');
      },
    },
  });

  const { response, payload } = await requestJson(router, '/tenants', {
    method: 'POST',
    body: { code: 'Bad Code', name: 'Bad Code' },
    user: { id: 1, is_system_admin: 1 },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'code must use lowercase letters, numbers, and hyphens');
});

test('admin router grants creator access to newly created tenant', async () => {
  const seen = {};
  const router = createAdminRouter({
    tenants: {
      createTenant: () => ({ id: 5, code: 'team', name: 'Team', status: 'active' }),
    },
    memberships: {
      upsertMembership: (membership) => {
        seen.membership = membership;
        return membership;
      },
    },
  });

  const { response, payload } = await requestJson(router, '/tenants', {
    method: 'POST',
    body: { code: 'team', name: 'Team' },
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.equal(payload.tenant.id, 5);
  assert.deepEqual(seen.membership, {
    tenantId: 5,
    userId: 7,
    role: 'system_admin',
    permission: 'edit',
    status: 'active',
  });
});

test('admin router creates invited users and returns an invitation URL', async () => {
  const seen = {};
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {},
    },
    {
      createInvitedUser: ({ username, tokenHash, createdByUserId, expiresAt }) => {
        seen.invitation = { username, tokenHash, createdByUserId, expiresAt };
        return {
          user: { id: 12, username, is_active: 0, is_system_admin: 0 },
          invitation: { id: 1, user_id: 12, expires_at: expiresAt },
        };
      },
    },
  );

  const { response, payload } = await requestJson(router, '/users', {
    method: 'POST',
    body: { username: 'member' },
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.equal(payload.user.username, 'member');
  assert.match(payload.invitation.url, /^http:\/\/127\.0\.0\.1:\d+\/invite\/.+/);
  assert.equal(seen.invitation.username, 'member');
  assert.equal(seen.invitation.createdByUserId, 7);
  assert.equal(new RegExp(seen.invitation.tokenHash).test(payload.invitation.url), false);
});

test('admin router batch creates invited users with per-user results', async () => {
  const created = [];
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {},
    },
    {
      createInvitedUser: ({ username, tokenHash, createdByUserId, expiresAt }) => {
        if (username === 'taken') {
          const error = new Error('UNIQUE constraint failed: users.username');
          error.code = 'SQLITE_CONSTRAINT_UNIQUE';
          throw error;
        }

        created.push({ username, tokenHash, createdByUserId, expiresAt });
        return {
          user: { id: created.length + 10, username, is_active: 0, is_system_admin: 0 },
          invitation: { id: created.length, user_id: created.length + 10, expires_at: expiresAt },
        };
      },
    },
  );

  const { response, payload } = await requestJson(router, '/users/batch', {
    method: 'POST',
    body: { usernames: ['alice', 'taken', 'ALICE', 'bo'] },
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(payload.summary, { total: 3, succeeded: 1, failed: 2 });
  assert.deepEqual(payload.results.map((result) => result.username), ['alice', 'taken', 'bo']);
  assert.equal(payload.results[0].success, true);
  assert.match(payload.results[0].invitation.url, /^http:\/\/127\.0\.0\.1:\d+\/invite\/.+/);
  assert.equal(payload.results[1].success, false);
  assert.equal(payload.results[2].error, 'Username must be at least 3 characters');
  assert.deepEqual(created.map((entry) => entry.username), ['alice']);
});

test('admin router creates activation links for inactive users', async () => {
  const seen = {};
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {},
    },
    {
      createInvitationForUser: ({ userId, tokenHash, createdByUserId, expiresAt }) => {
        seen.invitation = { userId, tokenHash, createdByUserId, expiresAt };
        return {
          user: { id: userId, username: 'member', is_active: 0, is_system_admin: 0 },
          invitation: { id: 2, user_id: userId, expires_at: expiresAt },
        };
      },
    },
  );

  const { response, payload } = await requestJson(router, '/users/12/invitation', {
    method: 'POST',
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.equal(payload.user.username, 'member');
  assert.match(payload.invitation.url, /^http:\/\/127\.0\.0\.1:\d+\/invite\/.+/);
  assert.equal(seen.invitation.userId, 12);
  assert.equal(seen.invitation.createdByUserId, 7);
});

test('admin router creates password reset links for active users', async () => {
  const seen = {};
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {},
    },
    {
      createPasswordResetForUser: ({ userId, tokenHash, createdByUserId, expiresAt }) => {
        seen.passwordReset = { userId, tokenHash, createdByUserId, expiresAt };
        return {
          user: { id: userId, username: 'member', is_active: 1, is_system_admin: 0 },
          passwordReset: { id: 2, user_id: userId, expires_at: expiresAt },
        };
      },
    },
  );

  const { response, payload } = await requestJson(router, '/users/12/password-reset', {
    method: 'POST',
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.equal(payload.user.username, 'member');
  assert.match(payload.passwordReset.url, /^http:\/\/127\.0\.0\.1:\d+\/reset-password\/.+/);
  assert.equal(seen.passwordReset.userId, 12);
  assert.equal(seen.passwordReset.createdByUserId, 7);
  assert.equal(new RegExp(seen.passwordReset.tokenHash).test(payload.passwordReset.url), false);
});

test('admin router deletes users but rejects deleting the current account', async () => {
  const deleted = [];
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {},
    },
    {
      deleteUser: (userId) => {
        deleted.push(userId);
        return true;
      },
    },
  );

  const selfDelete = await requestJson(router, '/users/7', {
    method: 'DELETE',
    user: { id: 7, is_system_admin: 1 },
  });
  assert.equal(selfDelete.response.status, 400);

  const otherDelete = await requestJson(router, '/users/12', {
    method: 'DELETE',
    user: { id: 7, is_system_admin: 1 },
  });
  assert.equal(otherDelete.response.status, 200);
  assert.deepEqual(deleted, [12]);
});

test('admin router lists and deletes tenant access', async () => {
  const seen = {};
  const router = createAdminRouter({
    tenants: { listTenants: () => [] },
    memberships: {
      listMemberships: () => [{ tenant_id: 2, user_id: 12, permission: 'edit' }],
      deleteMembership: ({ tenantId, userId }) => {
        seen.deleted = { tenantId, userId };
        return true;
      },
    },
  });

  const listResult = await requestJson(router, '/memberships', {
    user: { id: 7, is_system_admin: 1 },
  });
  assert.equal(listResult.response.status, 200);
  assert.deepEqual(listResult.payload.memberships, [{ tenant_id: 2, user_id: 12, permission: 'edit' }]);

  const deleteResult = await requestJson(router, '/tenants/2/users/12', {
    method: 'DELETE',
    user: { id: 7, is_system_admin: 1 },
  });
  assert.equal(deleteResult.response.status, 200);
  assert.deepEqual(seen.deleted, { tenantId: 2, userId: 12 });
});

test('admin router returns platform analytics for system admins', async () => {
  const seen = {};
  const router = createAdminRouter(
    { tenants: { listTenants: () => [] }, memberships: {} },
    {},
    {},
    {},
    {},
    {
      getOverview: ({ days }) => {
        seen.days = days;
        return { days, overview: { totalUsers: 3 } };
      },
    },
  );

  const { response, payload } = await requestJson(router, '/analytics?days=7', {
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.days, 7);
  assert.deepEqual(payload.analytics, { days: 7, overview: { totalUsers: 3 } });
});

test('admin router validates platform analytics day window', async () => {
  const router = createAdminRouter(
    { tenants: { listTenants: () => [] }, memberships: {} },
    {},
    {},
    {},
    {},
    { getOverview: () => ({}) },
  );

  const { response, payload } = await requestJson(router, '/analytics?days=13', {
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'days must be one of: 7, 30, 90');
});

test('admin router batch grants tenant access for user and tenant selections', async () => {
  const seen = [];
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: {
        upsertMembership: (membership) => {
          seen.push(membership);
          return {
            tenant_id: membership.tenantId,
            user_id: membership.userId,
            role: membership.role,
            permission: membership.permission,
            status: membership.status,
          };
        },
      },
    },
    {
      getUserByIdAnyStatus: (userId) => ({ id: userId, username: `user-${userId}`, is_active: 1 }),
    },
    {
      listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
      getSummary: async () => ({ total: 0 }),
      stopRuntime: async () => null,
    },
    { listAdminPresets: () => [] },
    { installPreinstalledWorkspaceMcpPresets: async () => ({ installed: [], errors: [] }) },
  );

  const { response, payload } = await requestJson(router, '/tenant-users/batch', {
    method: 'PUT',
    body: { tenantIds: [2, 3, 2], userIds: [12, 13], permission: 'edit', status: 'inactive' },
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload.summary, { total: 4, succeeded: 4, failed: 0 });
  assert.deepEqual(seen.map(({ tenantId, userId }) => [tenantId, userId]), [
    [2, 12],
    [2, 13],
    [3, 12],
    [3, 13],
  ]);
  assert.equal(seen.every((membership) => membership.permission === 'edit'), true);
});

test('admin router reads and writes tenant sql check configuration', async () => {
  const seen = {};
  const router = createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: { upsertMembership: () => ({ status: 'active' }) },
      sqlCheck: {
        getTenantConfig: (tenantId) => ({ tenantId, ruleIds: ['require_where'] }),
        replaceTenantConfig: ({ tenantId, ruleIds }) => {
          seen.saved = { tenantId, ruleIds };
          return { tenantId, ruleIds };
        },
      },
    },
    { listUsers: () => [] },
    {
      listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
      getSummary: async () => ({ total: 0 }),
      stopRuntime: async () => null,
    },
    { listAdminPresets: () => [] },
    { installPreinstalledWorkspaceMcpPresets: async () => ({ installed: [], errors: [] }) },
  );

  const loaded = await requestJson(router, '/tenants/2/sql-check', {
    user: { id: 7, is_system_admin: 1 },
  });
  const saved = await requestJson(router, '/tenants/2/sql-check', {
    method: 'PUT',
    body: { ruleIds: ['limit_rows', 'no_select_star'] },
    user: { id: 7, is_system_admin: 1 },
  });

  assert.equal(loaded.response.status, 200);
  assert.deepEqual(loaded.payload, { tenantId: 2, ruleIds: ['require_where'] });
  assert.equal(saved.response.status, 200);
  assert.deepEqual(seen.saved, { tenantId: 2, ruleIds: ['limit_rows', 'no_select_star'] });
});

test('workspace share route lets owners replace ACL entries', async () => {
  const seen = {};
  const router = createWorkspacesRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'edit' };
      next();
    },
    access: {
      requireWorkspace: () => ({
        workspace: { id: 10, tenant_id: 2, owner_user_id: 1 },
        accessRole: 'owner',
      }),
    },
    multitenancy: {
      memberships: {
        getActiveMembership: () => ({ permission: 'edit' }),
      },
      workspaceAcl: {
        replaceAcl: (args) => {
          seen.replaceAcl = args;
          return args.entries;
        },
        listAcl: () => [],
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/share', {
    method: 'PUT',
    body: { entries: [{ userId: 3, permission: 'edit' }] },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload.acl, [{ userId: 3, permission: 'edit' }]);
  assert.equal(seen.replaceAcl.workspaceId, 10);
  assert.equal(seen.replaceAcl.ownerUserId, 1);
});

test('workspace sql check route resolves tenant config and stores user overrides', async () => {
  const seen = { access: [] };
  const config = {
    tenantId: 2,
    workspaceId: 10,
    userId: 1,
    tenantRuleIds: ['require_where'],
    customEnabled: false,
    userRuleIds: [],
    effectiveRuleIds: ['require_where'],
    source: 'tenant',
  };
  const router = createWorkspacesRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'view' };
      next();
    },
    access: {
      requireWorkspace: (args) => {
        seen.access.push(args);
        return {
          workspace: { id: 10, tenant_id: 2, owner_user_id: 1 },
          accessRole: 'view',
        };
      },
    },
    multitenancy: {
      sqlCheck: {
        resolveUserConfig: () => config,
        setUserPreference: (args) => {
          seen.saved = args;
          config.customEnabled = true;
          config.userRuleIds = args.ruleIds;
          config.effectiveRuleIds = args.ruleIds;
          config.source = 'user';
          return { customEnabled: true, ruleIds: args.ruleIds };
        },
      },
    },
  });

  const loaded = await requestJson(router, '/10/sql-check');
  const saved = await requestJson(router, '/10/sql-check', {
    method: 'PUT',
    body: { customEnabled: true, ruleIds: ['limit_rows'] },
  });

  assert.equal(loaded.response.status, 200);
  assert.deepEqual(loaded.payload.effectiveRuleIds, ['require_where']);
  assert.equal(saved.response.status, 200);
  assert.deepEqual(seen.saved, {
    tenantId: 2,
    workspaceId: 10,
    userId: 1,
    customEnabled: true,
    ruleIds: ['limit_rows'],
  });
  assert.equal(seen.access.every((args) => args.requireEdit !== true), true);
  assert.deepEqual(saved.payload.effectiveRuleIds, ['limit_rows']);
});
