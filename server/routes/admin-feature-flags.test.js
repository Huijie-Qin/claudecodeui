import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

function createFeatureFlags() {
  let enabled = false;
  return {
    getAll: () => ({ agentGraph: enabled }),
    setEnabled: (feature, value) => {
      assert.equal(feature, 'agentGraph');
      if (typeof value !== 'boolean') {
        const error = new Error('enabled must be a boolean');
        error.statusCode = 400;
        throw error;
      }
      enabled = value;
      return { agentGraph: enabled };
    },
  };
}

function createRouter(featureFlags, showExperimentalFeatures = true) {
  return createAdminRouter(
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    featureFlags,
    () => showExperimentalFeatures,
  );
}

async function requestJson(router, path, { admin = true, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 7, is_system_admin: admin ? 1 : 0 };
      next();
    });
    app.use(router);
    const server = app.listen(0, async () => {
      try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
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

test('feature flag administration is restricted to system admins', async () => {
  const { response, payload } = await requestJson(createRouter(createFeatureFlags()), '/feature-flags', {
    admin: false,
  });
  assert.equal(response.status, 403);
  assert.equal(payload.error, 'System admin access required');
});

test('system admin can enable the global Agent Graph feature flag', async () => {
  const router = createRouter(createFeatureFlags());
  const update = await requestJson(router, '/feature-flags/agent-graph', {
    method: 'PUT',
    body: { enabled: true },
  });
  assert.equal(update.response.status, 200);
  assert.deepEqual(update.payload.features, { agentGraph: true });

  const read = await requestJson(router, '/feature-flags');
  assert.deepEqual(read.payload.features, { agentGraph: true });
  assert.equal(read.payload.showExperimentalFeatures, true);
});

test('Agent Graph flag update requires a boolean value', async () => {
  const { response, payload } = await requestJson(createRouter(createFeatureFlags()), '/feature-flags/agent-graph', {
    method: 'PUT',
    body: { enabled: 'true' },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, 'enabled must be a boolean');
});

test('experimental feature settings are unavailable when the environment gate is disabled', async () => {
  const router = createRouter(createFeatureFlags(), false);

  const read = await requestJson(router, '/feature-flags');
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.showExperimentalFeatures, false);

  const update = await requestJson(router, '/feature-flags/agent-graph', {
    method: 'PUT',
    body: { enabled: true },
  });
  assert.equal(update.response.status, 404);
  assert.equal(update.payload.error, 'Experimental feature settings are disabled');
});
