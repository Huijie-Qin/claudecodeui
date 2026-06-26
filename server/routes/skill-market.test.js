import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createSkillMarketRouter } from './skill-market.js';

const TEST_TENANT_CODE = 'tenant-code';
const TEST_USERNAME = 'test-user';

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
  getSkillMarketDetail,
  listSkillMarket,
  removeMarketSkill,
  requireWorkspace,
  downloadMarketSkill,
  getMarketSkillPublishPreview,
  publishMarketSkill,
  submitMarketSkill,
  tenants,
  users,
  viewMarketSkillFile,
} = {}) {
  return createSkillMarketRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2, permission: 'edit' };
      next();
    },
    access: {
      requireWorkspace: requireWorkspace || ((args) => ({
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/workspace' },
        accessRole,
      })),
    },
    tenants: tenants || {
      getTenantById: (tenantId) => ({ id: tenantId, code: TEST_TENANT_CODE, status: 'active' }),
    },
    users: users || {
      getUserById: (userId) => ({ id: userId, username: TEST_USERNAME }),
    },
    marketService: {
      listSkillMarket: listSkillMarket || (async () => [{ name: 'bug-hunter' }]),
      getSkillMarketDetail: getSkillMarketDetail || (async () => ({
        name: 'bug-hunter',
        imported: false,
        files: [{ path: 'SKILL.md', size: 12 }],
      })),
      viewMarketSkillFile: viewMarketSkillFile || (async () => ({
        skillId: 'bug-hunter',
        name: 'bug-hunter',
        file: { path: 'SKILL.md', content: '# Bug Hunter', size: 12 },
      })),
      downloadMarketSkill: downloadMarketSkill || (async () => ({ name: 'bug-hunter', imported: true })),
      submitMarketSkill: submitMarketSkill || (async () => ({
        skill: { name: 'bug-hunter', imported: true },
        submittedFileCount: 2,
        submittedAt: '2026-05-14T00:00:00.000Z',
      })),
      getMarketSkillPublishPreview: getMarketSkillPublishPreview || (async () => ({
        changes: [{ path: 'SKILL.md', status: 'modified', oldContent: '', newContent: '# Bug Hunter' }],
      })),
      publishMarketSkill: publishMarketSkill || submitMarketSkill || (async () => ({
        skill: { name: 'bug-hunter', imported: true },
        submittedFileCount: 2,
        publishedAt: '2026-05-14T00:00:00.000Z',
        publishedVersion: 2,
      })),
      removeMarketSkill: removeMarketSkill || (async () => ({ removed: 'bug-hunter' })),
    },
  });
}

test('GET /skills returns market inventory for view access', async () => {
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
    listSkillMarket: async (args) => {
      seen.listArgs = args;
      return {
        skills: [{ name: 'bug-hunter' }],
        pageInfo: { page: 1, pageSize: 20, hasNextPage: false },
        openApiRequestBody: {
          data: {
            hasPublishedVersion: true,
            searchContent: '',
          },
          pageInfo: {
            page: 1,
            pageSize: 20,
          },
        },
      };
    },
  });

  const { response, payload } = await requestJson(router, '/skills?tenantId=2&workspaceId=10');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.accessArgs, {
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    requireEdit: false,
  });
  assert.deepEqual(seen.listArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/view-workspace',
    searchContent: '',
    page: undefined,
    pageSize: undefined,
    currentUsername: TEST_USERNAME,
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
    includePageInfo: true,
  });
  assert.deepEqual(payload, {
    workspaceId: 10,
    accessRole: 'view',
    canManage: false,
    skills: [{ name: 'bug-hunter' }],
    pageInfo: { page: 1, pageSize: 20, hasNextPage: false },
    openApiRequestBody: {
      data: {
        hasPublishedVersion: true,
        searchContent: '',
      },
      pageInfo: {
        page: 1,
        pageSize: 20,
      },
    },
  });
});

test('GET /skills/:name returns skill detail without requiring edit access', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    getSkillMarketDetail: async (args) => {
      seen.detailArgs = args;
      return {
        name: 'bug-hunter',
        imported: true,
        files: [{ path: 'SKILL.md', size: 12 }],
      };
    },
  });

  const { response, payload } = await requestJson(router, '/skills/bug-hunter?tenantId=2&workspaceId=10');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.detailArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    name: 'bug-hunter',
    currentUsername: TEST_USERNAME,
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
  });
  assert.equal(payload.canManage, true);
  assert.deepEqual(payload.skill.files, [{ path: 'SKILL.md', size: 12 }]);
});

