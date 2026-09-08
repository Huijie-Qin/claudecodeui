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

function createRouter({ service, seenTenantIds = [] } = {}) {
  return createAdminRouter(
    {
      tenants: {
        listTenants: () => [],
        getTenantById: (tenantId) => {
          seenTenantIds.push(tenantId);
          return { id: tenantId, code: 'team', name: 'Team' };
        },
      },
      memberships: { upsertMembership: () => ({}) },
    },
    {
      listUsers: () => [],
      getUserById: (userId) => ({ id: userId, username: 'admin-user' }),
    },
    {
      listRuntimes: async () => ({ rows: [], total: 0, limit: 50, offset: 0 }),
      getSummary: async () => ({ total: 0 }),
      stopRuntime: async () => null,
    },
    { listAdminPresets: () => [] },
    { installPreinstalledWorkspaceMcpPresets: async () => ({ installed: [], errors: [] }) },
    { getOverview: () => ({}) },
    { listSubmissions: () => ({ rows: [], total: 0 }) },
    service,
  );
}

test('admin skill preset routes reject non-admin users', async () => {
  const router = createRouter({
    service: {
      listAdminPresets: () => [],
    },
  });

  const { response } = await requestJson(router, '/skill-presets?tenantId=2', {
    user: { id: 1, is_system_admin: 0 },
  });

  assert.equal(response.status, 403);
});

