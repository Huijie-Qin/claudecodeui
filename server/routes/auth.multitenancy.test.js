import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { createAuthRouter } from './auth.js';

function createRequest(router, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', router);

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

function createFakeDeps() {
  const users = [];
  const fakeUserDb = {
    hasUsers: () => users.length > 0,
    createUser: (username, passwordHash, options = {}) => {
      const user = {
        id: users.length + 1,
        username,
        password_hash: passwordHash,
        is_system_admin: options.isSystemAdmin ? 1 : 0,
      };
      users.push(user);
      return user;
    },
    updateLastLogin: () => {},
    getUserByUsername: (username) => users.find((user) => user.username === username) || null,
  };

  return {
    users,
    userDb: fakeUserDb,
    db: {
      prepare: () => ({ run: () => ({}) }),
    },
    generateToken: (user) => `token-${user.id}`,
    authenticateToken: (req, res, next) => {
      req.user = users[0];
      next();
    },
  };
}

test('first registration creates a system admin bootstrap user', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'admin',
    password: 'secret1',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, true);
  assert.equal(payload.user.is_system_admin, 1);
});

test('later registration creates a normal user without tenant access', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  await createRequest(router, 'POST', '/api/auth/register', { username: 'admin', password: 'secret1' });
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'member',
    password: 'secret1',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, false);
  assert.equal(payload.user.is_system_admin, 0);
});
