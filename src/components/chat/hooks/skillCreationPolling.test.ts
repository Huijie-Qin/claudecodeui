import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { startSkillCreationPolling } from './skillCreationPolling';

test('empty history and completed, failed or cancelled tasks load once then stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const jobs of [[], [{ status: 'completed' }], [{ status: 'failed' }], [{ status: 'cancelled' }]]) {
    let calls = 0;
    const stop = startSkillCreationPolling({ load: async () => { calls++; return jobs; }, receive: () => {}, onError: error => assert.fail(String(error)), delay: () => 2000 });
    await setImmediate(); t.mock.timers.tick(60000); await setImmediate();
    assert.equal(calls, 1); stop();
  }
});

test('active jobs continue polling until a terminal result and a new job can restart polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const states = ['queued', 'generating', 'completed']; const received: string[] = []; let calls = 0;
  const start = () => startSkillCreationPolling({ load: async () => [{ status: states[calls++] || 'completed' }],
    receive: jobs => received.push(jobs[0].status), onError: error => assert.fail(String(error)), delay: () => 2000 });
  const stop = start(); await setImmediate();
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(2000); await setImmediate(); }
  t.mock.timers.tick(60000); await setImmediate();
  assert.deepEqual(received, states); assert.equal(calls, 3); stop();
  calls = 0; received.length = 0;
  const stopNew = start(); await setImmediate();
  assert.deepEqual(received, ['queued']); assert.equal(calls, 1); stopNew();
});

test('hidden pages use the longer interval and cancelling remains active until cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = startSkillCreationPolling({ load: async () => [{ status: ++calls === 1 ? 'cancelling' : 'cancelled' }], receive: () => {}, onError: error => assert.fail(String(error)), delay: () => 10000 });
  await setImmediate(); t.mock.timers.tick(9999); await setImmediate(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await setImmediate(); assert.equal(calls, 2);
  t.mock.timers.tick(60000); await setImmediate(); assert.equal(calls, 2); stop();
});

test('transient failures retry at most three times; permission errors stop immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const status of [undefined, 503, 403, 404]) {
    let calls = 0;
    const stop = startSkillCreationPolling({ load: async () => { calls++; throw Object.assign(new Error('Unavailable'), { status }); }, receive: () => assert.fail('Unexpected successful response'), onError: () => {}, delay: () => 2000 });
    await setImmediate();
    for (let i = 0; i < 5; i++) { t.mock.timers.tick(2000); await setImmediate(); }
    assert.equal(calls, status === 403 || status === 404 ? 1 : 3); stop();
  }
});

test('switching conversation or restarting after submission ignores old in-flight responses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reject of [false, true]) {
    let finish!: () => void, calls = 0;
    const stop = startSkillCreationPolling({ load: () => {
      calls++;
      return new Promise<{ status: string }[]>((resolve, fail) => { finish = () => reject ? fail(new Error('Old request')) : resolve([{ status: 'generating' }]); });
    }, receive: () => assert.fail('Stale response must not update the new conversation'), onError: () => assert.fail('Stale error must be ignored'), delay: () => 2000 });
    stop(); finish(); await setImmediate();
    t.mock.timers.tick(60000); await setImmediate(); assert.equal(calls, 1);
  }
});
