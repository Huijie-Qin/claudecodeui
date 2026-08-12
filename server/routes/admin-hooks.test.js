import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 9, username: 'admin-user', is_system_admin: 1 };
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

function createRouter({ hookConfigs, hookSkillMarket }) {
  return createAdminRouter(
    { tenants: {}, memberships: {} },
    { getUserById: () => ({ id: 9, username: 'admin-user' }) },
    {},
    {},
    {},
    {},
    {},
    {},
    hookConfigs,
    {},
    () => false,
    hookSkillMarket,
  );
}

test('Hook resources merge Skills from the public tenant market', async () => {
  const seen = {};
  const router = createRouter({
    hookConfigs: {
      getResources: () => ({
        events: ['Stop'],
        builtinTools: [],
        mcpTools: [],
        skills: [],
        environmentVariables: [],
      }),
    },
    hookSkillMarket: {
      listConfigurationSkills: async ({ accountId }) => {
        seen.accountId = accountId;
        return {
          skills: [{ skillId: 'skill-1', name: 'notify', displayName: 'Notify', description: '', version: 2 }],
          source: { configured: true, available: true, tenantId: 7 },
        };
      },
      getSource: () => ({ configured: true, available: false, tenantId: 7 }),
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/resources');
  assert.equal(response.status, 200);
  assert.equal(seen.accountId, 'admin-user');
  assert.equal(payload.skills[0].skillId, 'skill-1');
  assert.equal(payload.skillSource.tenantId, 7);
});

test('Hook resources remain available when the public tenant market fails', async () => {
  const router = createRouter({
    hookConfigs: {
      getResources: () => ({
        events: ['Stop'],
        builtinTools: [],
        mcpTools: [{ name: 'mcp__notify__send' }],
        skills: [],
        environmentVariables: [],
      }),
    },
    hookSkillMarket: {
      listConfigurationSkills: async () => { throw new Error('market offline'); },
      getSource: () => ({ configured: true, available: false, tenantId: 7 }),
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/resources');
  assert.equal(response.status, 200);
  assert.deepEqual(payload.skills, []);
  assert.equal(payload.mcpTools.length, 1);
  assert.equal(payload.skillSource.error, 'market offline');
});

test('publishing a Hook passes public-market-validated Skills to the configuration service', async () => {
  const seen = {};
  const draft = {
    id: 'hook-1',
    postActions: [{
      id: 'notify',
      type: 'invoke_skill',
      config: { skillId: 'skill-1', skillName: 'notify' },
    }],
  };
  const router = createRouter({
    hookConfigs: {
      getHook: () => draft,
      publishHook: (args) => {
        seen.publish = args;
        return { ...draft, status: 'published' };
      },
    },
    hookSkillMarket: {
      validateHookSkills: async (args) => {
        seen.validation = args;
        return [{ skillId: 'skill-1', name: 'notify' }];
      },
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/hook-1/publish', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(seen.validation.accountId, 'admin-user');
  assert.deepEqual(seen.publish.validatedSkills, [{ skillId: 'skill-1', name: 'notify' }]);
  assert.equal(payload.hook.status, 'published');
});
