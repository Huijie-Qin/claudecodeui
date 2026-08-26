import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
  const tenants = [];
  const memberships = [];
  const invitations = [];
  const passwordResets = [];
  const fakeUserDb = {
    hasUsers: () => users.length > 0,
    createUser: (username, passwordHash, options = {}) => {
      const user = {
        id: users.length + 1,
        username,
        password_hash: passwordHash,
        is_system_admin: options.isSystemAdmin ? 1 : 0,
        is_active: 1,
      };
      users.push(user);
      return user;
    },
    updateLastLogin: () => {},
    getUserById: (userId) => users.find((user) => user.id === userId && user.is_active !== 0) || null,
    getUserByUsername: (username) => users.find((user) => user.username === username && user.is_active !== 0) || null,
    getInvitationByTokenHash: (tokenHash) => {
      const invitation = invitations.find((row) => row.token_hash === tokenHash);
      if (!invitation) return null;
      const user = users.find((row) => row.id === invitation.user_id);
      return {
        ...invitation,
        username: user?.username,
        is_active: user?.is_active,
        is_system_admin: user?.is_system_admin,
      };
    },
    acceptInvitation: ({ tokenHash, passwordHash }) => {
      const invitation = invitations.find((row) => row.token_hash === tokenHash);
      if (!invitation || invitation.accepted_at || invitation.revoked_at) return null;
      const user = users.find((row) => row.id === invitation.user_id);
      if (!user) return null;
      invitation.accepted_at = new Date().toISOString();
      user.password_hash = passwordHash;
      user.is_active = 1;
      return user;
    },
    getPasswordResetByTokenHash: (tokenHash) => {
      const passwordReset = passwordResets.find((row) => row.token_hash === tokenHash);
      if (!passwordReset) return null;
      const user = users.find((row) => row.id === passwordReset.user_id);
      return {
        ...passwordReset,
        username: user?.username,
        is_active: user?.is_active,
        is_system_admin: user?.is_system_admin,
      };
    },
    resetPasswordWithToken: ({ tokenHash, passwordHash }) => {
      const passwordReset = passwordResets.find((row) => row.token_hash === tokenHash);
      if (!passwordReset || passwordReset.used_at || passwordReset.revoked_at) return null;
      const user = users.find((row) => row.id === passwordReset.user_id);
      if (!user) return null;
      passwordReset.used_at = new Date().toISOString();
      passwordResets
        .filter((row) => row.user_id === user.id && row !== passwordReset && !row.used_at && !row.revoked_at)
        .forEach((row) => {
          row.revoked_at = new Date().toISOString();
        });
      user.password_hash = passwordHash;
      return user;
    },
  };

  return {
    users,
    tenants,
    memberships,
    invitations,
    passwordResets,
    userDb: fakeUserDb,
    multitenancy: {
      tenants: {
        listTenants: () => tenants,
        createTenant: ({ code, name, status = 'active' }) => {
          const tenant = { id: tenants.length + 1, code, name, status };
          tenants.push(tenant);
          return tenant;
        },
      },
      memberships: {
        upsertMembership: (membership) => {
          memberships.push(membership);
          return membership;
        },
      },
    },
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

function invitationTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

test('first registration creates a system admin bootstrap user', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'admin',
    password: 'secret1',
    gitEmail: 'admin@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, true);
  assert.equal(payload.user.is_system_admin, 1);
});

test('first registration creates a default tenant with admin edit access', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  await createRequest(router, 'POST', '/api/auth/register', {
    username: 'admin',
    password: 'secret1',
    gitEmail: 'admin@example.com',
  });

  assert.deepEqual(deps.tenants, [{ id: 1, code: 'default', name: 'Default', status: 'active' }]);
  assert.deepEqual(deps.memberships, [{
    tenantId: 1,
    userId: 1,
    role: 'system_admin',
    permission: 'edit',
    status: 'active',
  }]);
});

