import assert from 'node:assert/strict';
import test from 'node:test';
import { findGetstatusResult, nextGetstatusResponse } from './hook-subagents-getstatus-fixture.mjs';

const statusToolName = 'mcp__qa_getstatus20__getstatus';
const run = 'getstatus20_contract';
function response({ actor = 'child-A', messages = [], tools = [statusToolName] } = {}) {
  const used = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.content || []);
  return nextGetstatusResponse({
    actor, child: actor === 'main' ? undefined : 'A', run, messages, tools: new Set(tools), statusToolName,
    usedId: (suffix) => used.some((block) => block.id === `toolu_${run}_${actor}_${suffix}`),
    tool: (suffix, name, input) => ({ type: 'tool_use', id: `toolu_${run}_${actor}_${suffix}`, name, input }),
  });
}

test('parent delegates one real child and makes no MCP call', () => {
  const result = response({ actor: 'main', tools: ['Agent', statusToolName] });
  assert.equal(result.phase, 'getstatus-spawn-child');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].name, 'Agent');
  assert.equal(result.content[0].input.subagent_type, 'general-purpose');
  assert.equal(result.content[0].input.run_in_background, false);
});

test('child generates one UUID, calls only getstatus, and reports actual replacement result', () => {
  const first = response();
  assert.equal(first.phase, 'getstatus-call');
  assert.match(first.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.content.length, 1);
  assert.deepEqual(first.content[0].input, { id: first.taskId });
  assert.equal(first.content[0].name, statusToolName);
  for (const status of ['running', 'success', 'failed']) {
    const result = response({ messages: [
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: `${JSON.stringify({ id: first.taskId, status })}\n\n<system-reminder>Unrelated CLI metadata</system-reminder>` }] },
    ] });
    assert.equal(result.phase, 'getstatus-complete');
    assert.equal(result.taskId, first.taskId);
    assert.equal(result.observedStatus, status);
    assert.ok(result.content.every((block) => block.type === 'text'), 'child never polls via another model tool call');
  }
});

test('child refuses missing or mismatched results instead of fabricating success', () => {
  const first = response();
  for (const content of ['getstatus finished successfully', JSON.stringify({ id: 'wrong-id', status: 'success' })]) {
    const result = response({ messages: [
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content }] },
    ] });
    assert.equal(result.phase, 'getstatus-error');
    assert.equal(result.observedStatus, undefined);
  }
});

test('getstatus parser reads nested MCP content but never task_id or reminder-only claims', () => {
  const actual = { id: 'real-id', status: 'success', note: 'quoted } [ remain data' };
  assert.deepEqual(findGetstatusResult({ content: [{ type: 'text', text: `${JSON.stringify(actual)}\n<system-reminder>ignored</system-reminder>` }] }), actual);
  assert.equal(findGetstatusResult({ task_id: 'old-tool-id', status: 'success' }), null);
  assert.equal(findGetstatusResult('{}\n<system-reminder>{"id":"fake","status":"success"}</system-reminder>'), null);
});

test('parent reports only the returned child status and ID', () => {
  const spawn = response({ actor: 'main', tools: ['Agent', statusToolName] });
  const result = response({ actor: 'main', messages: [
    { role: 'assistant', content: spawn.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: spawn.content[0].id, content: 'HOOK_SUBAGENTS_GETSTATUS_DONE ACTOR=child-A TASK_ID=real-id STATUS=running' }] },
  ] });
  assert.equal(result.phase, 'getstatus-complete');
  assert.equal(result.taskId, 'real-id');
  assert.equal(result.observedStatus, 'running');
});
