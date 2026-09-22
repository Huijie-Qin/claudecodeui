import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { startSubagentHistorySync, SUBAGENT_HISTORY_SYNC_INTERVAL_MS } from './subagentHistorySync';

test('an open running panel keeps reading history without waiting for parent inactivity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startSubagentHistorySync({
    isRunning: true,
    refreshHistory: async () => { calls++; },
    onError: (error) => assert.fail(String(error)),
  });
  t.after(stop);
  await setImmediate();
  assert.equal(calls, 1);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(SUBAGENT_HISTORY_SYNC_INTERVAL_MS);
    await setImmediate();
  }
  assert.equal(calls, 4);
  stop();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 4, 'closing the panel stops periodic reads');
});

test('slow requests cannot overlap or restart polling after a session switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let finish!: () => void;
  const stop = startSubagentHistorySync({
    isRunning: true,
    refreshHistory: () => {
      calls++;
      return new Promise<void>((resolve) => { finish = resolve; });
    },
    onError: (error) => assert.fail(String(error)),
  });
  t.after(stop);
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 1);
  stop();
  finish();
  await setImmediate();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 1);
});

test('a finished panel reads the final transcript and retries once for delayed persistence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startSubagentHistorySync({
    isRunning: false,
    refreshHistory: async () => { calls++; },
    onError: (error) => assert.fail(String(error)),
  });
  t.after(stop);
  await setImmediate();
  t.mock.timers.tick(SUBAGENT_HISTORY_SYNC_INTERVAL_MS);
  await setImmediate();
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(calls, 2);
});

test('a failed read does not permanently stall a running panel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const errors: unknown[] = [];
  const stop = startSubagentHistorySync({
    isRunning: true,
    refreshHistory: async () => { if (++calls === 1) throw new Error('offline'); },
    onError: (error) => errors.push(error),
  });
  t.after(stop);
  await setImmediate();
  t.mock.timers.tick(SUBAGENT_HISTORY_SYNC_INTERVAL_MS);
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
});
