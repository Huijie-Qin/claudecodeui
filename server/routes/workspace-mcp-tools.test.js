import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createWorkspaceMcpToolsRouter } from './workspace-mcp-tools.js';

async function requestJson(
  router,
  path,
  { method = 'GET', body = null, user = { id: 7, is_system_admin: 0 } } = {},
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

function createRouter({
  accessRole = 'view',
  requireWorkspace,
  service,
} = {}) {
  return createWorkspaceMcpToolsRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'edit' };
      next();
    },
    access: {
      requireWorkspace: requireWorkspace || ((args) => ({
        workspace: {
          id: args.workspaceId,
          tenant_id: args.tenantId,
          path: '/tmp/workspace',
          display_name: 'Workspace',
        },
        accessRole,
      })),
    },
    mcpToolsService: service,
  });
}

test('GET /:workspaceId/mcp-tools returns catalog for view-only users', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'view',
    service: {
      listWorkspaceMcpPresetCatalog: (args) => {
        seen.catalogArgs = args;
        return {
          summary: { available: 1, installed: 0 },
          presets: [{ id: 1, name: 'knowledge', status: 'available' }],
        };
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/mcp-tools?tenantId=2');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.catalogArgs, {
    tenantId: 2,
    workspaceId: 10,
    accessRole: 'view',
  });
  assert.equal(payload.canManage, false);
  assert.deepEqual(payload.summary, { available: 1, installed: 0 });
});

test('POST /:workspaceId/mcp-tools/:presetId/install requires edit access', async () => {
  const router = createRouter({
    requireWorkspace: () => {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    },
    service: {
      installWorkspaceMcpPreset: async () => {
        throw new Error('should not be called');
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/mcp-tools/1/install?tenantId=2', {
    method: 'POST',
  });

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: 'Workspace edit access denied' });
});

test('POST /:workspaceId/mcp-tools/:presetId/install installs without a modal payload', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    service: {
      installWorkspaceMcpPreset: async (args) => {
        seen.installArgs = args;
        return {
          installed: {
            presetId: args.presetId,
            name: 'knowledge',
            status: 'installed',
            containerPath: '/workspace/.mcp.json',
          },
          summary: { available: 0, installed: 1 },
        };
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/mcp-tools/1/install?tenantId=2', {
    method: 'POST',
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.installArgs, {
    tenantId: 2,
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    workspaceDisplayName: 'Workspace',
    presetId: 1,
    userId: 7,
  });
  assert.equal(payload.installed.containerPath, '/workspace/.mcp.json');
});
