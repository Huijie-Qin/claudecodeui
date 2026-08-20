import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBlockingPtySessionCount,
  getPtyShutdownPolicy,
  PTY_SHUTDOWN_POLICY,
  terminatePtySessions,
} from './pty-shutdown.js';

test('only plain shells with a concrete one-shot command receive drain policy', () => {
  assert.equal(getPtyShutdownPolicy({
    isPlainShell: true,
    initialCommand: 'npm run build',
  }), PTY_SHUTDOWN_POLICY.DRAIN);
  assert.equal(getPtyShutdownPolicy({
    isPlainShell: true,
    initialCommand: null,
  }), PTY_SHUTDOWN_POLICY.TERMINATE);
  assert.equal(getPtyShutdownPolicy({
    isPlainShell: true,
    initialCommand: '   ',
  }), PTY_SHUTDOWN_POLICY.TERMINATE);
  assert.equal(getPtyShutdownPolicy({
    isPlainShell: false,
    initialCommand: 'claude',
  }), PTY_SHUTDOWN_POLICY.TERMINATE);
});

test('only one-shot PTYs block graceful shutdown', () => {
  assert.equal(getBlockingPtySessionCount([
    { shutdownPolicy: PTY_SHUTDOWN_POLICY.DRAIN },
    { shutdownPolicy: PTY_SHUTDOWN_POLICY.TERMINATE, ws: {} },
    { shutdownPolicy: PTY_SHUTDOWN_POLICY.TERMINATE, ws: null },
  ]), 1);
});

test('PTY teardown clears cache timers, kills processes, and empties the registry', () => {
  const events = [];
  const sessions = new Map([
    ['interactive', {
      timeoutId: 'timer-one',
      pty: { kill: () => events.push('kill-interactive') },
    }],
    ['already-exited', {
      timeoutId: null,
      pty: { kill: () => { throw new Error('already exited'); } },
    }],
  ]);

  assert.equal(terminatePtySessions(sessions, {
    clearTimer: (timer) => events.push(`clear-${timer}`),
  }), 2);
  assert.deepEqual(events, ['clear-timer-one', 'kill-interactive']);
  assert.equal(sessions.size, 0);
});
