import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import {
  createAdminClaudeEnvRouter,
  createPersonalClaudeEnvRouter,
} from './claude-env.js';

async function requestJson(router, path, {
  method = 'GET',
  body = null,
  user = { id: 7, username: 'alice', is_system_admin: 0 },
} = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
    app.use(router);
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: body == null ? undefined : { 'Content-Type': 'application/json' },
          body: body == null ? undefined : JSON.stringify(body),
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createService(overrides = {}) {
  return {
    listPersonal: () => [],
    updatePersonal: () => [],
    listTenant: () => [],
    updateTenant: () => [],
    updateTenants: () => [],
    listAllowlist: () => [],
    replaceAllowlist: () => [],
    listDenyRules: () => [],
    createDenyRule: (input) => ({ id: 1, ...input }),
    updateDenyRule: (id, patch) => ({ id, ...patch }),
    deleteDenyRule: () => true,
    resolveEffectiveEnv: () => ({ env: {}, sources: {}, blockedVariables: [] }),
    ...overrides,
  };
}

test('personal Claude env endpoints always use the authenticated user id', async () => {
  const calls = [];
  const service = createService({
    listPersonal: (userId) => [{ name: 'ANTHROPIC_MODEL', value: `model-${userId}`, encrypted: false }],
    listAllowlist: () => [{ name: 'ANTHROPIC_MODEL', maxLength: 256, enabled: true }],
    updatePersonal: (userId, mutation) => calls.push({ userId, mutation }),
  });
  const router = createPersonalClaudeEnvRouter({
    service,
    multitenancy: { memberships: { getActiveMembership: () => ({ status: 'active' }) } },
    users: { getEnvForUser: () => ({}) },
  });

  const update = await requestJson(router, '/personal', {
    method: 'PATCH',
    body: {
      userId: 999,
      upserts: [{ name: 'ANTHROPIC_MODEL', value: 'personal-model', encrypted: false }],
      deletes: [],
    },
    user: { id: 42, username: 'owner', is_system_admin: 0 },
  });

  assert.equal(update.response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 42);
  assert.equal(calls[0].mutation.actorUserId, 42);
  assert.equal(update.payload.restartRequired, true);
  assert.deepEqual(update.payload.allowlist, [{ name: 'ANTHROPIC_MODEL', maxLength: 256, enabled: true }]);
});

test('effective preview rejects a user without active tenant access', async () => {
  const router = createPersonalClaudeEnvRouter({
    service: createService(),
    multitenancy: { memberships: { getActiveMembership: () => null } },
    users: { getEnvForUser: () => ({}) },
  });

  const { response, payload } = await requestJson(router, '/effective?tenantId=3');

  assert.equal(response.status, 403);
  assert.equal(payload.code, 'TENANT_ACCESS_DENIED');
});

test('effective preview exposes source metadata without environment values', async () => {
  const service = createService({
    listPersonal: () => [{ name: 'ANTHROPIC_MODEL', configured: true, value: 'secret-model' }],
    listTenant: () => [{ name: 'TENANT_FLAG', configured: true, value: 'secret-flag' }],
    listAllowlist: () => [],
    resolveEffectiveEnv: () => ({
      env: { ANTHROPIC_MODEL: 'secret-model', TENANT_FLAG: 'secret-flag', DAS: 'base-value' },
      sources: {
        ANTHROPIC_MODEL: 'personal',
        TENANT_FLAG: 'tenant',
        DAS: 'baseEnv',
        LEGACY: 'adminUserEnv',
      },
      blockedVariables: [],
    }),
  });
  const router = createPersonalClaudeEnvRouter({
    service,
    multitenancy: { memberships: { getActiveMembership: () => ({ status: 'active' }) } },
    users: { getEnvForUser: () => ({ LEGACY: 'admin-secret' }) },
  });

  const { response, payload } = await requestJson(router, '/effective?tenantId=3');

  assert.equal(response.status, 200);
  assert.deepEqual(payload.variables, [
    { name: 'ANTHROPIC_MODEL', configured: true, source: 'personal' },
    { name: 'LEGACY', configured: true, source: 'admin_user' },
    { name: 'TENANT_FLAG', configured: true, source: 'tenant' },
  ]);
  assert.equal(JSON.stringify(payload).includes('secret-model'), false);
  assert.equal(JSON.stringify(payload).includes('secret-flag'), false);
  assert.equal(JSON.stringify(payload).includes('admin-secret'), false);
});

test('effective preview collapses case variants to the winning source', async () => {
  const service = createService({
    listPersonal: () => [{ name: 'layer_value', configured: true, encrypted: true }],
    listTenant: () => [{ name: 'LaYeR_VaLuE', configured: true, encrypted: false }],
    listAllowlist: () => [{ name: 'layer_value', maxLength: 256, enabled: true }],
    resolveEffectiveEnv: () => ({
      env: { layer_value: 'personal' },
      sources: { layer_value: 'personal' },
      blockedVariables: [],
    }),
  });
  const router = createPersonalClaudeEnvRouter({
    service,
    multitenancy: { memberships: { getActiveMembership: () => ({ status: 'active' }) } },
    users: { getEnvForUser: () => ({ LAYER_VALUE: 'admin' }) },
  });

  const { response, payload } = await requestJson(router, '/effective?tenantId=3');

  assert.equal(response.status, 200);
  assert.deepEqual(payload.variables, [{
    name: 'layer_value',
    configured: true,
    source: 'personal',
    encrypted: true,
  }]);
});

test('personal deny-rule overview hides historical rules and advertises retirement', async () => {
  const calls = [];
  const service = createService({
    listDenyRules: (filter) => {
      calls.push(filter);
      if (filter.ownerType === 'user') throw new Error('historical personal rules must not be listed');
      return [{ id: 3, ownerType: 'platform', matchType: 'exact', pattern: 'PLATFORM_ONLY' }];
    },
  });
  const router = createPersonalClaudeEnvRouter({ service });

  const { response, payload } = await requestJson(router, '/deny-rules');

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ ownerType: 'platform' }]);
  assert.deepEqual(payload.personalRules, []);
  assert.equal(payload.personalRulesSupported, false);
  assert.deepEqual(payload.platformRules, [
    { id: 3, ownerType: 'platform', matchType: 'exact', pattern: 'PLATFORM_ONLY' },
  ]);
  assert.equal(payload.builtInRules.length > 0, true);
});

