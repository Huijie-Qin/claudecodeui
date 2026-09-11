import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPendingInteractionTracker,
  readIteratorNextWithStallTimeout,
} from './claude-stream-watchdog.js';

function createRead(t, { interactions = createPendingInteractionTracker(), subscribe = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveNext;
  let interruptions = 0;
  const next = new Promise((resolve) => { resolveNext = resolve; });
  const read = readIteratorNextWithStallTimeout({ next: () => next }, {
    provider: 'Claude',
    timeoutMs: 120000,
    shouldPauseTimeout: interactions.isPaused,
    subscribePauseChanges: subscribe ? interactions.subscribe : undefined,
    onTimeout: () => { interruptions++; },
  });
  // Keep intentional timeout cases observed even before their assertions run.
  read.catch(() => {});
  return { interactions, read, resolveNext, interruptions: () => interruptions };
}

test('answering AskUserQuestion after a long wait gives Claude a fresh stall timeout', async (t) => {
  const fixture = createRead(t);
  fixture.interactions.begin('question');
  t.mock.timers.tick(120000);
  assert.equal(fixture.interruptions(), 0);
  fixture.interactions.end('question');
  t.mock.timers.tick(5000);
  assert.equal(fixture.interruptions(), 0, 'answering must not immediately interrupt the permission stream');
  t.mock.timers.tick(114999);
  assert.equal(fixture.interruptions(), 0);
  fixture.resolveNext({ done: false, value: 'response after answer' });
  assert.deepEqual(await fixture.read, { done: false, value: 'response after answer' });
});

test('a short permission wait across the original deadline also resets the timeout', async (t) => {
  const fixture = createRead(t);
  t.mock.timers.tick(119000);
  fixture.interactions.begin('question');
  t.mock.timers.tick(500);
  fixture.interactions.end('question');
  t.mock.timers.tick(119999);
  assert.equal(fixture.interruptions(), 0);
  t.mock.timers.tick(1);
  await assert.rejects(fixture.read, { code: 'STREAM_STALLED', timeoutMs: 120000 });
  assert.equal(fixture.interruptions(), 1, 'a real stall after the answer still interrupts');
});

test('concurrent questions keep the watchdog paused until the last answer', async (t) => {
  const fixture = createRead(t);
  fixture.interactions.begin('first');
  fixture.interactions.begin('second');
  t.mock.timers.tick(240000);
  fixture.interactions.end('first');
  t.mock.timers.tick(240000);
  assert.equal(fixture.interruptions(), 0);
  fixture.interactions.end('second');
  t.mock.timers.tick(119999);
  assert.equal(fixture.interruptions(), 0);
  fixture.resolveNext({ done: true });
  await fixture.read;
});

test('polling-only pause users also receive a fresh timeout after resuming', async (t) => {
  const fixture = createRead(t, { subscribe: false });
  fixture.interactions.begin('question');
  t.mock.timers.tick(120000);
  fixture.interactions.end('question');
  t.mock.timers.tick(5000);
  assert.equal(fixture.interruptions(), 0);
  t.mock.timers.tick(119999);
  assert.equal(fixture.interruptions(), 0);
  t.mock.timers.tick(1);
  await assert.rejects(fixture.read, { code: 'STREAM_STALLED' });
});

test('a stalled stream without interactions still times out', async (t) => {
  const fixture = createRead(t);
  t.mock.timers.tick(119999);
  assert.equal(fixture.interruptions(), 0);
  t.mock.timers.tick(1);
  await assert.rejects(fixture.read, { name: 'StreamStalledError', code: 'STREAM_STALLED' });
  assert.equal(fixture.interruptions(), 1);
});

test('settling the iterator removes its timer and pause subscription', async (t) => {
  const fixture = createRead(t);
  fixture.resolveNext({ done: true });
  await fixture.read;
  fixture.interactions.begin('later question');
  fixture.interactions.end('later question');
  t.mock.timers.tick(360000);
  assert.equal(fixture.interruptions(), 0);
});
