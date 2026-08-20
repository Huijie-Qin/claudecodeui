import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDesktopLoopbackMiddleware,
  parseLoopbackAuthority,
  parseLoopbackOrigin,
  validateDesktopLoopbackRequest,
  validateDesktopWebSocketRequest,
} from './desktop-loopback.js';

function request({ host = '127.0.0.1:43123', origin, localPort = 43123 } = {}) {
  return {
    headers: {
      host,
      ...(origin == null ? {} : { origin }),
    },
    socket: { localPort },
  };
}

test('loopback parser accepts explicit local authorities and rejects DNS rebinding forms', () => {
  assert.deepEqual(parseLoopbackAuthority('127.0.0.1:43123'), {
    hostname: '127.0.0.1',
    port: 43123,
  });
  assert.deepEqual(parseLoopbackAuthority('localhost:43123'), {
    hostname: 'localhost',
    port: 43123,
  });
  assert.deepEqual(parseLoopbackAuthority('[::1]:43123'), {
    hostname: '::1',
    port: 43123,
  });
  assert.equal(parseLoopbackAuthority('cloudcli.example:43123'), null);
  assert.equal(parseLoopbackAuthority('localhost.example:43123'), null);
  assert.equal(parseLoopbackAuthority('2130706433:43123'), null);
  assert.equal(parseLoopbackAuthority('127.1:43123'), null);
});

test('loopback origin only accepts local HTTP origins without paths or credentials', () => {
  assert.deepEqual(parseLoopbackOrigin('http://127.0.0.1:43123'), {
    hostname: '127.0.0.1',
    port: 43123,
    origin: 'http://127.0.0.1:43123',
  });
  assert.equal(parseLoopbackOrigin('https://127.0.0.1:43123'), null);
  assert.equal(parseLoopbackOrigin('http://user@127.0.0.1:43123'), null);
  assert.equal(parseLoopbackOrigin('http://127.0.0.1:43123/other'), null);
  assert.equal(parseLoopbackOrigin('null'), null);
});

test('desktop HTTP validation permits same-port loopback requests and requests without Origin', () => {
  assert.equal(validateDesktopLoopbackRequest(request({
    origin: 'http://127.0.0.1:43123',
  })).ok, true);
  assert.equal(validateDesktopLoopbackRequest(request()).ok, true);
});

test('desktop HTTP validation rejects external hosts and cross-port origins', () => {
  assert.deepEqual(
    validateDesktopLoopbackRequest(request({ host: 'attacker.example:43123' })),
    { ok: false, reason: 'host_not_loopback' },
  );
  assert.deepEqual(
    validateDesktopLoopbackRequest(request({ origin: 'http://127.0.0.1:43124' })),
    { ok: false, reason: 'origin_port_mismatch' },
  );
  assert.deepEqual(
    validateDesktopLoopbackRequest(request({ host: '127.0.0.1:43124' })),
    { ok: false, reason: 'host_port_mismatch' },
  );
});

test('desktop WebSocket validation requires a same-port loopback Origin', () => {
  assert.equal(validateDesktopWebSocketRequest(request({
    origin: 'http://localhost:43123',
  })).ok, true);
  assert.deepEqual(validateDesktopWebSocketRequest(request()), {
    ok: false,
    reason: 'origin_required',
  });
  assert.deepEqual(validateDesktopWebSocketRequest(request({
    origin: 'https://malicious.example',
  })), {
    ok: false,
    reason: 'origin_not_loopback',
  });
});

test('desktop loopback middleware is isolated behind its mode flag', () => {
  let nextCalls = 0;
  const disabled = createDesktopLoopbackMiddleware({ enabled: false });
  disabled(request({ host: 'public.example:43123' }), {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);

  let statusCode = null;
  let payload = null;
  const enabled = createDesktopLoopbackMiddleware({ enabled: true });
  enabled(
    request({ host: 'public.example:43123' }),
    {
      status: (code) => {
        statusCode = code;
        return { json: (value) => { payload = value; } };
      },
    },
    () => { nextCalls += 1; },
  );
  assert.equal(statusCode, 403);
  assert.equal(payload.code, 'DESKTOP_LOOPBACK_REQUIRED');
  assert.equal(nextCalls, 1);
});