test('GET /skills/:name/files passes the selected file path to the view API', async () => {
  const seen = {};
  const router = createRouter({
    viewMarketSkillFile: async (args) => {
      seen.fileArgs = args;
      return {
        skillId: 'bug-hunter',
        name: 'bug-hunter',
        file: { path: 'references/checklist.md', content: '# Checklist', size: 11 },
      };
    },
  });

  const { response, payload } = await requestJson(
    router,
    '/skills/bug-hunter/files?tenantId=2&workspaceId=10&filePath=references%2Fchecklist.md',
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen.fileArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    name: 'bug-hunter',
    filePath: 'references/checklist.md',
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
  });
  assert.deepEqual(payload.file, { path: 'references/checklist.md', content: '# Checklist', size: 11 });
});

test('POST /skills/:name/download requires edit access and imports to Files', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    downloadMarketSkill: async (args) => {
      seen.downloadArgs = args;
      return { name: 'bug-hunter', imported: true };
    },
  });

  const { response, payload } = await requestJson(router, '/skills/bug-hunter/download?tenantId=2&workspaceId=10', {
    method: 'POST',
    body: {},
  });

  assert.equal(response.status, 201);
  assert.deepEqual(seen.downloadArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    name: 'bug-hunter',
    overwrite: false,
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
  });
  assert.deepEqual(payload.skill, { name: 'bug-hunter', imported: true });
});

test('POST /skills/:name/submit submits the complete imported skill', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'owner',
    publishMarketSkill: async (args) => {
      seen.submitArgs = args;
      return {
        skill: { name: 'bug-hunter', imported: true },
        submittedFileCount: 3,
        submittedAt: '2026-05-14T00:00:00.000Z',
      };
    },
  });

  const { response, payload } = await requestJson(router, '/skills/bug-hunter/submit?tenantId=2&workspaceId=10', {
    method: 'POST',
    body: {},
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.submitArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    name: 'bug-hunter',
    currentUsername: TEST_USERNAME,
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
  });
  assert.equal(payload.submittedFileCount, 3);
});

test('DELETE /skills/:name/import removes the imported runtime skill and refreshes inventory', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    removeMarketSkill: async (args) => {
      seen.removeArgs = args;
      return { removed: 'bug-hunter' };
    },
    listSkillMarket: async (args) => {
      seen.listArgs = args;
      return [{ name: 'bug-hunter' }];
    },
  });

  const { response, payload } = await requestJson(router, '/skills/bug-hunter/import?tenantId=2&workspaceId=10', {
    method: 'DELETE',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(seen.removeArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    name: 'bug-hunter',
  });
  assert.deepEqual(seen.listArgs, {
    workspaceId: 10,
    workspacePath: '/tmp/workspace',
    currentUsername: TEST_USERNAME,
    tenantCode: TEST_TENANT_CODE,
    accountId: TEST_USERNAME,
  });
  assert.equal(payload.removed, 'bug-hunter');
  assert.deepEqual(payload.skills, [{ name: 'bug-hunter' }]);
});

test('POST /skills/:name/download serializes view-only edit denial', async () => {
  const router = createRouter({
    requireWorkspace: () => {
      const error = new Error('Workspace edit access denied');
      error.statusCode = 403;
      throw error;
    },
  });

  const { response, payload } = await requestJson(router, '/skills/bug-hunter/download?tenantId=2&workspaceId=10', {
    method: 'POST',
    body: {},
  });

  assert.equal(response.status, 403);
  assert.deepEqual(payload, { error: 'Workspace edit access denied' });
});

test('management endpoints require edit access', async () => {
  const seen = {
    requireEditValues: [],
    downloadCalled: false,
    submitCalled: false,
    removeCalled: false,
  };
  const router = createRouter({
    requireWorkspace: (args) => {
      seen.requireEditValues.push(args.requireEdit);
      if (args.requireEdit) {
        const error = new Error('Workspace edit access denied');
        error.statusCode = 403;
        throw error;
      }
      return {
        workspace: { id: args.workspaceId, tenant_id: args.tenantId, path: '/tmp/view-workspace' },
        accessRole: 'view',
      };
    },
    downloadMarketSkill: async () => {
      seen.downloadCalled = true;
      return {};
    },
    submitMarketSkill: async () => {
      seen.submitCalled = true;
      return {};
    },
    removeMarketSkill: async () => {
      seen.removeCalled = true;
      return {};
    },
  });

  const requests = [
    ['/skills/bug-hunter/download?tenantId=2&workspaceId=10', { method: 'POST', body: {} }],
    ['/skills/bug-hunter/submit?tenantId=2&workspaceId=10', {
      method: 'POST',
      body: {},
    }],
    ['/skills/bug-hunter/import?tenantId=2&workspaceId=10', { method: 'DELETE' }],
  ];

  for (const [path, options] of requests) {
    const { response, payload } = await requestJson(router, path, options);
    assert.equal(response.status, 403);
    assert.deepEqual(payload, { error: 'Workspace edit access denied' });
  }

  assert.deepEqual(seen.requireEditValues, [true, true, true]);
  assert.equal(seen.downloadCalled, false);
  assert.equal(seen.submitCalled, false);
  assert.equal(seen.removeCalled, false);
});
