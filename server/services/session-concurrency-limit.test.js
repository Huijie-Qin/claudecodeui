import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeSessionExecutionQueue } from './claude-session-execution.js';
import {
  createSessionConcurrencyLease,
  createSessionConcurrencyLimiter,
  createSessionLimitExceededMessage,
  isSessionLimitExceededError,
} from './session-concurrency-limit.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function limiter(limit = 1) {
  return createSessionConcurrencyLimiter({
    users: { getEnvForUser: () => ({ session_limit: String(limit) }) },
    env: {},
  });
}

test('a queued Claude turn does not consume a user slot before execution starts', async () => {
  const concurrency = limiter();
  const queue = createClaudeSessionExecutionQueue();
  const firstLease = createSessionConcurrencyLease({ limiter: concurrency, userId: 7 });
  const secondLease = createSessionConcurrencyLease({ limiter: concurrency, userId: 7 });
  const firstStarted = deferred();
  const finishFirst = deferred();
  let secondStarted = false;

  const first = queue.run('same-session', async () => {
    firstLease.acquire();
    firstStarted.resolve();
    try {
      await finishFirst.promise;
    } finally {
      firstLease.release();
    }
  });
  await firstStarted.promise;

  const second = queue.run('same-session', async () => {
    secondLease.acquire();
    secondStarted = true;
    secondLease.release();
  });
  await Promise.resolve();
  assert.equal(concurrency.getActiveCount(7), 1);
  assert.equal(queue.hasPending('same-session'), true);
  assert.equal(secondStarted, false);

  finishFirst.resolve();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
  assert.equal(concurrency.getActiveCount(7), 0);
});

test('released slots can be reacquired by a later request', () => {
  const concurrency = limiter();
  const lease = createSessionConcurrencyLease({ limiter: concurrency, userId: 7 });
  const competing = createSessionConcurrencyLease({ limiter: concurrency, userId: 7 });

  lease.acquire();
  assert.throws(() => competing.acquire(), isSessionLimitExceededError);
  lease.release();
  lease.release();
  assert.equal(concurrency.getActiveCount(7), 0);

  lease.acquire();
  assert.equal(concurrency.getActiveCount(7), 1);
  lease.release();
  assert.equal(concurrency.getActiveCount(7), 0);
  competing.acquire();
  competing.release();
});

test('an MCP loop keeps its one lease through waiting and agent resume', () => {
  const concurrency = limiter();
  const loop = createSessionConcurrencyLease({
    limiter: concurrency,
    userId: 7,
    provider: 'claude',
    sessionId: 'session-1',
    requestId: 'original-request',
  });
  const competing = createSessionConcurrencyLease({ limiter: concurrency, userId: 7 });

  loop.acquire();
  const originalLease = concurrency.getActiveLeases(7)[0];
  assert.throws(() => competing.acquire(), isSessionLimitExceededError);
  loop.acquire(); // Agent resume uses the lease already held by its MCP loop.
  assert.equal(concurrency.getActiveCount(7), 1);
  assert.deepEqual(concurrency.getActiveLeases(7), [originalLease]);

  loop.release();
  competing.acquire();
  competing.release();
  assert.equal(concurrency.getActiveCount(7), 0);
});

test('active leases identify the requests occupying a user limit', () => {
  const concurrency = limiter(2);
  const first = createSessionConcurrencyLease({
    limiter: concurrency,
    userId: 7,
    provider: 'claude',
    sessionId: 'session-1',
    clientSessionId: 'new-session-1',
    requestId: 'request-1',
    workspaceId: 'workspace-1',
  });
  const second = createSessionConcurrencyLease({
    limiter: concurrency,
    userId: 7,
    provider: 'codex',
    sessionId: 'session-2',
    requestId: 'request-2',
  });
  first.acquire();
  second.acquire();

  const activeLeases = concurrency.getActiveLeases(7);
  assert.equal(activeLeases.length, 2);
  assert.deepEqual(activeLeases.map(({ provider, sessionId, requestId }) => ({ provider, sessionId, requestId })), [
    { provider: 'claude', sessionId: 'session-1', requestId: 'request-1' },
    { provider: 'codex', sessionId: 'session-2', requestId: 'request-2' },
  ]);
  assert.ok(activeLeases.every(({ startedAt }) => Number.isFinite(startedAt)));
  assert.equal(activeLeases[0].clientSessionId, 'new-session-1');
  activeLeases[0].provider = 'changed';
  assert.equal(concurrency.getActiveLeases(7)[0].provider, 'claude');
  assert.throws(() => concurrency.acquire({ userId: 7 }), (error) => {
    assert.equal(isSessionLimitExceededError(error), true);
    assert.deepEqual(error.activeLeases.map(({ requestId }) => requestId), ['request-1', 'request-2']);
    return true;
  });

  first.release();
  assert.equal(concurrency.getActiveCount(7), 1);
  second.release();
  assert.deepEqual(concurrency.getActiveLeases(7), []);
});

test('a held lease updates its session identity after the provider creates it', () => {
  const concurrency = limiter(1);
  const lease = createSessionConcurrencyLease({
    limiter: concurrency,
    userId: 7,
    provider: 'claude',
    sessionId: null,
    clientSessionId: 'new-session-1',
  });

  assert.equal(lease.updateSessionId('session-before-acquire'), false);
  lease.acquire();
  assert.equal(concurrency.getActiveLeases(7)[0].sessionId, null);
  assert.equal(lease.updateSessionId('  session-created  '), true);
  assert.equal(concurrency.getActiveLeases(7)[0].sessionId, 'session-created');
  assert.throws(() => concurrency.acquire({ userId: 7 }), (error) => {
    assert.equal(error.activeLeases[0].sessionId, 'session-created');
    return true;
  });

  assert.equal(lease.updateSessionId('   '), false);
  assert.equal(concurrency.getActiveLeases(7)[0].sessionId, 'session-created');
  lease.release();
  assert.equal(lease.updateSessionId('session-after-release'), false);
  assert.deepEqual(concurrency.getActiveLeases(7), []);

  lease.acquire();
  assert.equal(concurrency.getActiveLeases(7)[0].sessionId, 'session-created');
  lease.release();
});

test('active requests remain observable when no limit is configured', () => {
  const concurrency = createSessionConcurrencyLimiter({
    users: { getEnvForUser: () => ({}) },
    env: {},
  });
  const first = createSessionConcurrencyLease({ limiter: concurrency, userId: 7, provider: 'claude' });
  const second = createSessionConcurrencyLease({ limiter: concurrency, userId: 7, provider: 'cursor' });
  first.acquire();
  second.acquire();
  assert.equal(concurrency.getActiveCount(7), 2);
  first.release();
  second.release();
  assert.equal(concurrency.getActiveCount(7), 0);
});

test('limit errors explain which request is still occupying a slot', () => {
  const message = createSessionLimitExceededMessage(
    { activeCount: 1, limit: 1 },
    [{ provider: 'claude', sessionId: null, startedAt: Date.now() - 10_000 }],
  );
  assert.match(message, /CLAUDE 新会话准备中/);
  assert.match(message, /10 秒/);
});