test('personal deny-rule create and update endpoints return a stable 410 retirement error', async () => {
  let serviceCalled = false;
  const service = createService({
    listDenyRules: () => { serviceCalled = true; },
    createDenyRule: () => { serviceCalled = true; },
    updateDenyRule: () => { serviceCalled = true; },
  });
  const router = createPersonalClaudeEnvRouter({ service });

  const created = await requestJson(router, '/deny-rules', {
    method: 'POST',
    body: { matchType: 'suffix', pattern: '2_ToKeN' },
  });
  assert.equal(created.response.status, 410);
  assert.equal(created.payload.code, 'PERSONAL_DENY_RULES_DISABLED');

  const updated = await requestJson(router, '/deny-rules/12', {
    method: 'PATCH',
    body: { matchType: 'contains', pattern: '123' },
  });
  assert.equal(updated.response.status, 410);
  assert.equal(updated.payload.code, 'PERSONAL_DENY_RULES_DISABLED');
  assert.equal(serviceCalled, false);
});

test('personal deny-rule delete endpoint still removes an owned historical rule', async () => {
  const calls = [];
  const service = createService({
    listDenyRules: ({ ownerType, ownerUserId }) => (
      ownerType === 'user' && ownerUserId === 7
        ? [{ id: 12, ownerType: 'user', ownerUserId: 7, matchType: 'prefix', pattern: 'OLD_' }]
        : []
    ),
    deleteDenyRule: (id, ownership) => {
      calls.push({ id, ownership });
      return true;
    },
  });
  const router = createPersonalClaudeEnvRouter({ service });

  const { response, payload } = await requestJson(router, '/deny-rules/12', { method: 'DELETE' });

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { success: true });
  assert.deepEqual(calls, [{
    id: 12,
    ownership: { ownerType: 'user', ownerUserId: 7 },
  }]);
});

