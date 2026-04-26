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

test('admin router rejects non-admin users', async () => {
  const router = createAdminRouter({
    tenants: { listTenants: () => [] },
  });

  const { response } = await requestJson(router, '/tenants', {
    user: { id: 1, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
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
