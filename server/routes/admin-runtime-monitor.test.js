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
        const text = await response.text();
        let payload = null;
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = { raw: text };
        }
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter(runtimeMonitor) {
  return createAdminRouter({ tenants: { listTenants: () => [] } }, { listUsers: () => [] }, runtimeMonitor);
}

test('non-admin receives 403 for runtime monitor routes', async () => {
  const router = createRouter({
    listRuntimes: () => {
      throw new Error('should not list runtimes');
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes', {
    user: { id: 1, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
  assert.equal(payload.error, 'System admin access required');
});

test('GET /runtimes calls runtime monitor with parsed filters and returns result', async () => {
  const expected = {
    rows: [{ runtimeId: 'rt-1' }],
    total: 1,
    summary: { total: 1, active: 0 },
  };
  const seen = {};
  const router = createRouter({
    listRuntimes: async (filters) => {
      seen.filters = filters;
      return expected;
    },
  });

  const { response, payload } = await requestJson(
    router,
    '/runtimes?tenantId=2&userId=3&workspaceId=4&provider=claude&status=idle&dockerState=running&q=demo&limit=25&offset=50',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(payload, expected);
  assert.deepEqual(seen.filters, {
    tenantId: 2,
    userId: 3,
    workspaceId: 4,
    provider: 'claude',
    status: 'idle',
    dockerState: 'running',
    q: 'demo',
    limit: 25,
    offset: 50,
  });
});

test('GET /runtimes parses query-string pagination as numbers', async () => {
  const seen = {};
  const router = createRouter({
    listRuntimes: async (filters) => {
      seen.filters = filters;
      return { rows: [], total: 0, summary: { total: 0 } };
    },
  });

  const { response } = await requestJson(router, '/runtimes?status=idle&q=demo&limit=1&offset=1');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.filters, {
    status: 'idle',
    q: 'demo',
    limit: 1,
    offset: 1,
  });
});

test('GET /runtimes rejects invalid status without calling runtime monitor', async () => {
  let called = false;
  const router = createRouter({
    listRuntimes: async () => {
      called = true;
      return { rows: [], total: 0, summary: { total: 0 } };
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes?status=paused');

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Invalid runtime monitor filters');
  assert.equal(called, false);
});

test('GET /runtimes rejects invalid limit without calling runtime monitor', async () => {
  let called = false;
  const router = createRouter({
    listRuntimes: async () => {
      called = true;
      return { rows: [], total: 0, summary: { total: 0 } };
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes?limit=abc');

  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Invalid runtime monitor filters');
  assert.equal(called, false);
});

test('GET /runtimes returns sanitized 500 for runtime monitor failures', async () => {
  const router = createRouter({
    listRuntimes: async () => {
      throw new Error('database credentials leaked');
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes');

  assert.equal(response.status, 500);
  assert.deepEqual(payload, { error: 'Failed to list runtimes' });
});

test('GET /runtimes/summary returns runtime monitor summary', async () => {
  const summary = { total: 3, active: 1, idleRunning: 2 };
  const seen = {};
  const router = createRouter({
    getSummary: async (filters) => {
      seen.filters = filters;
      return summary;
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes/summary?provider=claude&limit=10');

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { summary });
  assert.deepEqual(seen.filters, {
    provider: 'claude',
    limit: 10,
  });
});

test('GET /runtimes/summary returns sanitized 500 for runtime monitor failures', async () => {
  const router = createRouter({
    getSummary: async () => {
      throw new Error('database credentials leaked');
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes/summary');

  assert.equal(response.status, 500);
  assert.deepEqual(payload, { error: 'Failed to load runtime summary' });
});

test('POST /runtimes/:runtimeId/stop passes runtime and admin user ids', async () => {
  const runtime = { runtimeId: 'rt-1', businessStatus: 'idle' };
  const seen = {};
  const router = createRouter({
    stopRuntime: async (args) => {
      seen.args = args;
      return runtime;
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes/rt-1/stop', {
    method: 'POST',
    user: { id: 42, is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { runtime });
  assert.deepEqual(seen.args, { runtimeId: 'rt-1', adminUserId: 42 });
});

test('POST /runtimes/:runtimeId/stop returns 404 when runtime is missing', async () => {
  const router = createRouter({
    stopRuntime: async () => null,
  });

  const { response, payload } = await requestJson(router, '/runtimes/missing/stop', {
    method: 'POST',
  });

  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Runtime not found');
});

test('POST /runtimes/:runtimeId/stop returns 503 for Docker-related errors', async () => {
  const router = createRouter({
    stopRuntime: async () => {
      const error = new Error('docker stop failed');
      error.code = 'DOCKER_UNAVAILABLE';
      throw error;
    },
  });

  const { response, payload } = await requestJson(router, '/runtimes/rt-1/stop', {
    method: 'POST',
  });

  assert.equal(response.status, 503);
  assert.equal(payload.error, 'docker stop failed');
});
