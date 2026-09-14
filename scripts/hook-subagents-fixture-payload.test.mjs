import assert from 'node:assert/strict';
import test from 'node:test';
import { findTaskResult, readToolPayload } from './hook-subagents-fixture-payload.mjs';

test('reads the real CLI execute_task result with its appended system reminder', () => {
  const content = '{"task_id":"15174e51-48ce-4b60-808c-6e0b845eb2dd","status":"running","created_at_ms":1789113785510,"duration_ms":1200000,"observed_at_ms":1789113785510,"elapsed_ms":0,"finished_at_ms":null}\n\n<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: General-purpose agent for researching complex questions. (Tools: *)\n</system-reminder>';
  const actual = findTaskResult({ tool_use_id: 'toolu_loop20_20260911_success_child-A_execute', type: 'tool_result', content });
  assert.equal(actual.task_id, '15174e51-48ce-4b60-808c-6e0b845eb2dd');
  assert.equal(actual.status, 'running');
  assert.equal(actual.duration_ms, 1_200_000);
});

test('parses final replacement inside nested text content without truncating quoted braces', () => {
  const task = { task_id: 'real-result-id', status: 'success', note: 'a } and [ and " remain data' };
  const actual = findTaskResult({ type: 'tool_result', content: [{ type: 'text', text: `${JSON.stringify({ result: task })}\n\n<system-reminder>Unrelated note</system-reminder>` }] });
  assert.deepEqual(actual, task);
});

test('does not infer a task ID from prose or an appended reminder', () => {
  assert.equal(findTaskResult('task_id=pretend status=success'), null);
  assert.equal(findTaskResult('Tool failed\n<system-reminder>{"task_id":"pretend","status":"success"}</system-reminder>'), null);
  assert.equal(findTaskResult('{}\n<system-reminder>{"task_id":"pretend","status":"success"}</system-reminder>'), null);
  assert.equal(readToolPayload('{"task_id":"broken"'), null);
});
