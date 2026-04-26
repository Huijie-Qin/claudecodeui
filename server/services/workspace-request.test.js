import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWorkspaceRequestResolver,
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
} from './workspace-request.js';

test('workspace request helpers read tenant, workspace, and user ids', () => {
  assert.equal(getRequestTenantId({ query: { tenantId: '2' }, headers: {} }), 2);
  assert.equal(getRequestTenantId({ query: {}, headers: { 'x-tenant-id': '3' } }), 3);
  assert.equal(getRequestWorkspaceId({ query: {}, body: { workspaceId: '4' }, params: {} }), 4);
  assert.equal(getRequestWorkspaceId({ query: {}, body: {}, params: { workspaceId: '5' } }), 5);
  assert.equal(getRequestUserId({ user: { userId: 6 } }), 6);
});

test('workspace request resolver delegates to workspace access service', () => {
  const seen = {};
  const resolveWorkspaceForRequest = createWorkspaceRequestResolver({
    requireWorkspace: (args) => {
      Object.assign(seen, args);
      return { workspace: { id: args.workspaceId, path: '/tmp/workspace' }, accessRole: 'edit' };
    },
  });

  const result = resolveWorkspaceForRequest(
    {
      query: { tenantId: '2' },
      body: { workspaceId: '10' },
      params: {},
      headers: {},
      user: { id: 7 },
    },
    { requireEdit: true },
  );

  assert.equal(result.workspace.path, '/tmp/workspace');
  assert.deepEqual(seen, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: true,
  });
});
