import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureDefaultRootWorkspace } from './default-root-workspace.js';

test('tenant assignment creates default root workspace with invited username path', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'default-root-workspace-'));
  const previousRoot = process.env.WORKSPACES_ROOT;
  process.env.WORKSPACES_ROOT = workspaceRoot;

  try {
    const workspaces = [];
    const preinstallCalls = [];
    const multitenancy = {
      tenants: {
        getTenantById: (tenantId) => ({ id: tenantId, code: 'team', name: 'Team', status: 'active' }),
      },
      workspaces: {
        getWorkspaceByTenantSlug: ({ tenantId, ownerUserId, slug }) => workspaces.find((workspace) => (
          workspace.tenant_id === tenantId
          && workspace.owner_user_id === ownerUserId
          && workspace.slug === slug
        )) || null,
        createWorkspace: ({ tenantId, ownerUserId, slug, displayName, path: workspacePath }) => {
          const workspace = {
            id: workspaces.length + 1,
            tenant_id: tenantId,
            owner_user_id: ownerUserId,
            slug,
            display_name: displayName,
            path: workspacePath,
          };
          workspaces.push(workspace);
          return workspace;
        },
      },
    };
    const users = {
      getUserById: () => null,
      getUserByIdAnyStatus: (userId) => ({ id: userId, username: 'new-user', is_active: 0 }),
    };
    const workspaceMcpTools = {
      installPreinstalledWorkspaceMcpPresets: async (args) => {
        preinstallCalls.push(args);
        return { installed: [], errors: [] };
      },
    };

    const created = await ensureDefaultRootWorkspace({
      multitenancy,
      users,
      workspaceMcpTools,
      tenantId: 3,
      userId: 7,
    });
    const existing = await ensureDefaultRootWorkspace({
      multitenancy,
      users,
      workspaceMcpTools,
      tenantId: 3,
      userId: 7,
    });

    assert.equal(created.id, 1);
    assert.equal(existing.id, 1);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].path, path.join(workspaceRoot, 'team', 'new-user', 'workspace'));
    assert.equal(preinstallCalls.length, 1);
    assert.equal(preinstallCalls[0].workspaceId, 1);
  } finally {
    if (previousRoot == null) {
      delete process.env.WORKSPACES_ROOT;
    } else {
      process.env.WORKSPACES_ROOT = previousRoot;
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
