import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../types/types';
import { preserveChatMessageReferences } from './stableChatMessages';

function message(id: string, count: number, result: unknown): ChatMessage {
  return { id, type: 'hook', content: '', timestamp: '2026-09-21', hookActivity: {
    hookId: 'loop', status: 'succeeded', loopAttemptCount: count, loopResult: result,
    followups: [{ status: 'succeeded', actionType: 'mcp_loop_run', timestamp: '2026-09-21' }],
  } };
}

test('one Hook update retains all unaffected rows without walking large results', () => {
  const result = { get rows() { throw new Error('Must not deep-compare MCP payload'); } };
  const previous = Array.from({ length: 100 }, (_, i) => message(String(i), 1, result));
  const next = Array.from({ length: 100 }, (_, i) => message(String(i), i === 50 ? 2 : 1, result));
  const shared = preserveChatMessageReferences(previous, next);
  assert.equal(shared.filter((entry, index) => entry === previous[index]).length, 99);
  assert.equal(shared[50].hookActivity?.loopAttemptCount, 2);
  assert.equal(shared[50].hookActivity?.followups, previous[50].hookActivity?.followups);
  assert.equal(preserveChatMessageReferences(shared, next), shared);
});

test('changed MCP payloads and removed messages are never hidden by the cache', () => {
  const before = [message('1', 1, { status: 'running' }), message('2', 1, null)];
  const after = [message('1', 1, { status: 'success' })];
  const result = preserveChatMessageReferences(before, after);
  assert.equal(result.length, 1);
  assert.notEqual(result[0], before[0]);
  assert.deepEqual(result[0].hookActivity?.loopResult, { status: 'success' });
});
