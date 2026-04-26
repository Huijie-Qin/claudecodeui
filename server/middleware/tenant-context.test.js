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

  await middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 403);
});

test('tenant context grants system admins edit access to active tenants', async () => {
  const seen = {};
  const middleware = createTenantContextMiddleware({
    tenants: {
      getTenantById: () => ({ id: 2, status: 'active' }),
    },
    memberships: {
      getActiveMembership: () => null,
      upsertMembership: (membership) => {
        seen.membership = membership;
        return {
          tenant_id: membership.tenantId,
          user_id: membership.userId,
          role: membership.role,
          permission: membership.permission,
          status: membership.status,
        };
      },
    },
  });
  const req = { user: { id: 1, is_system_admin: 1 }, query: { tenantId: '2' }, headers: {}, url: '/api/projects' };
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

  await middleware(req, res, () => {
    calledNext = true;
  });

  assert.equal(calledNext, true);
  assert.deepEqual(seen.membership, {
    tenantId: 2,
    userId: 1,
    role: 'system_admin',
    permission: 'edit',
    status: 'active',
  });
  assert.equal(req.tenant.permission, 'edit');
});
