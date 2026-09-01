import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManagedUserExecutionEnv,
  resolveManagedGitIdentity,
} from './user-execution-env.js';

function createUsers({ status = 'active' } = {}) {
  return {
    getUserById: () => ({
      id: 7,
      username: '20001',
      identity_change_status: status,
    }),
    getEnvForUser: () => ({
      USER_KEY: 'personal-key',
      W3_NAME: 'attempted-override',
      GIT_AUTHOR_NAME: 'attempted-author',
      codehub_email: 'attempted-lowercase-override@example.com',
      CODEHUB_EMAIL: 'attempted-uppercase-override@example.com',
      CUSTOM_VALUE: 42,
    }),
    getGitConfig: () => ({
      git_name: 'Developer Name',
      git_email: 'developer@example.com',
    }),
  };
}

test('managed execution env uses the current username and user-editable git identity', () => {
  const env = buildManagedUserExecutionEnv(7, {
    baseEnv: { PATH: '/bin', W3_NAME: 'service-user' },
    users: createUsers(),
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.USER_KEY, 'personal-key');
  assert.equal(env.CUSTOM_VALUE, '42');
  assert.equal(env.W3_NAME, '20001');
  assert.equal(env.GIT_AUTHOR_NAME, 'Developer Name');
  assert.equal(env.GIT_COMMITTER_NAME, 'Developer Name');
  assert.equal(env.GIT_AUTHOR_EMAIL, 'developer@example.com');
  assert.equal(env.GIT_COMMITTER_EMAIL, 'developer@example.com');
  assert.equal(env.codehub_email, 'developer@example.com');
  assert.equal(env.CODEHUB_EMAIL, 'developer@example.com');
});

test('managed execution env refuses to launch while identity is changing', () => {
  assert.throws(
    () => buildManagedUserExecutionEnv(7, { users: createUsers({ status: 'changing' }) }),
    (error) => error.statusCode === 409,
  );
});

test('git identity falls back to the current username after an employee number change', () => {
  const identity = resolveManagedGitIdentity(7, {
    users: {
      getUserById: () => ({ id: 7, username: '20001' }),
      getGitConfig: () => ({ git_name: null, git_email: null }),
    },
  });

  assert.deepEqual(identity, { name: '20001', email: null });
});

test('managed commit identity is re-read on every invocation', () => {
  const identity = {
    username: '10001',
    status: 'active',
    gitName: 'Old Git Name',
    gitEmail: 'old@example.com',
  };
  const users = {
    getUserById: () => ({
      id: 7,
      username: identity.username,
      identity_change_status: identity.status,
    }),
    getEnvForUser: () => ({}),
    getGitConfig: () => ({
      git_name: identity.gitName,
      git_email: identity.gitEmail,
    }),
  };

  const before = buildManagedUserExecutionEnv(7, { users, baseEnv: {} });
  assert.equal(before.W3_NAME, '10001');
  assert.equal(before.GIT_AUTHOR_NAME, 'Old Git Name');

  identity.username = '20001';
  identity.gitName = null;
  identity.gitEmail = 'new@example.com';
  const after = buildManagedUserExecutionEnv(7, { users, baseEnv: {} });
  assert.equal(after.W3_NAME, '20001');
  assert.equal(after.GIT_AUTHOR_NAME, '20001');
  assert.equal(after.GIT_COMMITTER_NAME, '20001');
  assert.equal(after.GIT_AUTHOR_EMAIL, 'new@example.com');
  assert.equal(after.codehub_email, 'new@example.com');
  assert.equal(after.CODEHUB_EMAIL, 'new@example.com');

  identity.status = 'changing';
  assert.throws(
    () => buildManagedUserExecutionEnv(7, { users, baseEnv: {} }),
    (error) => error.statusCode === 409,
  );
});

test('managed execution env explicitly clears inherited CodeHub email variables when git_email is empty', () => {
  const env = buildManagedUserExecutionEnv(7, {
    baseEnv: {
      codehub_email: 'service-lower@example.com',
      CODEHUB_EMAIL: 'service-upper@example.com',
    },
    users: {
      getUserById: () => ({ id: 7, username: '20001' }),
      getEnvForUser: () => ({
        codehub_email: 'user-lower@example.com',
        CODEHUB_EMAIL: 'user-upper@example.com',
      }),
      getGitConfig: () => ({ git_email: null }),
    },
  });

  assert.equal(env.codehub_email, '');
  assert.equal(env.CODEHUB_EMAIL, '');
});
