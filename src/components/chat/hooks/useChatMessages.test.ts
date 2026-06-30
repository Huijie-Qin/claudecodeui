import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

test('normalizedToChatMessages hides live Claude skill detail user text', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'skill-detail-live',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        'Skill details:',
        'name: design-review',
        'parameters: {"focus":"visual polish"}',
        '',
        'Base directory for this skill: /Users/alex/.claude/skills/design-review',
        '',
        '# Design Review',
      ].join('\n'),
    },
    {
      id: 'assistant-1',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'I will take a look.',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].type, 'assistant');
  assert.equal(chatMessages[0].content, 'I will take a look.');
});

test('normalizedToChatMessages hides Claude user text immediately after a Skill tool use', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'skill-tool',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Skill',
      toolInput: {
        skill: 'design-review',
      },
      toolId: 'toolu_1',
    },
    {
      id: 'skill-body-live',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.500Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '# Design Review',
        '',
        'Use this workflow to inspect the current UI.',
      ].join('\n'),
    },
    {
      id: 'assistant-1',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'I will take a look.',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 2);
  assert.equal(chatMessages[0].isToolUse, true);
  assert.equal(chatMessages[1].type, 'assistant');
  assert.equal(chatMessages[1].content, 'I will take a look.');
});
