import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createShutdownAdmissionMiddleware,
  createShutdownChatMessageGuard,
  createShutdownWebSocketMessageGuard,
  isShutdownRejectedChatMessageType,
  shouldEnforceShutdownAdmission,
  SHUTDOWN_ERROR_CODE,
  SHUTDOWN_WEBSOCKET_CLOSE_CODE,
  SHUTDOWN_WEBSOCKET_CLOSE_REASON,
} from './shutdown-admission.js';

test('shutdown admission is enabled only while a Desktop server is draining', () => {
  assert.equal(shouldEnforceShutdownAdmission({ desktopMode: true, shuttingDown: true }), true);
  assert.equal(shouldEnforceShutdownAdmission({ desktopMode: true, shuttingDown: false }), false);
  assert.equal(shouldEnforceShutdownAdmission({ desktopMode: false, shuttingDown: true }), false);
});

test('chat shutdown admission only rejects messages that start or append work', () => {
  for (const type of [
    'claude-command',
    'cursor-command',
    'codex-command',
    'gemini-command',
    'claude-supplement',
    'cursor-resume',
  ]) {
    assert.equal(isShutdownRejectedChatMessageType(type), true, type);
  }

  for (const type of [
    'claude-permission-response',
    'abort-session',
    'cursor-abort',
    'check-session-status',
    'get-pending-permissions',
    'get-active-sessions',
  ]) {
    assert.equal(isShutdownRejectedChatMessageType(type), false, type);
  }
});

function createHttpResponse() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('HTTP admission follows the live shutdown state and returns a structured 503', () => {
  let shuttingDown = false;
  let nextCalls = 0;
  const middleware = createShutdownAdmissionMiddleware({
    isShuttingDown: () => shuttingDown,
  });

  const admittedResponse = createHttpResponse();
  middleware({}, admittedResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(admittedResponse.statusCode, null);

  shuttingDown = true;
  const rejectedResponse = createHttpResponse();
  middleware({}, rejectedResponse, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(rejectedResponse.statusCode, 503);
  assert.equal(rejectedResponse.headers.Connection, 'close');
  assert.deepEqual(rejectedResponse.payload, {
    success: false,
    error: 'Server is shutting down and is not accepting new work',
    code: SHUTDOWN_ERROR_CODE,
    retryable: true,
  });
});

test('WebSocket message admission sends a structured error before closing', () => {
  let shuttingDown = false;
  const events = [];
  const ws = {
    readyState: 1,
    send(value) {
      events.push(['send', JSON.parse(value)]);
    },
    close(code, reason) {
      events.push(['close', code, reason]);
      this.readyState = 2;
    },
  };
  const rejectMessage = createShutdownWebSocketMessageGuard({
    isShuttingDown: () => shuttingDown,
  });

  assert.equal(rejectMessage(ws), false);
  assert.deepEqual(events, []);

  shuttingDown = true;
  assert.equal(rejectMessage(ws), true);
  assert.deepEqual(events, [
    ['send', {
      type: 'error',
      error: 'Server is shutting down and is not accepting new work',
      code: SHUTDOWN_ERROR_CODE,
      retryable: true,
    }],
    ['close', SHUTDOWN_WEBSOCKET_CLOSE_CODE, SHUTDOWN_WEBSOCKET_CLOSE_REASON],
  ]);
});

test('WebSocket message admission remains rejected after closing starts', () => {
  const events = [];
  const rejectMessage = createShutdownWebSocketMessageGuard({
    isShuttingDown: () => true,
  });

  assert.equal(rejectMessage({
    readyState: 2,
    send: () => events.push('send'),
    close: () => events.push('close'),
  }), true);
  assert.deepEqual(events, []);
});

test('chat admission rejects new work without closing control and status access', () => {
  const events = [];
  const ws = {
    readyState: 1,
    send(value) {
      events.push(['send', JSON.parse(value)]);
    },
    close(code, reason) {
      events.push(['close', code, reason]);
      this.readyState = 2;
    },
  };
  const rejectChatMessage = createShutdownChatMessageGuard({
    isShuttingDown: () => true,
  });

  assert.equal(rejectChatMessage(ws, 'claude-command'), true);
  assert.equal(ws.readyState, 1);
  assert.equal(rejectChatMessage(ws, 'abort-session'), false);
  assert.equal(rejectChatMessage(ws, 'check-session-status'), false);
  assert.deepEqual(events, [[
    'send',
    {
      type: 'error',
      error: 'Server is shutting down and is not accepting new work',
      code: SHUTDOWN_ERROR_CODE,
      retryable: true,
    },
  ]]);
});

test('shutdown admission factories require a live state reader', () => {
  assert.throws(
    () => createShutdownAdmissionMiddleware({ isShuttingDown: false }),
    /isShuttingDown must be a function/,
  );
  assert.throws(
    () => createShutdownWebSocketMessageGuard({}),
    /isShuttingDown must be a function/,
  );
  assert.throws(
    () => createShutdownChatMessageGuard({}),
    /isShuttingDown must be a function/,
  );
});
