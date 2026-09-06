import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSupplementMessages } from './messageDisplayOrder.js';

const reply = (id: string, assistantMessageId = id, fields = {}) => ({
  id, assistantMessageId, sessionId: 's', provider: 'claude', kind: 'text', role: 'assistant', ...fields,
});
const input = (id: string, sequence: number, fields = {}) => ({
  id, displayAfterAssistantId: 'a', supplementSequence: sequence,
  sessionId: 's', provider: 'claude', kind: 'text', role: 'user', ...fields,
});

test('supplements follow every block of the same response and precede the new response', () => {
  const messages = [reply('a-1', 'a'), input('second', 2), input('first', 1), reply('a-2', 'a'), reply('b')];
  const ordered = orderSupplementMessages(messages);
  assert.deepEqual(ordered.map(m => m.id), ['a-1', 'a-2', 'first', 'second', 'b']);
  assert.deepEqual(orderSupplementMessages(ordered), ordered);
});

test('missing, other-session and subagent anchors cannot move or drop a supplement', () => {
  const messages = [input('user', 1), reply('other', 'a', { sessionId: 'other' }),
    reply('child', 'a', { parentToolUseId: 'tool-child' }), reply('b')];
  assert.deepEqual(orderSupplementMessages(messages), messages);
});
