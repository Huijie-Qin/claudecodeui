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
