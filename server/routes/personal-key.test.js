import assert from 'node:assert/strict';
import test from 'node:test';

import { createPersonalKeyHandler } from './personal-key.js';

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('personal key handler returns the current user key without allowing caches', () => {
  const personalKey = 'A'.repeat(64);
  let requestedUserId = null;
  const handler = createPersonalKeyHandler({
    getEnvForUser(userId) {
      requestedUserId = userId;
      return { USER_KEY: personalKey };
    },
  });
  const response = createResponse();

  handler({ user: { id: 42 } }, response);

  assert.equal(requestedUserId, 42);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(response.headers.Pragma, 'no-cache');
  assert.deepEqual(response.payload, { success: true, personalKey });
});

test('personal key handler does not return a value when the key is missing', () => {
  const handler = createPersonalKeyHandler({
    getEnvForUser: () => ({}),
  });
  const response = createResponse();

  handler({ user: { id: 7 } }, response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.payload, {
    success: false,
    error: 'Personal key not found',
  });
});
