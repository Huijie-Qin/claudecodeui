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

test('normalizedToChatMessages renders legacy Claude task notifications as assistant updates', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'task-notification-legacy',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '<task-notification>',
        '<task-id>task-1</task-id>',
        '<output-file>/tmp/task-1.output</output-file>',
        '<status>completed</status>',
        '<summary>Background task finished</summary>',
        '</task-notification>',
      ].join('\n'),
    },
  ];

  const [notification] = normalizedToChatMessages(messages);

  assert.equal(notification.type, 'assistant');
  assert.equal(notification.isTaskNotification, true);
  assert.equal(notification.taskStatus, 'completed');
  assert.equal(notification.content, 'Background task finished');
  assert.equal(notification.taskNotification?.taskId, 'task-1');
  assert.equal(notification.taskNotification?.outputFile, '/tmp/task-1.output');
});

test('normalizedToChatMessages parses current subagent task notification fields and usage', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'task-notification-current',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '<task-notification>',
        '<task-id>agent-1</task-id>',
        '<tool-use-id>toolu_123</tool-use-id>',
        '<output-file>/tmp/agent-1.output</output-file>',
        '<status>completed</status>',
        '<summary>Agent completed the review</summary>',
        '<result>Found &lt;two&gt; issues. Base directory for this skill: /tmp/skill</result>',
        '<usage>',
        '<total_tokens>1200</total_tokens>',
        '<tool_uses>4</tool_uses>',
        '<duration_ms>987.5</duration_ms>',
        '<agent_count>2</agent_count>',
        '<subagent_tokens>800</subagent_tokens>',
        '<future_metric>supported</future_metric>',
        '</usage>',
        '</task-notification>',
      ].join('\n'),
    },
  ];

  const [notification] = normalizedToChatMessages(messages);

  assert.equal(notification.type, 'assistant');
  assert.equal(notification.isTaskNotification, true);
  assert.equal(notification.content, 'Agent completed the review');
  assert.equal(notification.taskNotification?.toolUseId, 'toolu_123');
  assert.equal(
    notification.taskNotification?.result,
    'Found <two> issues. Base directory for this skill: /tmp/skill',
  );
  assert.deepEqual(notification.taskNotification?.usage, {
    total_tokens: 1200,
    tool_uses: 4,
    duration_ms: 987.5,
    agent_count: 2,
    subagent_tokens: 800,
    future_metric: 'supported',
  });
});

test('normalizedToChatMessages accepts reordered and unknown task notification fields', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'task-notification-future',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '<task-notification version="2">',
        '<summary>Agent is waiting</summary>',
        '<future-field>future value</future-field>',
        '<status>waiting</status>',
        '<task-id>agent-2</task-id>',
        '</task-notification>',
      ].join('\n'),
    },
  ];

  const [notification] = normalizedToChatMessages(messages);

  assert.equal(notification.type, 'assistant');
  assert.equal(notification.taskStatus, 'waiting');
  assert.equal(notification.content, 'Agent is waiting');
  assert.deepEqual(notification.taskNotification?.extraFields, {
    'future-field': 'future value',
  });
});

test('normalizedToChatMessages keeps an async Agent card running before its notification arrives', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-tool-use',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Agent',
      toolId: 'toolu_agent_1',
      toolInput: {
        description: 'Review authentication',
        prompt: 'Review the authentication implementation.',
        run_in_background: true,
      },
      toolResult: {
        content: 'Agent launched successfully.',
        isError: false,
        toolUseResult: {
          status: 'async_launched',
          agentId: 'agent-1',
        },
      },
    },
  ];

  const [agentCard] = normalizedToChatMessages(messages);

  assert.equal(agentCard.toolName, 'Agent');
  assert.equal(agentCard.isSubagentContainer, true);
  assert.equal(agentCard.subagentState?.isComplete, false);
  assert.equal(agentCard.toolResult, null);
});

test('normalizedToChatMessages attaches a task notification to its Agent card', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-tool-use',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Agent',
      toolId: 'toolu_agent_1',
      toolInput: {
        description: 'Review authentication',
        prompt: 'Review the authentication implementation.',
        run_in_background: true,
      },
      toolResult: {
        content: 'Agent launched successfully.',
        isError: false,
        toolUseResult: {
          status: 'async_launched',
          agentId: 'agent-1',
        },
      },
    },
    {
      id: 'agent-task-notification',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '<task-notification>',
        '<task-id>agent-1</task-id>',
        '<tool-use-id>toolu_agent_1</tool-use-id>',
        '<status>completed</status>',
        '<summary>Authentication review completed</summary>',
        '<result>Found one authentication issue.</result>',
        '<usage><total_tokens>900</total_tokens><tool_uses>3</tool_uses></usage>',
        '</task-notification>',
      ].join('\n'),
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  const [agentCard] = chatMessages;
  assert.equal(agentCard.toolName, 'Agent');
  assert.equal(agentCard.isSubagentContainer, true);
  assert.equal(agentCard.subagentState?.isComplete, true);
  assert.equal(agentCard.toolResult?.content, 'Found one authentication issue.');
  assert.equal(agentCard.toolCompletedAt, '2026-06-30T00:00:05.000Z');
  assert.equal(agentCard.taskNotification?.summary, 'Authentication review completed');
  assert.deepEqual(agentCard.taskNotification?.usage, {
    total_tokens: 900,
    tool_uses: 3,
  });
});

test('normalizedToChatMessages still recognizes the legacy Task tool as a subagent card', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'legacy-task-tool-use',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Task',
      toolId: 'toolu_task_1',
      toolInput: {
        description: 'Review authentication',
        prompt: 'Review the authentication implementation.',
      },
      toolResult: {
        content: 'Review complete.',
        isError: false,
        toolUseResult: {
          status: 'completed',
        },
      },
    },
  ];

  const [taskCard] = normalizedToChatMessages(messages);

  assert.equal(taskCard.toolName, 'Task');
  assert.equal(taskCard.isSubagentContainer, true);
  assert.equal(taskCard.subagentState?.isComplete, true);
  assert.equal(taskCard.toolResult?.content, 'Review complete.');
});
