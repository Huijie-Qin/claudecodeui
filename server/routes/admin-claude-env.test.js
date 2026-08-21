import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAdminRouter } from './admin.js';

async function requestJson(router, path, { body, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 9, username: 'admin', is_system_admin: 1 };
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

function createRouter(updateClaudeEnvForUsers) {
  return createAdminRouter({}, { updateClaudeEnvForUsers });
}

test('admin Claude env list never returns encrypted values even if the data source includes one', async () => {
  const router = createAdminRouter({}, {
    listClaudeEnvForUsers: () => [{
      userId: 7,
      username: 'user-7',
      env: [
        {
          name: 'SECRET_TOKEN',
          configured: true,
          visible: true,
          encrypted: true,
          value: 'must-not-leak',
        },
        {
          name: 'VISIBLE_MODEL',
          configured: true,
          visible: true,
          encrypted: false,
          value: 'claude-model',
        },
      ],
    }],
  });

  const { response, payload } = await requestJson(router, '/users/claude-env', { method: 'GET' });

  assert.equal(response.status, 200);
  const secret = payload.users[0].env.find((entry) => entry.name === 'SECRET_TOKEN');
  assert.equal(Object.hasOwn(secret, 'value'), false);
  assert.equal(
    payload.users[0].env.find((entry) => entry.name === 'VISIBLE_MODEL')?.value,
    'claude-model',
  );
  assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
});

test('admin Claude env batch endpoint accepts a delete-only mutation and deduplicates names NOCASE', async () => {
  const calls = [];
  const router = createRouter((input) => {
    calls.push(input);
    return input.userIds.map((userId) => ({
      userId,
      username: `user-${userId}`,
      success: true,
      env: {},
      deleted: input.deletes,
    }));
  });

  const { response, payload } = await requestJson(router, '/users/claude-env/batch', {
    body: {
      userIds: [7, '7'],
      env: {},
      deletes: [' Mixed_Key ', 'mixed_key', 'SECOND_KEY'],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    userIds: [7],
    env: {},
    visibility: {},
    encrypted: {},
    deletes: ['Mixed_Key', 'SECOND_KEY'],
  }]);
  assert.deepEqual(payload.summary, { total: 1, succeeded: 1, failed: 0 });
  assert.deepEqual(payload.results[0].deleted, ['Mixed_Key', 'SECOND_KEY']);
});

test('admin Claude env batch endpoint keeps legacy upsert payloads compatible', async () => {
  const calls = [];
  const router = createRouter((input) => {
    calls.push(input);
    return [{ userId: 7, username: 'user-7', success: true, env: input.env, deleted: [] }];
  });

  const { response } = await requestJson(router, '/users/claude-env/batch', {
    body: {
      userIds: [7],
      anthropicModel: 'claude-model',
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    userIds: [7],
    env: { ANTHROPIC_MODEL: 'claude-model' },
    visibility: { ANTHROPIC_MODEL: false },
    encrypted: { ANTHROPIC_MODEL: false },
    deletes: [],
  }]);
});

test('admin Claude env batch endpoint rejects invalid or ambiguous deletes', async () => {
  let updateCount = 0;
  const router = createRouter(() => {
    updateCount += 1;
    return [];
  });
  const invalidBodies = [
    { userIds: [7], env: {}, deletes: {} },
    { userIds: [7], env: {}, deletes: [123] },
    { userIds: [7], env: {}, deletes: ['BAD-NAME'] },
    { userIds: [7], env: {}, deletes: ['user_key'] },
    { userIds: [7], env: { Mixed_Key: 'new' }, deletes: ['mixed_key'] },
    { userIds: [7], env: {}, deletes: [] },
  ];

  for (const body of invalidBodies) {
    const { response } = await requestJson(router, '/users/claude-env/batch', { body });
    assert.equal(response.status, 400);
  }
  assert.equal(updateCount, 0);
});
