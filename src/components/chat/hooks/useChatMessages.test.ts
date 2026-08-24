import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

test('normalizedToChatMessages preserves queued user message state', () => {
  const [queuedMessage] = normalizedToChatMessages([{
    id: 'local_supplement_followup-1',
    sessionId: 'session-1',
    timestamp: '2026-06-30T00:00:01.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'Handle this after the current response',
    clientMessageId: 'followup-1',
    queueStatus: 'queued',
    queuePosition: 2,
  }]);

  assert.equal(queuedMessage.type, 'user');
  assert.equal(queuedMessage.clientMessageId, 'followup-1');
  assert.equal(queuedMessage.queueStatus, 'queued');
  assert.equal(queuedMessage.queuePosition, 2);
});

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

test('normalizedToChatMessages hides the internal Hook recovery prompt in the original session', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'hook-recovery-prompt',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: [
        '<ccui-hook-recovery>',
        'Hook: Completion notification (hook-1)',
        'Skill root: /workspace/.cloudcli/hook-config/skills/builtin-notify/hash',
        '</ccui-hook-recovery>',
        '# Hook notification internal instructions',
      ].join('\n'),
    },
    {
      id: 'hook-recovery-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'HOOK_NOTIFICATION_SKILL_EXECUTED',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].type, 'assistant');
  assert.equal(chatMessages[0].content, 'HOOK_NOTIFICATION_SKILL_EXECUTED');
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

test('normalizedToChatMessages groups TaskOutput polling calls into their Task card', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'task-tool-use',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Task',
      toolId: 'toolu_task_1',
      toolInput: {
        description: 'Review authentication',
        prompt: 'Review the authentication implementation.',
        run_in_background: true,
      },
    },
    {
      id: 'task-launch-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_task_1',
      content: 'Agent launched successfully.',
      isError: false,
      toolUseResult: {
        status: 'async_launched',
        agentId: 'agent-1',
      },
    },
    {
      id: 'task-output-running',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'TaskOutput',
      toolId: 'toolu_output_1',
      toolInput: {
        task_id: 'agent-1',
        block: false,
        timeout: 1000,
      },
    },
    {
      id: 'task-output-running-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_output_1',
      content: [
        '<retrieval_status>success</retrieval_status>',
        '<task_id>agent-1</task_id>',
        '<status>running</status>',
      ].join('\n'),
      isError: false,
    },
    {
      id: 'task-output-completed',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'TaskOutput',
      toolId: 'toolu_output_2',
      toolInput: {
        task_id: 'agent-1',
        block: true,
        timeout: 30000,
      },
    },
    {
      id: 'task-output-completed-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_output_2',
      content: [
        '<retrieval_status>success</retrieval_status>',
        '<task_id>agent-1</task_id>',
        '<status>completed</status>',
        '<output>Found one authentication issue.</output>',
      ].join('\n'),
      isError: false,
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  const [taskCard] = chatMessages;
  assert.equal(taskCard.toolName, 'Task');
  assert.equal(taskCard.isSubagentContainer, true);
  assert.equal(taskCard.subagentState?.isComplete, true);
  assert.equal(taskCard.subagentState?.childTools.length, 2);
  assert.deepEqual(
    taskCard.subagentState?.childTools.map((tool) => tool.toolName),
    ['TaskOutput', 'TaskOutput'],
  );
  assert.deepEqual(
    taskCard.subagentState?.childTools.map((tool) => ({
      status: tool.toolResult?.taskOutputStatus,
      content: tool.toolResult?.content,
    })),
    [
      {
        status: 'running',
        content: undefined,
      },
      {
        status: 'completed',
        content: 'Found one authentication issue.',
      },
    ],
  );
  assert.equal(
    taskCard.toolResult?.content,
    [
      'TaskOutput 1 (running)',
      'TaskOutput 2 (completed)\nFound one authentication issue.',
    ].join('\n\n'),
  );
  assert.equal(taskCard.toolCompletedAt, '2026-06-30T00:00:05.100Z');
});

test('normalizedToChatMessages groups realtime subagent tools by parentToolUseId', () => {
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
      id: 'subagent-read',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'Read',
      toolId: 'toolu_read_1',
      toolInput: {
        file_path: '/workspace/auth.ts',
      },
      parentToolUseId: 'toolu_agent_1',
    },
    {
      id: 'subagent-read-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_read_1',
      content: 'export function authenticate() {}',
      isError: false,
      parentToolUseId: 'toolu_agent_1',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  const [agentCard] = chatMessages;
  assert.equal(agentCard.toolName, 'Agent');
  assert.equal(agentCard.subagentState?.isComplete, false);
  assert.equal(agentCard.subagentState?.childTools.length, 1);
  assert.equal(agentCard.subagentState?.childTools[0]?.toolName, 'Read');
  assert.equal(agentCard.subagentState?.childTools[0]?.toolResult?.content, 'export function authenticate() {}');
});

test('normalizedToChatMessages gives Agent sole ownership of details shared with legacy Task', () => {
  const sharedSubagentTools = [
    {
      toolId: 'toolu_read_1',
      toolName: 'Read',
      toolInput: {
        file_path: '/workspace/auth.ts',
      },
      toolResult: {
        content: 'export function authenticate() {}',
        isError: false,
      },
      timestamp: '2026-06-30T00:00:01.000Z',
    },
  ];
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
      subagentTools: sharedSubagentTools,
    },
    {
      id: 'agent-tool-use',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:00.100Z',
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
      subagentTools: sharedSubagentTools,
    },
    {
      id: 'task-output-completed',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'TaskOutput',
      toolId: 'toolu_output_1',
      toolInput: {
        task_id: 'agent-1',
        block: true,
        timeout: 30000,
      },
    },
    {
      id: 'task-output-completed-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_output_1',
      content: [
        '<task_id>agent-1</task_id>',
        '<status>completed</status>',
        '<output>Found one authentication issue.</output>',
      ].join('\n'),
      isError: false,
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 2);
  const [taskCard, agentCard] = chatMessages;
  assert.equal(taskCard.toolName, 'Task');
  assert.equal(taskCard.subagentState?.detailsOwnerToolId, 'toolu_agent_1');
  assert.equal(taskCard.subagentState?.childTools.length, 0);
  assert.equal(agentCard.toolName, 'Agent');
  assert.equal(agentCard.subagentState?.detailsOwnerToolId, undefined);
  assert.deepEqual(
    agentCard.subagentState?.childTools.map((tool) => tool.toolName),
    ['Read', 'TaskOutput'],
  );
  assert.equal(agentCard.subagentState?.childTools[1]?.toolResult?.content, 'Found one authentication issue.');
});

test('normalizedToChatMessages attaches a structured task notification by task id', () => {
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
      id: 'structured-task-notification',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:05.000Z',
      provider: 'claude',
      kind: 'task_notification',
      taskId: 'agent-1',
      status: 'completed',
      summary: 'Authentication review completed',
      result: 'Found one authentication issue.',
      usage: {
        total_tokens: 900,
      },
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  const [agentCard] = chatMessages;
  assert.equal(agentCard.subagentState?.isComplete, true);
  assert.equal(agentCard.toolResult?.content, 'Found one authentication issue.');
  assert.equal(agentCard.taskNotification?.summary, 'Authentication review completed');
  assert.deepEqual(agentCard.taskNotification?.usage, {
    total_tokens: 900,
  });
});
