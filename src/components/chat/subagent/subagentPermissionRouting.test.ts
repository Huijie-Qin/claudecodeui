import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingPermissionRequest } from '../types/types';

import {
  applySubagentPermissionWaitingState,
  findSubagentTraceForPermissionRequest,
  partitionSubagentPermissionRequests,
} from './subagentPermissionRouting';
import type { SubagentTrace } from './types';

function trace(id: string, agentId: string, activityId: string): SubagentTrace {
  return {
    id,
    agentId,
    sourceToolIds: [id],
    title: id,
    description: id,
    agentType: 'Agent',
    prompt: '',
    status: 'running',
    startedAt: new Date('2026-08-24T00:00:00.000Z'),
    activities: [{
      id: activityId,
      toolId: activityId,
      toolName: 'AskUserQuestion',
      toolInput: {},
      toolResult: null,
      timestamp: new Date('2026-08-24T00:00:01.000Z'),
      status: 'running',
      summary: 'AskUserQuestion',
    }],
    messages: [],
    usage: {},
  };
}

function request(context?: unknown): PendingPermissionRequest {
  return {
    requestId: 'request-1',
    toolName: 'AskUserQuestion',
    context,
  };
}

test('routes concurrent subagent questions by tool use id', () => {
  const traces = [
    trace('parent-a', 'agent-a', 'question-a'),
    trace('parent-b', 'agent-b', 'question-b'),
  ];

  assert.equal(
    findSubagentTraceForPermissionRequest(traces, request({
      toolUseId: 'question-b',
      agentId: 'agent-a',
    }))?.id,
    'parent-b',
  );
});

test('routes an early permission request by agent id before tool activity arrives', () => {
  const traces = [trace('parent-a', 'agent-a', 'question-a')];

  assert.equal(
    findSubagentTraceForPermissionRequest(traces, request({ agentId: 'agent-a' }))?.id,
    'parent-a',
  );
});

test('routes a reused agent id to its newest active invocation', () => {
  const completed = trace('parent-old', 'agent-shared', 'question-old');
  completed.status = 'completed';
  const current = trace('parent-current', 'agent-shared', 'question-current');

  assert.equal(
    findSubagentTraceForPermissionRequest([completed, current], request({
      agentId: 'agent-shared',
    }))?.id,
    'parent-current',
  );
});

test('keeps a resumed-agent question unresolved while only an old completed trace exists', () => {
  const completed = trace('parent-old', 'agent-shared', 'question-old');
  completed.status = 'completed';
  const pending = request({
    toolUseId: 'question-new',
    agentId: 'agent-shared',
  });

  assert.equal(findSubagentTraceForPermissionRequest([completed], pending), null);
  const partition = partitionSubagentPermissionRequests([completed], [pending], null);
  assert.deepEqual(partition.unresolved.map((item) => item.requestId), ['request-1']);
  assert.deepEqual(partition.main, []);
});

test('waiting permission state clears a stale terminal result from a resumed agent', () => {
  const completed = trace('parent-old', 'agent-shared', 'question-old');
  completed.status = 'completed';
  completed.result = 'Previous final result';
  completed.completedAt = new Date('2026-08-24T00:00:02.000Z');
  const pendingRequest = request({ toolUseId: 'question-old', agentId: 'agent-shared' });

  const [waiting] = applySubagentPermissionWaitingState(
    [completed],
    [{ request: pendingRequest, trace: completed }],
  );

  assert.equal(waiting?.status, 'waiting');
  assert.equal(waiting?.result, undefined);
  assert.equal(waiting?.completedAt, undefined);
});

test('keeps top-level and unrelated permission requests in the main composer', () => {
  const traces = [trace('parent-a', 'agent-a', 'question-a')];

  assert.equal(findSubagentTraceForPermissionRequest(traces, request()), null);
  assert.equal(findSubagentTraceForPermissionRequest(traces, {
    ...request({ toolUseId: 'question-a' }),
    toolName: 'Bash',
  }), null);
});

test('holds a subagent question out of the main composer until its trace arrives', () => {
  const pending = request({
    toolUseId: 'question-before-trace',
    agentId: 'agent-before-trace',
  });

  const partition = partitionSubagentPermissionRequests([], [pending], null);

  assert.deepEqual(partition.main, []);
  assert.deepEqual(partition.unresolved.map((item) => item.requestId), ['request-1']);
});

test('keeps routed questions reachable when the panel is closed or showing another trace', () => {
  const traces = [
    trace('parent-a', 'agent-a', 'question-a'),
    trace('parent-b', 'agent-b', 'question-b'),
  ];
  const requests = [
    request({ toolUseId: 'question-a', agentId: 'agent-a' }),
    { ...request({ toolUseId: 'question-b', agentId: 'agent-b' }), requestId: 'request-2' },
  ];

  const closed = partitionSubagentPermissionRequests(traces, requests, null);
  assert.equal(closed.selectedTrace, null);
  assert.deepEqual(closed.main, []);
  assert.deepEqual(closed.selectedRequests, []);
  assert.deepEqual(closed.hidden.map(({ request: item }) => item.requestId), [
    'request-1',
    'request-2',
  ]);

  const showingFirst = partitionSubagentPermissionRequests(traces, requests, 'parent-a');
  assert.deepEqual(showingFirst.selectedRequests.map((item) => item.requestId), ['request-1']);
  assert.deepEqual(showingFirst.hidden.map(({ request: item }) => item.requestId), ['request-2']);
});
