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
