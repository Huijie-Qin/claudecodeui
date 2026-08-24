import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { method = 'GET', body } = {}) {
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
        const isFormData = body instanceof FormData;
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          body: body && !isFormData && typeof body !== 'string' ? JSON.stringify(body) : body,
          headers: body && !isFormData ? { 'content-type': 'application/json' } : undefined,
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
  hookConfigs,
  hookSkillMarket,
  hookMcpCatalog = { listServers: () => [] },
}) {
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
    undefined,
    undefined,
    hookMcpCatalog,
  );
}

test('Hook resources expose only built-in Hook Skills', async () => {
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
      listConfigurationSkills: async () => ({
        skills: [{
          skillId: 'builtin:hook-notification',
          name: 'hook-notification',
          displayName: 'Hook Notification (Mock)',
          description: '',
          version: 1,
        }],
        source: { type: 'builtin', available: true },
      }),
      getSource: () => ({ type: 'builtin', available: true }),
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/resources');
  assert.equal(response.status, 200);
  assert.equal(payload.skills[0].skillId, 'builtin:hook-notification');
  assert.deepEqual(payload.skillSource, { type: 'builtin', available: true });
  assert.deepEqual(payload.hookMcpServers, []);
  assert.deepEqual(payload.hookMcpSource, { type: 'builtin', available: true });
});

test('Hook resources remain available when the built-in Skill catalog fails', async () => {
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
      listConfigurationSkills: async () => { throw new Error('catalog unavailable'); },
      getSource: () => ({ type: 'builtin', available: true }),
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/resources');
  assert.equal(response.status, 200);
  assert.deepEqual(payload.skills, []);
  assert.equal(payload.mcpTools.length, 1);
  assert.equal(payload.skillSource.error, 'catalog unavailable');
});

