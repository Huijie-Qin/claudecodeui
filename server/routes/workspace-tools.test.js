import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createWorkspaceToolsRouter } from './workspace-tools.js';

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
  listWorkspaceTools,
  previewWorkspaceMcpJsonImport,
  probeWorkspaceMcpServer,
  removeWorkspaceMcpServer,
  requireWorkspace,
  upsertWorkspaceMcpServer,
} = {}) {
  return createWorkspaceToolsRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'edit' };
      next();
    },
    access: {
      requireWorkspace: requireWorkspace || (() => ({
        workspace: { id: 10, tenant_id: 2, path: '/tmp/workspace' },
        accessRole,
      })),
    },
    toolsService: {
      listWorkspaceTools: listWorkspaceTools || (async () => ({
        tools: [],
        mcpServers: [],
        summary: {
          total: 0,
          builtin: 0,
          httpMcp: 0,
          healthy: 0,
          needsValue: 0,
          unsupported: 0,
          blocked: 0,
        },
      })),
      probeWorkspaceMcpServer: probeWorkspaceMcpServer || (async () => ({
        status: 'healthy',
        phase: 'tools_list',
        toolCount: 1,
        tools: [{ name: 'lookup' }],
      })),
      upsertWorkspaceMcpServer: upsertWorkspaceMcpServer || (async () => ({
        savedAsDraft: false,
        server: { name: 'docs', status: 'healthy' },
        probe: { status: 'healthy' },
      })),
      removeWorkspaceMcpServer: removeWorkspaceMcpServer || (async () => ({
        removed: true,
        name: 'docs',
      })),
      previewWorkspaceMcpJsonImport: previewWorkspaceMcpJsonImport || (async () => ({
        entries: [],
        summary: { total: 0, ready: 0, needsValue: 0, unsupported: 0, invalid: 0, conflicts: 0 },
      })),
    },
  });
}

test('GET /:workspaceId/tools returns inventory for view-only workspace access', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'view',
    requireWorkspace: (args) => {
      seen.accessArgs = args;
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/view-workspace' },
        accessRole: 'view',
      };
    },
    listWorkspaceTools: async (workspacePath, options) => {
      seen.workspacePath = workspacePath;
      seen.options = options;
      return {
        tools: [{ name: 'read', type: 'builtin', status: 'read_only' }],
        mcpServers: [],
        summary: { total: 1, builtin: 1, httpMcp: 0, healthy: 0, needsValue: 0, unsupported: 0, blocked: 0 },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/10/tools?tenantId=2');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: false,
  });
  assert.equal(seen.workspacePath, '/tmp/view-workspace');
  assert.deepEqual(seen.options, { accessRole: 'view' });
  assert.equal(payload.canManage, false);
  assert.equal(payload.tools[0].status, 'read_only');
});

test('POST /:workspaceId/tools/mcp/probe requires edit access and returns structured probe result', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => {
      seen.accessArgs = args;
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/edit-workspace' },
        accessRole: 'edit',
      };
    },
    probeWorkspaceMcpServer: async (args) => {
      seen.probeArgs = args;
      return { status: 'healthy', phase: 'tools_list', toolCount: 1, tools: [{ name: 'lookup' }] };
    },
  });

  const { response, payload } = await requestJson(router, '/10/tools/mcp/probe?tenantId=2', {
    method: 'POST',
    body: { name: 'docs', type: 'http', url: 'http://127.0.0.1:9000/mcp' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: true,
  });
  assert.deepEqual(seen.probeArgs, {
    workspacePath: '/tmp/edit-workspace',
    server: { name: 'docs', type: 'http', url: 'http://127.0.0.1:9000/mcp' },
  });
  assert.equal(payload.probe.status, 'healthy');
});

test('POST /:workspaceId/tools/mcp writes a connected server and returns refreshed inventory', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'owner',
    requireWorkspace: (args) => ({
      workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/owner-workspace' },
      accessRole: 'owner',
    }),
    upsertWorkspaceMcpServer: async (args) => {
      seen.upsertArgs = args;
      return {
        savedAsDraft: false,
        server: { name: 'docs', status: 'healthy' },
        probe: { status: 'healthy', toolCount: 1 },
      };
    },
    listWorkspaceTools: async (workspacePath, options) => {
      seen.listArgs = { workspacePath, options };
      return {
        tools: [{ name: 'docs', type: 'mcp', status: 'healthy' }],
        mcpServers: [{ name: 'docs', status: 'healthy' }],
        summary: { total: 1, builtin: 0, httpMcp: 1, healthy: 1, needsValue: 0, unsupported: 0, blocked: 0 },
      };
    },
  });

  const body = { name: 'docs', type: 'http', url: 'https://docs.example.com/mcp' };
  const { response, payload } = await requestJson(router, '/10/tools/mcp?tenantId=2', {
    method: 'POST',
    body,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.upsertArgs, {
    workspacePath: '/tmp/owner-workspace',
    server: body,
  });
  assert.deepEqual(seen.listArgs, {
    workspacePath: '/tmp/owner-workspace',
    options: { accessRole: 'owner' },
  });
  assert.equal(payload.savedAsDraft, false);
  assert.equal(payload.summary.healthy, 1);
});

test('POST /:workspaceId/tools/mcp returns 202 when values are saved as a draft', async () => {
  const router = createRouter({
    accessRole: 'edit',
    upsertWorkspaceMcpServer: async () => ({
      savedAsDraft: true,
      server: { name: 'draft-docs', status: 'needs_value', missingValues: ['url'] },
      probe: null,
    }),
  });

  const { response, payload } = await requestJson(router, '/10/tools/mcp?tenantId=2', {
    method: 'POST',
    body: { name: 'draft-docs', type: 'http', url: '' },
  });

  assert.equal(response.status, 202);
  assert.equal(payload.savedAsDraft, true);
  assert.equal(payload.server.status, 'needs_value');
});

test('DELETE /:workspaceId/tools/mcp/:name removes config and returns refreshed inventory', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    removeWorkspaceMcpServer: async (args) => {
      seen.removeArgs = args;
      return { removed: true, name: 'docs' };
    },
  });

  const { response, payload } = await requestJson(router, '/10/tools/mcp/docs?tenantId=2', {
    method: 'DELETE',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.removeArgs, {
    workspacePath: '/tmp/workspace',
    name: 'docs',
  });
  assert.deepEqual(payload.removed, { removed: true, name: 'docs' });
});

test('POST /:workspaceId/tools/mcp/import-preview returns independent import classifications', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    previewWorkspaceMcpJsonImport: async (args) => {
      seen.previewArgs = args;
      return {
        entries: [{ name: 'docs', status: 'ready' }],
        summary: { total: 1, ready: 1, needsValue: 0, unsupported: 0, invalid: 0, conflicts: 0 },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/10/tools/mcp/import-preview?tenantId=2', {
    method: 'POST',
    body: { json: '{"mcpServers":{"docs":{"type":"http","url":"https://docs.example.com/mcp"}}}' },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.previewArgs.workspacePath, '/tmp/workspace');
  assert.equal(payload.preview.summary.ready, 1);
});

test('write routes serialize view-only edit denial', async () => {
  const router = createRouter({
    requireWorkspace: () => {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    },
  });

  const { response, payload } = await requestJson(router, '/10/tools/mcp/probe?tenantId=2', {
    method: 'POST',
    body: { name: 'docs', type: 'http', url: 'https://docs.example.com/mcp' },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: 'Workspace edit access denied' });
});