test('admin skill preset routes pass tenant and user context through to the service', async () => {
  const seen = {};
  const seenTenantIds = [];
  const router = createRouter({
    seenTenantIds,
    service: {
      searchMarketSkills: (args) => {
        seen.search = args;
        return { skills: [{ id: 'remote-code-reviewer', name: 'code-reviewer' }] };
      },
      listAdminPresets: ({ tenantId }) => {
        seen.list = { tenantId };
        return [{ id: 1, name: 'code-reviewer', displayName: 'Code Reviewer' }];
      },
      createPreset: ({ tenantId, userId, input, tenantCode, accountId }) => {
        seen.create = { tenantId, userId, input, tenantCode, accountId };
        return { id: 2, name: 'code-reviewer', displayName: 'Code Reviewer', status: 'draft' };
      },
      updatePreset: ({ tenantId, presetId, userId, input, tenantCode, accountId }) => {
        seen.update = { tenantId, presetId, userId, input, tenantCode, accountId };
        return { id: presetId, name: 'code-reviewer', displayName: 'Code Reviewer', status: 'draft' };
      },
      validatePreset: ({ tenantId, presetId, userId, tenantCode, accountId }) => {
        seen.validate = { tenantId, presetId, userId, tenantCode, accountId };
        return { preset: { id: presetId, lastValidationStatus: 'healthy' } };
      },
      publishPreset: ({ tenantId, presetId, userId }) => {
        seen.publish = { tenantId, presetId, userId };
        return { id: presetId, status: 'published' };
      },
      copyPresetToTenants: ({ tenantId, presetId, targetTenantIds, userId }) => {
        seen.copy = { tenantId, presetId, targetTenantIds, userId };
        return { summary: { total: targetTenantIds.length, created: 1, updated: 0, skipped: 0, failed: 0 } };
      },
      applyPresetToExistingWorkspaces: ({ tenantId, presetId, userId, tenantCode, overwrite }) => {
        seen.apply = { tenantId, presetId, userId, tenantCode, overwrite };
        return { summary: { total: 1, installed: 1, updated: 0, skipped: 0, failed: 0 } };
      },
      disablePreset: ({ tenantId, presetId, userId }) => {
        seen.disable = { tenantId, presetId, userId };
        return { id: presetId, status: 'disabled' };
      },
      deletePreset: ({ tenantId, presetId }) => {
        seen.delete = { tenantId, presetId };
        return true;
      },
    },
  });

  const market = await requestJson(router, '/skill-presets/market?tenantId=7&searchContent=review&page=2&pageSize=5&complete=true', {
    user: { id: 9, is_system_admin: 1 },
  });
  const list = await requestJson(router, '/skill-presets?tenantId=7');
  const created = await requestJson(router, '/skill-presets', {
    method: 'POST',
    body: {
      tenantId: 7,
      sourceRef: 'remote-code-reviewer',
    },
    user: { id: 9, is_system_admin: 1 },
  });
  const updated = await requestJson(router, '/skill-presets/2', {
    method: 'PUT',
    body: {
      tenantId: 7,
      sourceRef: 'remote-code-reviewer',
    },
    user: { id: 9, is_system_admin: 1 },
  });
  const validated = await requestJson(router, '/skill-presets/2/validate', {
    method: 'POST',
    body: { tenantId: 7 },
    user: { id: 9, is_system_admin: 1 },
  });
  const published = await requestJson(router, '/skill-presets/2/publish', {
    method: 'POST',
    body: { tenantId: 7 },
    user: { id: 9, is_system_admin: 1 },
  });
  const copied = await requestJson(router, '/skill-presets/2/copy', {
    method: 'POST',
    body: { tenantId: 7, targetTenantIds: [8] },
    user: { id: 9, is_system_admin: 1 },
  });
  const applied = await requestJson(router, '/skill-presets/2/apply', {
    method: 'POST',
    body: { tenantId: 7, overwrite: true },
    user: { id: 9, is_system_admin: 1 },
  });
  const disabled = await requestJson(router, '/skill-presets/2/disable', {
    method: 'POST',
    body: { tenantId: 7 },
    user: { id: 9, is_system_admin: 1 },
  });
  const deleted = await requestJson(router, '/skill-presets/2?tenantId=7', {
    method: 'DELETE',
    user: { id: 9, is_system_admin: 1 },
  });

  assert.equal(market.response.status, 200);
  assert.deepEqual(seen.search, {
    searchContent: 'review',
    page: 2,
    pageSize: 5,
    tenantCode: 'team',
    accountId: 'admin-user',
    completeInventory: true,
  });
  assert.equal(list.response.status, 200);
  assert.deepEqual(seen.list, { tenantId: 7 });
  assert.equal(created.response.status, 201);
  assert.equal(seen.create.userId, 9);
  assert.equal(seen.create.tenantCode, 'team');
  assert.equal(seen.create.accountId, 'admin-user');
  assert.equal(seen.create.input.sourceRef, 'remote-code-reviewer');
  assert.equal(seen.create.input.name, undefined);
  assert.equal(seen.create.input.displayName, undefined);
  assert.equal(updated.response.status, 200);
  assert.equal(seen.update.presetId, 2);
  assert.equal(seen.update.input.sourceRef, 'remote-code-reviewer');
  assert.equal(seen.update.input.displayName, undefined);
  assert.equal(validated.response.status, 200);
  assert.deepEqual(seen.validate, { tenantId: 7, presetId: 2, userId: 9, tenantCode: 'team', accountId: 'admin-user' });
  assert.equal(published.payload.preset.status, 'published');
  assert.deepEqual(seen.publish, { tenantId: 7, presetId: 2, userId: 9 });
  assert.equal(copied.response.status, 200);
  assert.deepEqual(seen.copy, { tenantId: 7, presetId: 2, targetTenantIds: [8], userId: 9 });
  assert.equal(applied.response.status, 200);
  assert.deepEqual(seen.apply, { tenantId: 7, presetId: 2, userId: 9, tenantCode: 'team', overwrite: true });
  assert.equal(disabled.payload.preset.status, 'disabled');
  assert.deepEqual(seen.disable, { tenantId: 7, presetId: 2, userId: 9 });
  assert.equal(deleted.payload.deleted, true);
  assert.deepEqual(seen.delete, { tenantId: 7, presetId: 2 });
  assert.deepEqual(seenTenantIds, [7, 7, 7, 7, 7]);
});
