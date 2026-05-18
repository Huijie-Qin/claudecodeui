import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(
  router,
  requestPath,
  { method = 'GET', body = null, user = { id: 1, is_system_admin: 1 } } = {},
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
        const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
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

function createFakeMultitenancy(workspaces) {
  return {
    tenants: {
      getTenantById: (tenantId) => ({ id: tenantId, code: 'team', name: 'Team', status: 'active' }),
      listTenants: () => [],
    },
    memberships: {
      upsertMembership: ({ tenantId, userId, role, permission, status }) => ({
        tenantId,
        userId,
        role,
        permission,
        status,
      }),
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
}

test('admin tenant activation preinstalls MCP presets only when creating the default workspace', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-default-workspace-'));
  const previousRoot = process.env.WORKSPACES_ROOT;
  process.env.WORKSPACES_ROOT = workspaceRoot;

  try {
    const workspaces = [];
    const preinstallCalls = [];
    const router = createAdminRouter(
      createFakeMultitenancy(workspaces),
      {
        getUserByIdAnyStatus: (userId) => ({ id: userId, username: 'new-user', is_active: 1 }),
        listUsers: () => [],
      },
      {
        listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
        getSummary: async () => ({ total: 0 }),
        stopRuntime: async () => null,
      },
      { listAdminPresets: () => [] },
      {
        installPreinstalledWorkspaceMcpPresets: async (args) => {
          preinstallCalls.push(args);
          return { installed: [{ name: 'knowledge' }], errors: [] };
        },
      },
    );

    const first = await requestJson(router, '/tenants/3/users/7', {
      method: 'PUT',
      body: { role: 'member', permission: 'edit', status: 'active' },
    });
    const second = await requestJson(router, '/tenants/3/users/7', {
      method: 'PUT',
      body: { role: 'member', permission: 'edit', status: 'active' },
    });

    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].path, path.join(workspaceRoot, 'team', 'new-user', 'workspace'));
    assert.equal(preinstallCalls.length, 1);
    assert.equal(preinstallCalls[0].workspaceId, 1);
    assert.equal(preinstallCalls[0].workspaceDisplayName, 'workspace');
  } finally {
    if (previousRoot == null) {
      delete process.env.WORKSPACES_ROOT;
    } else {
      process.env.WORKSPACES_ROOT = previousRoot;
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('admin tenant activation uses invited inactive username for default workspace path', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-invited-workspace-'));
  const previousRoot = process.env.WORKSPACES_ROOT;
  process.env.WORKSPACES_ROOT = workspaceRoot;

  try {
    const workspaces = [];
    const router = createAdminRouter(
      createFakeMultitenancy(workspaces),
      {
        getUserById: () => null,
        getUserByIdAnyStatus: (userId) => ({ id: userId, username: 'invited-user', is_active: 0 }),
        listUsers: () => [],
      },
      {
        listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
        getSummary: async () => ({ total: 0 }),
        stopRuntime: async () => null,
      },
      { listAdminPresets: () => [] },
      { installPreinstalledWorkspaceMcpPresets: async () => ({ installed: [], errors: [] }) },
    );

    const result = await requestJson(router, '/tenants/3/users/7', {
      method: 'PUT',
      body: { role: 'member', permission: 'edit', status: 'active' },
    });

    assert.equal(result.response.status, 200);
    assert.equal(workspaces[0].path, path.join(workspaceRoot, 'team', 'invited-user', 'workspace'));
  } finally {
    if (previousRoot == null) {
      delete process.env.WORKSPACES_ROOT;
    } else {
      process.env.WORKSPACES_ROOT = previousRoot;
    }
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