test('later registration creates a normal user without tenant access', async () => {
  const deps = createFakeDeps();
  const router = createAuthRouter(deps);
  await createRequest(router, 'POST', '/api/auth/register', {
    username: 'admin',
    password: 'secret1',
    gitEmail: 'admin@example.com',
  });
  const { response, payload } = await createRequest(router, 'POST', '/api/auth/register', {
    username: 'member',
    password: 'secret1',
    gitEmail: 'member@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.bootstrapAdmin, false);
  assert.equal(payload.user.is_system_admin, 0);
});

test('invitation lookup returns the admin-selected username', async () => {
  const deps = createFakeDeps();
  const token = 'invite-token';
  deps.users.push({
    id: 1,
    username: 'member',
    password_hash: '',
    is_system_admin: 0,
    is_active: 0,
  });
  deps.invitations.push({
    id: 1,
    user_id: 1,
    token_hash: invitationTokenHash(token),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    accepted_at: null,
    revoked_at: null,
  });

  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'GET', `/api/auth/invitations/${token}`);

  assert.equal(response.status, 200);
  assert.deepEqual(payload.invitation.username, 'member');
});

test('an accepted invitation returns a machine-readable terminal state', async () => {
  const deps = createFakeDeps();
  const token = 'accepted-invite-token';
  deps.users.push({
    id: 1,
    username: 'member',
    password_hash: 'password-hash',
    is_system_admin: 0,
    is_active: 1,
  });
  deps.invitations.push({
    id: 1,
    user_id: 1,
    token_hash: invitationTokenHash(token),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    accepted_at: new Date().toISOString(),
    revoked_at: null,
  });

  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'GET', `/api/auth/invitations/${token}`);

  assert.equal(response.status, 410);
  assert.equal(payload.code, 'INVITATION_ALREADY_ACCEPTED');
  assert.equal(payload.error, '该邀请已被接受');
});

test('accepting an invitation activates the user and signs them in', async () => {
  const deps = createFakeDeps();
  const token = 'invite-token';
  deps.users.push({
    id: 1,
    username: 'member',
    password_hash: '',
    is_system_admin: 0,
    is_active: 0,
  });
  deps.invitations.push({
    id: 1,
    user_id: 1,
    token_hash: invitationTokenHash(token),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    accepted_at: null,
    revoked_at: null,
  });

  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'POST', `/api/auth/invitations/${token}/accept`, {
    password: 'secret1',
    gitEmail: 'member@example.com',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'member');
  assert.equal(payload.token, 'token-1');
  assert.equal(deps.users[0].is_active, 1);
  assert.notEqual(deps.users[0].password_hash, '');
});

test('password reset lookup returns the active username', async () => {
  const deps = createFakeDeps();
  const token = 'reset-token';
  deps.users.push({
    id: 1,
    username: 'member',
    password_hash: 'old-hash',
    is_system_admin: 0,
    is_active: 1,
  });
  deps.passwordResets.push({
    id: 1,
    user_id: 1,
    token_hash: invitationTokenHash(token),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    used_at: null,
    revoked_at: null,
  });

  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'GET', `/api/auth/password-resets/${token}`);

  assert.equal(response.status, 200);
  assert.equal(payload.passwordReset.username, 'member');
});

test('resetting a password uses the link and signs the user in', async () => {
  const deps = createFakeDeps();
  const token = 'reset-token';
  deps.users.push({
    id: 1,
    username: 'member',
    password_hash: 'old-hash',
    is_system_admin: 0,
    is_active: 1,
  });
  deps.passwordResets.push(
    {
      id: 1,
      user_id: 1,
      token_hash: invitationTokenHash(token),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      revoked_at: null,
    },
    {
      id: 2,
      user_id: 1,
      token_hash: invitationTokenHash('older-token'),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      revoked_at: null,
    },
  );

  const router = createAuthRouter(deps);
  const { response, payload } = await createRequest(router, 'POST', `/api/auth/password-resets/${token}/reset`, {
    password: 'secret2',
  });
  const reuse = await createRequest(router, 'POST', `/api/auth/password-resets/${token}/reset`, {
    password: 'secret3',
  });

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.user.username, 'member');
  assert.equal(payload.token, 'token-1');
  assert.notEqual(deps.users[0].password_hash, 'old-hash');
  assert.ok(deps.passwordResets[0].used_at);
  assert.ok(deps.passwordResets[1].revoked_at);
  assert.equal(reuse.response.status, 410);
});