test('Hook MCP routes create, update, test, and delete managed Hook servers', async () => {
  const calls = [];
  let servers = [];
  const hookMcpCatalog = {
    listServers: () => servers,
    createServer: (input) => {
      calls.push(['create', input]);
      const server = { name: input.input.name, displayName: input.input.displayName };
      servers = [server];
      return server;
    },
    updateServer: (input) => {
      calls.push(['update', input]);
      const server = { name: input.serverName, displayName: input.input.displayName };
      servers = [server];
      return server;
    },
    testServer: async (input) => {
      calls.push(['test', input]);
      const server = { ...servers[0], lastTestStatus: 'healthy', toolCount: 1 };
      servers = [server];
      return server;
    },
    uploadHelperScript: (input) => {
      calls.push(['upload-helper', input]);
      const server = {
        ...servers[0],
        helperScript: { fileName: input.originalName, sizeBytes: Buffer.byteLength(input.content) },
      };
      servers = [server];
      return server;
    },
    deleteHelperScript: (input) => {
      calls.push(['delete-helper', input]);
      const server = { ...servers[0], helperScript: null };
      servers = [server];
      return server;
    },
    deleteServer: (input) => {
      calls.push(['delete', input]);
      const server = servers[0];
      servers = [];
      return server;
    },
  };
  const router = createRouter({ hookConfigs: {}, hookSkillMarket: {}, hookMcpCatalog });

  const created = await requestJson(router, '/hooks/mcp-servers', {
    method: 'POST',
    body: {
      name: 'notify',
      displayName: 'Notify',
      url: 'https://notify.example.com/mcp',
      headersHelper: 'python3 /opt/hook-mcp/notify_headers.py',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.server.name, 'notify');

  const updated = await requestJson(router, '/hooks/mcp-servers/notify', {
    method: 'PUT',
    body: { displayName: 'Notification MCP', url: 'https://notify.example.com/v2/mcp' },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.server.displayName, 'Notification MCP');

  const helperForm = new FormData();
  helperForm.set('script', new Blob(['print("secret")\n'], { type: 'text/x-python' }), 'auth.py');
  const helperUploaded = await requestJson(router, '/hooks/mcp-servers/notify/helper-script', {
    method: 'POST',
    body: helperForm,
  });
  assert.equal(helperUploaded.response.status, 201);
  assert.equal(helperUploaded.payload.server.helperScript.fileName, 'auth.py');

  const helperDeleted = await requestJson(router, '/hooks/mcp-servers/notify/helper-script', { method: 'DELETE' });
  assert.equal(helperDeleted.response.status, 200);
  assert.equal(helperDeleted.payload.server.helperScript, null);

  const tested = await requestJson(router, '/hooks/mcp-servers/notify/test', { method: 'POST' });
  assert.equal(tested.response.status, 200);
  assert.equal(tested.payload.server.lastTestStatus, 'healthy');

  const deleted = await requestJson(router, '/hooks/mcp-servers/notify', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.payload.hookMcpServers, []);
  assert.deepEqual(calls.map(([operation]) => operation), [
    'create',
    'update',
    'upload-helper',
    'delete-helper',
    'test',
    'delete',
  ]);
  assert.equal(calls[0][1].userId, 9);
  assert.equal(calls[0][1].input.headersHelper, 'python3 /opt/hook-mcp/notify_headers.py');
  assert.equal(calls[1][1].serverName, 'notify');
  assert.deepEqual(calls[2][1], {
    serverName: 'notify',
    userId: 9,
    originalName: 'auth.py',
    content: 'print("secret")\n',
  });
});

test('Hook diagnostics routes expose global lists and execution details', async () => {
  const seen = {};
  const execution = { id: 'execution-1', diagnostics: { outcome: 'failed' } };
  const page = { executions: [execution], total: 1, executionTotal: 1, limit: 20, offset: 10 };
  const router = createRouter({
    hookConfigs: {
      listAllExecutionPage: (filters) => {
        seen.filters = filters;
        return page;
      },
      getExecution: (executionId) => executionId === execution.id ? execution : null,
    },
    hookSkillMarket: {},
  });

  const listed = await requestJson(
    router,
    '/hook-executions?eventName=PreToolUse&status=failed&userId=2&sessionId=s1&toolUseId=t1&q=bash&bindingController=admin&outcome=failed&limit=20&offset=10',
  );
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.payload, page);
  assert.deepEqual(seen.filters, {
    hookId: undefined,
    eventName: 'PreToolUse',
    status: 'failed',
    userId: '2',
    sessionId: 's1',
    toolUseId: 't1',
    q: 'bash',
    bindingController: 'admin',
    outcome: 'failed',
    limit: '20',
    offset: '10',
  });

  const detail = await requestJson(router, '/hook-executions/execution-1');
  assert.equal(detail.response.status, 200);
  assert.deepEqual(detail.payload.execution, execution);
  const missing = await requestJson(router, '/hook-executions/missing');
  assert.equal(missing.response.status, 404);
});

test('Hook Skill upload accepts an admin folder and returns the refreshed catalog', async () => {
  const seen = {};
  const uploadedSkill = {
    skillId: 'builtin:uploaded-notifier',
    name: 'uploaded-notifier',
    displayName: 'uploaded-notifier',
    description: 'Uploaded notifier',
    version: 1,
  };
  const router = createRouter({
    hookConfigs: {},
    hookSkillMarket: {
      uploadBuiltinSkill: async (input) => {
        seen.input = input;
        return uploadedSkill;
      },
      listConfigurationSkills: async () => ({
        skills: [uploadedSkill],
        source: { type: 'builtin', available: true },
      }),
    },
  });
  const formData = new FormData();
  formData.append('files', new Blob([
    '---\nname: uploaded-notifier\ndescription: Uploaded notifier\n---\nNotify the user.\n',
  ], { type: 'application/octet-stream' }), 'SKILL.md');
  formData.append('files', new Blob(['console.log("notify");\n'], {
    type: 'application/javascript',
  }), 'notify.js');
  formData.set('paths', JSON.stringify([
    'uploaded-notifier/SKILL.md',
    'uploaded-notifier/scripts/notify.js',
  ]));

  const { response, payload } = await requestJson(router, '/hooks/skills', {
    method: 'POST',
    body: formData,
  });

  assert.equal(response.status, 201);
  assert.equal(seen.input.files.length, 2);
  assert.equal(seen.input.files[0].relativePath, 'uploaded-notifier/SKILL.md');
  assert.match(seen.input.files[0].buffer.toString('utf8'), /name: uploaded-notifier/);
  assert.equal(seen.input.files[1].relativePath, 'uploaded-notifier/scripts/notify.js');
  assert.equal(seen.input.userId, 9);
  assert.deepEqual(payload.skill, uploadedSkill);
  assert.deepEqual(payload.skills, [uploadedSkill]);
});

test('Hook Skill delete removes an admin upload and returns the refreshed catalog', async () => {
  const seen = {};
  const uploadedSkill = {
    skillId: 'builtin:uploaded-notifier',
    name: 'uploaded-notifier',
    displayName: 'uploaded-notifier',
    description: 'Uploaded notifier',
    version: 1,
  };
  const router = createRouter({
    hookConfigs: {},
    hookSkillMarket: {
      deleteBuiltinSkill: async (input) => {
        seen.input = input;
        return uploadedSkill;
      },
      listConfigurationSkills: async () => ({
        skills: [],
        source: { type: 'builtin', available: true },
      }),
    },
  });

  const { response, payload } = await requestJson(
    router,
    '/hooks/skills/builtin%3Auploaded-notifier',
    { method: 'DELETE' },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen.input, { skillId: 'builtin:uploaded-notifier', userId: 9 });
  assert.deepEqual(payload.skill, uploadedSkill);
  assert.deepEqual(payload.skills, []);
});

test('publishing a Hook passes built-in validated Skills to the configuration service', async () => {
  const seen = {};
  const draft = {
    id: 'hook-1',
    postActions: [{
      id: 'notify',
      type: 'invoke_skill',
      config: { skillId: 'builtin:hook-notification', skillName: 'hook-notification' },
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
        return [{ skillId: 'builtin:hook-notification', name: 'hook-notification' }];
      },
    },
  });
  const { response, payload } = await requestJson(router, '/hooks/hook-1/publish', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(seen.validation, { hook: draft });
  assert.deepEqual(seen.publish.validatedSkills, [{
    skillId: 'builtin:hook-notification',
    name: 'hook-notification',
  }]);
  assert.equal(payload.hook.status, 'published');
});

test('Hook user scope supports selected users and all users', async () => {
  const seen = {};
  const users = [
    { id: 9, username: 'admin-user', isActive: true, isSystemAdmin: true, bound: true },
    { id: 10, username: 'member', isActive: true, isSystemAdmin: false, bound: false },
  ];
  const bindings = { scope: 'users', users, tenants: [] };
  const router = createRouter({
    hookConfigs: {
      listHookBindings: (hookId) => {
        seen.listHookId = hookId;
        return bindings;
      },
      replaceHookBindings: (args) => {
        seen.replace = args;
        return { scope: args.scope, hook: { id: args.hookId, status: 'published', boundUserCount: args.userIds.length } };
      },
    },
    hookSkillMarket: {},
  });

  const listed = await requestJson(router, '/hooks/hook-1/bindings');
  assert.equal(listed.response.status, 200);
  assert.equal(seen.listHookId, 'hook-1');
  assert.equal(listed.payload.scope, 'users');
  assert.deepEqual(listed.payload.users, users);

  const updated = await requestJson(router, '/hooks/hook-1/bindings', {
    method: 'PUT',
    body: { scope: 'all_users', userIds: [] },
  });
  assert.equal(updated.response.status, 200);
  assert.deepEqual(seen.replace, {
    hookId: 'hook-1',
    scope: 'all_users',
    userIds: [],
    boundBy: 9,
  });
  assert.equal(updated.payload.scope, 'all_users');

});

test('Hook example endpoints list choices and create only the selected drafts', async () => {
  const created = [];
  const hookConfigs = {
    listHooks: () => [...created],
    createHook: ({ input, userId }) => {
      const hook = { ...input, id: `example-${created.length + 1}`, status: 'draft', createdBy: userId };
      created.push(hook);
      return hook;
    },
    getSettings: () => ({ visibleEvents: ['Stop'] }),
    updateSettings: ({ visibleEvents }) => ({ visibleEvents }),
  };
  const router = createRouter({ hookConfigs, hookSkillMarket: {} });

  const catalog = await requestJson(router, '/hooks/examples');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.payload.examples.length, 5);
  assert.equal(catalog.payload.examples.every((example) => example.exists === false), true);

  const selectedIds = catalog.payload.examples.map((example) => example.id);
  const { response, payload } = await requestJson(router, '/hooks/examples', {
    method: 'POST',
    body: { exampleIds: selectedIds },
  });

  assert.equal(response.status, 201);
  assert.equal(payload.createdCount, 5);
  assert.equal(payload.hooks.every((hook) => hook.status === 'draft'), true);
  const sqlCheckExample = payload.hooks.find((hook) => hook.name.includes('SQL Check'));
  const sqlRecordExample = payload.hooks.find((hook) => hook.name.includes('SQL 行数'));
  const skillExamples = payload.hooks.filter((hook) => hook.postActions[0]?.type === 'invoke_skill');
  assert.equal(sqlCheckExample.postActions[0].config.toolName, 'mcp__sql-syntax-checker__check_sql_syntax');
  assert.equal(sqlCheckExample.postActions.some((action) => action.type === 'write_record'), false);
  assert.equal(sqlRecordExample.postActions[0].type, 'write_record');
  assert.equal(sqlRecordExample.postActions.some((action) => action.type === 'call_mcp_tool'), false);
  assert.equal(skillExamples.every((hook) => hook.postActions[0].config.skillId === 'builtin:hook-notification'), true);
  assert.deepEqual(payload.visibleEvents, ['Stop', 'StopFailure']);
});

test('Hook list returns stored Hooks without creating presets', async () => {
  const storedHooks = [{ id: 'stored-hook', name: 'Stored Hook' }];
  const hookConfigs = {
    listHooks: () => [...storedHooks],
  };
  const router = createRouter({ hookConfigs, hookSkillMarket: {} });

  const { response, payload } = await requestJson(router, '/hooks');

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { hooks: storedHooks });
});
