import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(
  router,
  path,
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

async function requestFormData(
  router,
  path,
  { method = 'POST', formData, user = { id: 1, is_system_admin: 1 } } = {},
) {
  return new Promise((resolve, reject) => {
    const app = express();
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
          body: formData,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter({ service } = {}) {
  return createAdminRouter(
    {
      tenants: { listTenants: () => [] },
      memberships: { upsertMembership: () => ({}) },
    },
    { listUsers: () => [] },
    {
      listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
      getSummary: async () => ({ total: 0 }),
      stopRuntime: async () => null,
    },
    service,
  );
}

test('admin mcp preset routes reject non-admin users', async () => {
  const router = createRouter({
    service: {
      listAdminPresets: () => [],
    },
  });

  const { response } = await requestJson(router, '/mcp-presets?tenantId=2', {
    user: { id: 1, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
});

test('admin mcp preset routes create and publish presets through the service', async () => {
  const seen = {};
  const router = createRouter({
    service: {
      listAdminPresets: ({ tenantId }) => {
        seen.list = { tenantId };
        return [{ id: 1, name: 'knowledge', displayName: 'Knowledge MCP' }];
      },
      createPreset: ({ tenantId, userId, input }) => {
        seen.create = { tenantId, userId, input };
        return { id: 2, name: input.name, displayName: input.displayName, status: 'draft' };
      },
      publishPreset: ({ tenantId, presetId, userId }) => {
        seen.publish = { tenantId, presetId, userId };
        return { id: presetId, status: 'published' };
      },
      testPreset: ({ tenantId, presetId, userId, input }) => {
        seen.test = { tenantId, presetId, userId, input };
        return {
          id: presetId,
          status: 'draft',
          lastTestStatus: 'failed',
          toolCount: 0,
          transient: true,
          probe: { status: 'failed' },
        };
      },
    },
  });

  const list = await requestJson(router, '/mcp-presets?tenantId=7');
  const created = await requestJson(router, '/mcp-presets', {
    method: 'POST',
    body: {
      tenantId: 7,
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      type: 'http',
      url: 'https://mcp.internal/knowledge',
    },
    user: { id: 9, is_system_admin: 1 },
  });
  const published = await requestJson(router, '/mcp-presets/2/publish', {
    method: 'POST',
    body: { tenantId: 7 },
    user: { id: 9, is_system_admin: 1 },
  });
  const tested = await requestJson(router, '/mcp-presets/2/test', {
    method: 'POST',
    body: {
      tenantId: 7,
      name: 'knowledge',
      displayName: 'Knowledge MCP',
      type: 'http',
      url: 'https://mcp.internal/broken',
    },
    user: { id: 9, is_system_admin: 1 },
  });

  assert.equal(list.response.status, 200);
  assert.deepEqual(seen.list, { tenantId: 7 });
  assert.equal(created.response.status, 201);
  assert.equal(seen.create.userId, 9);
  assert.equal(seen.create.input.url, 'https://mcp.internal/knowledge');
  assert.equal(published.response.status, 200);
  assert.deepEqual(seen.publish, { tenantId: 7, presetId: 2, userId: 9 });
  assert.equal(published.payload.preset.status, 'published');
  assert.equal(tested.response.status, 200);
  assert.equal(tested.payload.transient, true);
  assert.equal(seen.test.input.url, 'https://mcp.internal/broken');
});

test('admin mcp preset routes upload helper scripts through the service', async () => {
  const seen = {};
  const router = createRouter({
    service: {
      uploadHelperScript: ({ tenantId, presetId, userId, originalName, content }) => {
        seen.upload = { tenantId, presetId, userId, originalName, content };
        return {
          id: presetId,
          helperScript: {
            fileName: originalName,
            sizeBytes: Buffer.byteLength(content, 'utf8'),
            sha256: 'abc123',
          },
        };
      },
    },
  });
  const formData = new FormData();
  formData.set('tenantId', '7');
  formData.set('script', new Blob(['print("secret")\n'], { type: 'text/x-python' }), 'auth.py');

  const { response, payload } = await requestFormData(router, '/mcp-presets/2/helper-script', {
    formData,
    user: { id: 9, is_system_admin: 1 },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.upload, {
    tenantId: 7,
    presetId: 2,
    userId: 9,
    originalName: 'auth.py',
    content: 'print("secret")\n',
  });
  assert.deepEqual(payload.preset.helperScript, {
    fileName: 'auth.py',
    sizeBytes: 16,
    sha256: 'abc123',
  });
});
