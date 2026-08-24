import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, user = { id: 1, is_system_admin: 1 }) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, res, next) => {
      req.user = user;
      next();
    });
    app.use(router);
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter(scheduledTaskLogs) {
  return createAdminRouter(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    scheduledTaskLogs,
  );
}

test('scheduled task logs are restricted to system administrators', async () => {
  const router = createRouter({ list: () => ({ rows: [] }) });

  const { response, payload } = await requestJson(router, '/scheduled-task-logs', {
    id: 2,
    is_system_admin: 0,
  });

  assert.equal(response.status, 403);
  assert.equal(payload.error, 'System admin access required');
});

test('admin scheduled task logs route forwards filters and returns rows', async () => {
  let seenFilters = null;
  const expected = { rows: [{ id: 1, event: 'task_succeeded' }], total: 1 };
  const router = createRouter({
    list(filters) {
      seenFilters = filters;
      return expected;
    },
  });

  const { response, payload } = await requestJson(
    router,
    '/scheduled-task-logs?level=error&provider=claude&taskId=7&limit=25&offset=50',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(payload, expected);
  assert.deepEqual({ ...seenFilters }, {
    level: 'error',
    provider: 'claude',
    taskId: '7',
    limit: '25',
    offset: '50',
  });
});

test('admin scheduled task logs route sanitizes storage failures', async () => {
  const router = createRouter({
    list() {
      throw new Error('database credentials leaked');
    },
  });

  const { response, payload } = await requestJson(router, '/scheduled-task-logs');

  assert.equal(response.status, 500);
  assert.deepEqual(payload, { error: 'Failed to list scheduled task logs' });
});
