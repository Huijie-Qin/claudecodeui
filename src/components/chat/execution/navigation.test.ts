import assert from 'node:assert/strict';
import test from 'node:test';

import type { SubagentTrace } from '../subagent/types';

import { findExecutionTaskParentTrace } from './navigation';

function trace(id: string, second: number, agentId = 'shared-agent'): SubagentTrace {
  return { id, agentId, sourceToolIds: [`tool-${id}`], title: id, description: '', agentType: 'Agent',
    prompt: '', status: 'completed', startedAt: new Date(second * 1000), activities: [], messages: [], usage: {} };
}

test('exact parent tool beats an older invocation with the same agent id', () => {
  const traces = [trace('old', 1), trace('resumed', 2)];
  assert.equal(findExecutionTaskParentTrace({ parentToolUseId: 'tool-resumed', parentAgentId: 'shared-agent' }, traces)?.id, 'resumed');
});

test('historical source keeps its exact parent even after that agent resumes', () => {
  const traces = [trace('old', 1), trace('resumed', 2)];
  assert.equal(findExecutionTaskParentTrace({ parentToolUseId: 'tool-old', parentAgentId: 'shared-agent' }, traces)?.id, 'old');
  assert.equal(findExecutionTaskParentTrace({ traceId: 'old', parentAgentId: 'shared-agent' }, traces)?.id, 'old');
});

test('agent fallback picks its latest invocation regardless of input ordering', () => {
  const traces = [trace('resumed', 2), trace('old', 1), trace('unrelated', 3, 'other-agent')];
  assert.equal(findExecutionTaskParentTrace({ parentAgentId: 'shared-agent' }, traces)?.id, 'resumed');
  assert.equal(findExecutionTaskParentTrace({ parentAgentId: 'missing' }, traces), null);
  assert.equal(findExecutionTaskParentTrace({}, traces), null);
});
