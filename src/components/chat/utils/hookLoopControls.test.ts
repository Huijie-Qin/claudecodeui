import assert from 'node:assert/strict';
import test from 'node:test';

import type { HookActivityDetails } from '../types/types';

import { getCancellableHookLoopJobId } from './hookLoopControls';

const child: HookActivityDetails = {
  activityKind: 'execution', agentId: 'child-a', actionTypes: ['mcp_loop_run'],
  status: 'running', loopStatus: 'queued', loopJobId: 'child-job', jobId: 'hook-execution',
};

test('a running child Hook exposes only its own persisted loop job for cancellation', () => {
  assert.equal(getCancellableHookLoopJobId(child), 'child-job');
  assert.equal(getCancellableHookLoopJobId({ ...child, loopStatus: 'running' }), 'child-job');
  assert.equal(getCancellableHookLoopJobId({ ...child, loopJobId: undefined }), undefined);
  assert.equal(getCancellableHookLoopJobId({ ...child, agentId: undefined }), undefined);
  assert.equal(getCancellableHookLoopJobId({ ...child, actionTypes: ['call_mcp_tool'] }), undefined);
});

test('terminal and restored cancelled loops cannot expose a stale cancel button', () => {
  for (const loopStatus of ['succeeded', 'failed', 'timed_out', 'cancelled']) {
    assert.equal(getCancellableHookLoopJobId({ ...child, loopStatus }), undefined);
  }
  for (const status of ['succeeded', 'failed'] as const) {
    assert.equal(getCancellableHookLoopJobId({ ...child, status }), undefined);
  }
});

test('the existing parent loop followup stays cancellable without enabling other Hook actions', () => {
  const followup: HookActivityDetails = { activityKind: 'followup', actionType: 'mcp_loop_run', status: 'running', loopJobId: 'parent-job' };
  assert.equal(getCancellableHookLoopJobId(followup), 'parent-job');
  assert.equal(getCancellableHookLoopJobId({ ...followup, actionType: 'invoke_skill' }), undefined);
  assert.equal(getCancellableHookLoopJobId(), undefined);
});
