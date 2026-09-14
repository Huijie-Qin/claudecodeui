import assert from 'node:assert/strict';
import test from 'node:test';

import type { HookActivityDetails, HookFollowupActivityDetails } from '../types/types';

import { getCancellableHookLoopJobId } from './hookLoopControls';
import { getHookDisplayFollowups, getHookFollowupDisplayStatus } from './hookFollowupPresentation';

const timestamp = '2026-09-12T00:00:00.000Z';
const child: HookActivityDetails = {
  activityKind: 'execution', executionId: 'child-execution', agentId: 'child-a',
  actionTypes: ['mcp_loop_run'], status: 'running',
  loopJobId: 'child-job', loopStatus: 'queued', loopAttemptCount: 2,
  loopTargetTool: 'mcp__demo__get_task_status', loopToolUseId: 'child-tool',
  loopStartedAtMs: Date.parse(timestamp), loopNextPollAtMs: Date.parse(timestamp) + 10000,
};

test('inline child progress uses the same post-action fields and status as the main loop', () => {
  const [display] = getHookDisplayFollowups(child, timestamp);
  const mainFollowup: HookFollowupActivityDetails = {
    ...display, jobId: 'main-followup', executionId: 'main-execution', loopJobId: 'main-job', loopToolUseId: 'main-tool',
  };
  const main: HookActivityDetails = { activityKind: 'execution', status: 'succeeded', actionTypes: ['mcp_loop_run'], followups: [mainFollowup] };
  assert.strictEqual(getHookDisplayFollowups(main, timestamp)[0], mainFollowup);
  assert.equal(getHookFollowupDisplayStatus(display), getHookFollowupDisplayStatus(mainFollowup));
  assert.equal(display.loopAttemptCount, mainFollowup.loopAttemptCount);
  assert.equal(display.loopTargetTool, mainFollowup.loopTargetTool);
  assert.equal(getCancellableHookLoopJobId(display), 'child-job');
  assert.equal(getCancellableHookLoopJobId(mainFollowup), 'main-job');
  assert.equal(child.followups, undefined, 'Presentation does not create persisted follow-ups or main-agent recovery');
});

test('live progress updates and restored snapshots keep exactly one post-action and the same job ID', () => {
  for (const attempt of [0, 1, 9]) {
    const progress = { ...child, loopAttemptCount: attempt };
    const snapshot = JSON.stringify(progress);
    for (const input of [progress, JSON.parse(snapshot)]) {
      const display = getHookDisplayFollowups(input, timestamp);
      assert.equal(display.length, 1);
      assert.equal(display[0].jobId, 'child-job');
      assert.equal(display[0].loopAttemptCount, attempt);
      assert.equal(JSON.stringify(input), snapshot);
    }
  }
});

test('an existing post-action for the same loop is reused without duplicates or losing recovery messages', () => {
  const [existing] = getHookDisplayFollowups(child, timestamp);
  existing.messages = [{ type: 'assistant', content: 'Recovered', timestamp }];
  const followups = [existing];
  assert.strictEqual(getHookDisplayFollowups({ ...child, followups }, timestamp), followups);
  assert.equal(followups[0].messages?.[0].content, 'Recovered');
});

test('terminal child results stay visible and never expose stale cancellation controls', () => {
  for (const loopStatus of ['succeeded', 'failed', 'timed_out', 'cancelled']) {
    const result = { status: loopStatus };
    const [display] = getHookDisplayFollowups({ ...child, status: 'succeeded', loopStatus, loopResult: result }, timestamp);
    assert.equal(getHookFollowupDisplayStatus(display), loopStatus);
    assert.strictEqual(display.loopResult, result);
    assert.equal(getCancellableHookLoopJobId(display), undefined);
  }
  const [stale] = getHookDisplayFollowups({ ...child, status: 'failed', loopStatus: 'running' }, timestamp);
  assert.equal(getCancellableHookLoopJobId(stale), undefined);
});

test('queued scheduler intervals do not change a running loop into a queued agent recovery', () => {
  const [display] = getHookDisplayFollowups(child, timestamp);
  assert.equal(getHookFollowupDisplayStatus(display), 'running');
  assert.equal(getHookFollowupDisplayStatus({ ...display, loopStatus: 'succeeded' }), 'running');
});

test('old terminal snapshots without a job ID render results but cannot cancel a guessed job', () => {
  const [display] = getHookDisplayFollowups({ ...child, loopJobId: undefined, status: 'succeeded', loopStatus: 'cancelled', loopResult: { status: 'cancelled' } }, timestamp);
  assert.equal(display.jobId, 'child-execution_loop');
  assert.equal(getCancellableHookLoopJobId(display), undefined);
});

test('script-only executions, initial empty loops and standalone followups do not acquire a second wrapper', () => {
  assert.deepEqual(getHookDisplayFollowups(undefined, timestamp), []);
  assert.deepEqual(getHookDisplayFollowups({ status: 'running', activityKind: 'execution', actionTypes: ['mcp_loop_run'] }, timestamp), []);
  assert.deepEqual(getHookDisplayFollowups({ ...child, actionTypes: ['call_mcp_tool'] }, timestamp), []);
  assert.deepEqual(getHookDisplayFollowups({ ...child, activityKind: 'followup' }, timestamp), []);
});
