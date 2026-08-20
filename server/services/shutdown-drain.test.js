import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getActiveWorkCount,
  getRemainingShutdownTime,
  waitForActiveWorkToDrain,
  waitForPromiseUntilDeadline,
} from './shutdown-drain.js';

test('active work count includes Agent Graph and Top Skill background work', () => {
  assert.equal(getActiveWorkCount({
    providerCommands: { claude: 1 },
    providerSessions: { claude: 1 },
    shell: 1,
    agentGraph: 2,
    topSkillJobs: 3,
  }), 7);
});

test('cached interactive PTYs are diagnostic only and do not block drain', () => {
  assert.equal(getActiveWorkCount({
    shell: 0,
    interactiveShell: 4,
  }), 0);
});

test('shutdown drain waits for background work to reach terminal state', async () => {
  const summaries = [
    { agentGraph: 1, topSkillJobs: 1 },
    { agentGraph: 0, topSkillJobs: 1 },
    { agentGraph: 0, topSkillJobs: 0 },
  ];
  const waits = [];

  const result = await waitForActiveWorkToDrain({
    readSummary: () => summaries.shift(),
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => waits.length * 10,
    sleep: async (delayMs) => { waits.push(delayMs); },
  });

  assert.equal(result.drained, true);
  assert.deepEqual(waits, [10, 10]);
});

test('shutdown drain reports the last active summary at its deadline', async () => {
  let currentTime = 0;
  const summary = { agentGraph: 1, topSkillJobs: 0 };

  const result = await waitForActiveWorkToDrain({
    readSummary: () => summary,
    timeoutMs: 20,
    pollIntervalMs: 10,
    now: () => currentTime,
    sleep: async (delayMs) => { currentTime += delayMs; },
  });

  assert.equal(result.drained, false);
  assert.equal(result.summary, summary);
});

test('HTTP close receives only the time remaining in the shared shutdown deadline', async () => {
  let currentTime = 20;
  let observedDelay = null;
  const neverSettles = new Promise(() => {});

  assert.equal(getRemainingShutdownTime(30, () => currentTime), 10);
  const result = await waitForPromiseUntilDeadline(neverSettles, {
    deadlineMs: 30,
    now: () => currentTime,
    sleep: async (delayMs) => {
      observedDelay = delayMs;
      currentTime += delayMs;
    },
  });

  assert.equal(result.completed, false);
  assert.equal(observedDelay, 10);
  assert.equal(getRemainingShutdownTime(30, () => currentTime), 0);
});

test('HTTP close completion wins before the shared deadline', async () => {
  const result = await waitForPromiseUntilDeadline(Promise.resolve('closed'), {
    deadlineMs: 100,
    now: () => 0,
    sleep: () => new Promise(() => {}),
  });

  assert.deepEqual(result, { completed: true, value: 'closed' });
});
