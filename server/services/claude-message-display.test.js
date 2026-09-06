import assert from 'node:assert/strict';
import test from 'node:test';
import { createClaudeMessageDisplayTracker } from './claude-message-display.js';

test('display identity follows an assistant message through streaming and canonical output', () => {
  const tracker = createClaudeMessageDisplayTracker();
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_a' } } });
  const delta = tracker.observe({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hello' } } });
  assert.equal(delta.assistantMessageId, 'msg_a');
  tracker.observe({ type: 'stream_event', parent_tool_use_id: 'child', event: { type: 'message_start', message: { id: 'msg_child' } } });
  assert.equal(tracker.getMainMessageId(), 'msg_a');
  tracker.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_b' } } });
  const late = tracker.observe({ type: 'assistant', message: { id: 'msg_a', content: [] } });
  assert.equal(late.assistantMessageId, 'msg_a');
  assert.equal(tracker.getMainMessageId(), 'msg_b');
  assert.equal(tracker.getActiveMainMessageId(), 'msg_b');
  tracker.observe({ type: 'stream_event', event: { type: 'message_stop' } });
  assert.equal(tracker.getActiveMainMessageId(), null);
  assert.equal(tracker.hasMainMessageId('msg_a'), true);
  assert.equal(tracker.hasMainMessageId('msg_child'), false);
  assert.equal(tracker.hasMainMessageId('unknown'), false);
});

test('canonical-only CLI output also supplies a display anchor', () => {
  const tracker = createClaudeMessageDisplayTracker();
  tracker.observe({ type: 'assistant', message: { id: 'msg_a' } });
  assert.equal(tracker.getMainMessageId(), 'msg_a');
});
