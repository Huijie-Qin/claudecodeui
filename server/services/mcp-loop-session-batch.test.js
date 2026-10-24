import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMcpLoopBatchModelContent,
  createMcpLoopToolBatchTracker,
} from './mcp-loop-session-batch.js';

test('MCP loop batch tracker waits for every matching parallel tool result', () => {
  const tracker = createMcpLoopToolBatchTracker([
    'mcp__tasks__first_status',
    'mcp__tasks__second_status',
  ]);

  assert.equal(tracker.observe({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'mcp__tasks__first_status', input: {} },
        { type: 'tool_use', id: 'tool-2', name: 'mcp__tasks__second_status', input: {} },
        { type: 'tool_use', id: 'tool-3', name: 'Read', input: {} },
      ],
    },
  }), false);

  assert.equal(tracker.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'running' }] },
  }), false);
  assert.equal(tracker.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'running' }] },
  }), true);
  assert.equal(tracker.observe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'duplicate' }] },
  }), false);

  assert.deepEqual(tracker.snapshot(), {
    expectedToolUseIds: ['tool-1', 'tool-2'],
    completedToolUseIds: ['tool-1', 'tool-2'],
  });
});

test('MCP loop batch tracker can fall back to a tool id learned by the Hook callback', () => {
  const tracker = createMcpLoopToolBatchTracker([]);
  tracker.addExpected('tool-fallback');

  assert.equal(tracker.observe({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-fallback', content: 'running' }],
    },
  }), true);
});

test('MCP loop batch model content carries only saved file references for every final result', () => {
  const content = buildMcpLoopBatchModelContent([
    {
      id: 'job-2',
      toolUseId: 'tool-2',
      status: 'failed',
      attemptCount: 3,
      startedAtMs: 2_000,
      completedAtMs: 2_500,
      lastResult: { state: 'failed', detail: 'PRIVATE_RESULT' },
      error: 'PRIVATE_ERROR',
      resultFile: '/workspace/.cloudcli/hook-results/mcp-loops/job-2.json',
    },
    {
      id: 'job-1',
      toolUseId: 'tool-1',
      status: 'succeeded',
      attemptCount: 2,
      startedAtMs: 1_000,
      completedAtMs: 1_500,
      lastResult: { state: 'success', detail: 'PRIVATE_RESULT' },
      resultFile: '/workspace/.cloudcli/hook-results/mcp-loops/job-1.json',
    },
  ]);

  assert.match(content, /<ccui-mcp-loop-results count="2">/);
  assert.ok(content.indexOf('job-id="job-1"') < content.indexOf('job-id="job-2"'));
  assert.match(content, /tool-use-id="tool-1"/);
  assert.match(content, /tool-use-id="tool-2"/);
  assert.match(content, /"resultFile":"\/workspace\/.cloudcli\/hook-results\/mcp-loops\/job-1.json"/);
  assert.match(content, /Read the files as needed/);
  assert.doesNotMatch(content, /PRIVATE_|"result":|"error":/);
});

test('MCP loop batch refuses to fall back to inline results when the file is missing', () => {
  assert.throws(() => buildMcpLoopBatchModelContent([{ id: 'job', lastResult: { private: 'result' } }]), /must be saved/);
});
