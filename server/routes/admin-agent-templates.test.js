import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { method = 'GET', isSystemAdmin = true } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 9, username: 'admin-user', is_system_admin: isSystemAdmin ? 1 : 0 };
      next();
    });
    app.use(router);
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter({ agentTemplates, hookSkillCatalog, hookMcpCatalog }) {
  return createAdminRouter(
    { tenants: {}, memberships: {} },
    { getUserById: () => ({ id: 9, username: 'admin-user' }) },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    () => false,
    hookSkillCatalog,
    {},
    agentTemplates,
    hookMcpCatalog,
  );
}

test('Agent template details return folder metadata and require system admin access', async () => {
  const calls = [];
  const template = {
    id: 3,
    name: 'Folder template',
    claudeFolders: [{
      name: 'rules', directories: [],
      files: [{
        path: 'rule.md', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        storagePath: 'templates/3/folders/rules/rule.md',
      }],
    }],
  };
  const router = createRouter({
    agentTemplates: {
      getTemplate: (id) => { calls.push(id); return id === 3 ? template : null; },
    },
  });
  const result = await requestJson(router, '/agent-templates/3');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.template, template);
  assert.equal(Object.hasOwn(result.payload.template.claudeFolders[0].files[0], 'contentBase64'), false);
  assert.deepEqual(calls, [3]);
  assert.equal((await requestJson(router, '/agent-templates/4')).response.status, 404);
  assert.equal((await requestJson(router, '/agent-templates/invalid')).response.status, 400);
  const callCount = calls.length;
  assert.equal((await requestJson(router, '/agent-templates/3', { isSystemAdmin: false })).response.status, 403);
  assert.equal(calls.length, callCount);
});

test('Agent template Hook catalog passes tenant and current resource inventory to the service', async () => {
  const calls = [];
  const router = createRouter({
    agentTemplates: {
      listHookCatalog: (input) => {
        calls.push(input);
        return [{ id: 'hook-1', name: 'Hook 1', available: true }];
      },
    },
    hookSkillCatalog: {
      listConfigurationSkills: async () => ({
        skills: [{ skillId: 'builtin:notify', name: 'notify' }],
      }),
    },
    hookMcpCatalog: {
      listToolResources: () => [{ name: 'mcp__notify__send', mcpServerId: 'server-1' }],
    },
  });

  const { response, payload } = await requestJson(router, '/agent-templates/hook-catalog?tenantId=7');
  assert.equal(response.status, 200);
  assert.deepEqual(payload.hooks, [{ id: 'hook-1', name: 'Hook 1', available: true }]);
  assert.equal(calls[0].tenantId, 7);
  assert.deepEqual(calls[0].resourceCatalog, {
    skills: [{ skillId: 'builtin:notify', name: 'notify' }],
    mcpTools: [{ name: 'mcp__notify__send', mcpServerId: 'server-1' }],
  });
});

test('publishing an Agent template validates its Hook resources', async () => {
  let publishInput;
  const router = createRouter({
    agentTemplates: {
      publishTemplate: (input) => {
        publishInput = input;
        return { id: input.templateId, status: 'published' };
      },
    },
    hookSkillCatalog: { listConfigurationSkills: async () => ({ skills: [] }) },
    hookMcpCatalog: { listToolResources: () => [] },
  });

  const { response, payload } = await requestJson(router, '/agent-templates/3/publish', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(payload.template.status, 'published');
  assert.deepEqual(publishInput, {
    templateId: 3,
    userId: 9,
    hookResourceCatalog: { skills: [], mcpTools: [] },
  });
});