test('admin tenant environment overview lists every tenant with masked variables', async () => {
  const listedTenantIds = [];
  const service = createService({
    listTenant: (tenantId) => {
      listedTenantIds.push(tenantId);
      return [{ name: 'TENANT_SECRET', encrypted: true, configured: true }];
    },
  });
  const router = createAdminClaudeEnvRouter({
    service,
    multitenancy: {
      tenants: {
        listTenants: () => [
          {
            id: 5,
            code: 'active-tenant',
            name: 'Active Tenant',
            prod_code: 'prod-active',
            status: 'active',
          },
          { id: 7, code: 'disabled-tenant', name: 'Disabled Tenant', status: 'disabled' },
        ],
      },
    },
  });

  const { response, payload } = await requestJson(router, '/tenants/claude-env', {
    user: { id: 1, username: 'admin', is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(listedTenantIds, [5, 7]);
  assert.deepEqual(payload.tenants, [
    {
      tenantId: 5,
      code: 'active-tenant',
      name: 'Active Tenant',
      prodCode: 'prod-active',
      status: 'active',
      variables: [{ name: 'TENANT_SECRET', encrypted: true, configured: true }],
    },
    {
      tenantId: 7,
      code: 'disabled-tenant',
      name: 'Disabled Tenant',
      status: 'disabled',
      variables: [{ name: 'TENANT_SECRET', encrypted: true, configured: true }],
    },
  ]);
  assert.equal(JSON.stringify(payload).includes('secret-value'), false);
});

test('admin tenant batch endpoint deduplicates ids and passes one explicit mutation', async () => {
  const calls = [];
  const lookedUpTenantIds = [];
  const tenants = new Map([
    [5, { id: 5, code: 'tenant-five', name: 'Tenant Five', status: 'active' }],
    [7, { id: 7, code: 'tenant-seven', name: 'Tenant Seven', status: 'active' }],
  ]);
  const service = createService({
    updateTenants: (tenantIds, mutation) => calls.push({ tenantIds, mutation }),
    listTenant: (tenantId) => [{
      name: 'TENANT_SECRET',
      encrypted: true,
      configured: true,
      tenantId,
    }],
  });
  const router = createAdminClaudeEnvRouter({
    service,
    multitenancy: {
      tenants: {
        getTenantById: (tenantId) => {
          lookedUpTenantIds.push(tenantId);
          return tenants.get(tenantId) ?? null;
        },
      },
    },
  });

  const { response, payload } = await requestJson(router, '/tenants/claude-env', {
    method: 'PATCH',
    body: {
      tenantIds: [5, '7', 5],
      upserts: [{ name: 'TENANT_SECRET', value: 'secret-value', encrypted: true }],
      deletes: ['OLD_FLAG'],
    },
    user: { id: 9, username: 'admin', is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(lookedUpTenantIds, [5, 7]);
  assert.deepEqual(calls, [{
    tenantIds: [5, 7],
    mutation: {
      actorUserId: 9,
      upserts: [{ name: 'TENANT_SECRET', value: 'secret-value', encrypted: true }],
      deletes: ['OLD_FLAG'],
    },
  }]);
  assert.deepEqual(payload.tenants.map((entry) => entry.tenantId), [5, 7]);
  assert.equal(payload.restartRequired, true);
  assert.equal(JSON.stringify(payload).includes('secret-value'), false);
});

test('admin tenant batch endpoint validates every tenant before updating', async () => {
  let updated = false;
  let listed = false;
  const router = createAdminClaudeEnvRouter({
    service: createService({
      updateTenants: () => {
        updated = true;
      },
      listTenant: () => {
        listed = true;
        return [];
      },
    }),
    multitenancy: {
      tenants: {
        getTenantById: (tenantId) => tenantId === 5
          ? { id: 5, status: 'active' }
          : null,
      },
    },
  });

  const { response, payload } = await requestJson(router, '/tenants/claude-env', {
    method: 'PATCH',
    body: {
      tenantIds: [5, 999],
      upserts: [{ name: 'SHOULD_NOT_EXIST', value: 'value' }],
      deletes: [],
    },
    user: { id: 9, username: 'admin', is_system_admin: 1 },
  });

  assert.equal(response.status, 404);
  assert.equal(payload.code, 'TENANT_NOT_FOUND');
  assert.equal(updated, false);
  assert.equal(listed, false);
});

test('admin tenant batch endpoint rejects disabled tenants and malformed batches', async () => {
  let updateCount = 0;
  const router = createAdminClaudeEnvRouter({
    service: createService({
      updateTenants: () => {
        updateCount += 1;
      },
    }),
    multitenancy: {
      tenants: {
        getTenantById: (tenantId) => ({
          id: tenantId,
          status: tenantId === 7 ? 'disabled' : 'active',
        }),
      },
    },
  });
  const admin = { id: 9, username: 'admin', is_system_admin: 1 };
  const validMutation = { upserts: [], deletes: [] };

  const disabled = await requestJson(router, '/tenants/claude-env', {
    method: 'PATCH',
    body: { tenantIds: [5, 7], ...validMutation },
    user: admin,
  });
  assert.equal(disabled.response.status, 409);
  assert.equal(disabled.payload.code, 'TENANT_NOT_ACTIVE');

  const invalidBodies = [
    { tenantIds: [], ...validMutation },
    { tenantIds: [0], ...validMutation },
    {
      tenantIds: Array.from({ length: 501 }, () => 5),
      ...validMutation,
    },
    { tenantIds: [5], deletes: [] },
    { tenantIds: [5], upserts: [], deletes: {} },
  ];
  const expectedCodes = [
    'INVALID_TENANT_IDS',
    'INVALID_TENANT_IDS',
    'INVALID_TENANT_IDS',
    'INVALID_UPSERTS',
    'INVALID_DELETES',
  ];
  for (let index = 0; index < invalidBodies.length; index += 1) {
    const invalid = await requestJson(router, '/tenants/claude-env', {
      method: 'PATCH',
      body: invalidBodies[index],
      user: admin,
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, expectedCodes[index]);
  }
  assert.equal(updateCount, 0);
});

test('admin tenant endpoint uses an explicit patch with deletes', async () => {
  const calls = [];
  const service = createService({
    updateTenant: (tenantId, mutation) => calls.push({ tenantId, mutation }),
    listTenant: (tenantId) => [{ name: 'ANTHROPIC_MODEL', value: `tenant-${tenantId}`, encrypted: false }],
  });
  const router = createAdminClaudeEnvRouter({
    service,
    multitenancy: { tenants: { getTenantById: () => ({ id: 5, status: 'active' }) } },
  });

  const { response, payload } = await requestJson(router, '/tenants/5/claude-env', {
    method: 'PATCH',
    body: {
      upserts: [{ name: 'ANTHROPIC_MODEL', value: 'tenant-model', encrypted: false }],
      deletes: ['OLD_NAME'],
    },
    user: { id: 1, username: 'admin', is_system_admin: 1 },
  });

  assert.equal(response.status, 200);
  assert.equal(calls[0].tenantId, 5);
  assert.deepEqual(calls[0].mutation.deletes, ['OLD_NAME']);
  assert.equal(calls[0].mutation.actorUserId, 1);
  assert.equal(payload.restartRequired, true);
});

test('admin tenant endpoint rejects an unknown tenant before reading variables', async () => {
  let listed = false;
  const router = createAdminClaudeEnvRouter({
    service: createService({
      listTenant: () => {
        listed = true;
        return [];
      },
    }),
    multitenancy: { tenants: { getTenantById: () => null } },
  });

  const { response, payload } = await requestJson(router, '/tenants/999/claude-env', {
    user: { id: 1, username: 'admin', is_system_admin: 1 },
  });

  assert.equal(response.status, 404);
  assert.equal(payload.code, 'TENANT_NOT_FOUND');
  assert.equal(listed, false);
});

test('admin allowlist endpoint clears only for an explicit empty fields array', async () => {
  const calls = [];
  let fields = [{ name: 'CUSTOM_ALLOWED', maxLength: 256, enabled: true }];
  const service = createService({
    listAllowlist: () => fields,
    replaceAllowlist: (entries, options) => {
      if (!Array.isArray(entries)) {
        const error = new Error('Allowlist replacement requires an array');
        error.code = 'INVALID_ALLOWLIST';
        error.statusCode = 400;
        throw error;
      }
      calls.push({ entries, options });
      fields = entries;
      return fields;
    },
  });
  const router = createAdminClaudeEnvRouter({ service });
  const admin = { id: 1, username: 'admin', is_system_admin: 1 };

  const cleared = await requestJson(router, '/claude-env/personal-allowlist', {
    method: 'PUT',
    body: { fields: [] },
    user: admin,
  });
  assert.equal(cleared.response.status, 200);
  assert.deepEqual(cleared.payload.fields, []);
  assert.deepEqual(calls, [{ entries: [], options: { actorUserId: 1 } }]);

  fields = [{ name: 'STILL_PRESENT', maxLength: 128, enabled: true }];
  const missing = await requestJson(router, '/claude-env/personal-allowlist', {
    method: 'PUT',
    body: {},
    user: admin,
  });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.payload.code, 'INVALID_ALLOWLIST');
  assert.deepEqual(fields, [{ name: 'STILL_PRESENT', maxLength: 128, enabled: true }]);

  const invalid = await requestJson(router, '/claude-env/personal-allowlist', {
    method: 'PUT',
    body: { fields: {} },
    user: admin,
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, 'INVALID_ALLOWLIST');
  assert.deepEqual(fields, [{ name: 'STILL_PRESENT', maxLength: 128, enabled: true }]);
  assert.equal(calls.length, 1);
});
