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
