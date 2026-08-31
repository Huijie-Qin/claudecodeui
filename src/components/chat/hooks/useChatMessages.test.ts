import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

test('normalizedToChatMessages renders an orphan Hook follow-up as a distinct message type', () => {
  const [hookMessage] = normalizedToChatMessages([{
    id: 'hook_activity_execution-1_action-1',
    sessionId: 'session-1',
    timestamp: '2026-06-30T00:00:02.000Z',
    provider: 'claude',
    kind: 'hook_activity',
    origin: 'hook',
    status: 'queued',
    jobId: 'hook_activity_execution-1_action-1',
    executionId: undefined,
    hookId: 'notify-on-stop',
    hookName: '对话正常结束通知',
    actionId: 'send-message',
    actionType: 'send_agent_message',
    summary: '请总结本轮结果',
    queuePosition: 1,
  }]);

  assert.equal(hookMessage.type, 'hook');
  assert.equal(hookMessage.isHookActivity, true);
  assert.deepEqual(hookMessage.hookActivity, {
    jobId: 'hook_activity_execution-1_action-1',
    executionId: undefined,
    hookId: 'notify-on-stop',
    hookName: '对话正常结束通知',
    activityKind: undefined,
    actionId: 'send-message',
    actionType: 'send_agent_message',
    eventName: undefined,
    actionTypes: undefined,
    hasScript: undefined,
    skillName: undefined,
    summary: '请总结本轮结果',
    queuePosition: 1,
    status: 'queued',
    error: undefined,
    followups: undefined,
  });
});

test('normalizedToChatMessages groups a Hook follow-up into its execution card', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'hook_activity_execution-1_execution',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: 'hook_activity_execution-1_execution',
      executionId: 'execution-1',
      hookId: 'notify-on-stop',
      hookName: '对话正常结束通知',
      eventName: 'Stop',
      actionTypes: ['invoke_skill'],
    },
    {
      id: 'hook_activity_execution-1_notify',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'followup',
      status: 'succeeded',
      jobId: 'hook_activity_execution-1_notify',
      executionId: 'execution-1',
      hookId: 'notify-on-stop',
      hookName: '对话正常结束通知',
      actionId: 'notify',
      actionType: 'invoke_skill',
      skillName: 'hook-notification',
      summary: '/hook-notification status=success',
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].hookActivity?.activityKind, 'execution');
  assert.deepEqual(chatMessages[0].hookActivity?.followups, [{
    jobId: 'hook_activity_execution-1_notify',
    executionId: 'execution-1',
    actionId: 'notify',
    actionType: 'invoke_skill',
    skillName: 'hook-notification',
    summary: '/hook-notification status=success',
    queuePosition: undefined,
    status: 'succeeded',
    error: undefined,
    timestamp: '2026-06-30T00:00:02.000Z',
    messages: undefined,
  }]);
});

test('normalizedToChatMessages nests Hook recovery output under its follow-up', () => {
  const activityId = 'hook_activity_execution-1_notify';
  const chatMessages = normalizedToChatMessages([
    {
      id: 'hook_activity_execution-1_execution',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: 'hook_activity_execution-1_execution',
      executionId: 'execution-1',
      hookId: 'notify-on-stop',
      hookName: '对话正常结束通知',
      eventName: 'Stop',
      actionTypes: ['invoke_skill'],
    },
    {
      id: activityId,
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'followup',
      status: 'succeeded',
      jobId: activityId,
      executionId: 'execution-1',
      hookId: 'notify-on-stop',
      hookName: '对话正常结束通知',
      actionId: 'notify',
      actionType: 'invoke_skill',
      skillName: 'hook-notification',
    },
    {
      id: 'recovery-thinking',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:03.000Z',
      provider: 'claude',
      kind: 'thinking',
      content: 'Record the notification.',
      hookActivityId: activityId,
    },
    {
      id: 'recovery-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:04.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'HOOK_NOTIFICATION_SKILL_EXECUTED',
      hookActivityId: activityId,
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.deepEqual(
    chatMessages[0].hookActivity?.followups?.[0].messages?.map((message) => message.id),
    ['recovery-thinking', 'recovery-result'],
  );
  assert.equal(
    chatMessages[0].hookActivity?.followups?.[0].messages?.[1].content,
    'HOOK_NOTIFICATION_SKILL_EXECUTED',
  );
});

test('normalizedToChatMessages recovers a missing legacy follow-up from its activity prefix', () => {
  const executionId = 'e412c904-92d8-4551-9e6f-b1359d7e017b';
  const activityId = `hook_activity_${executionId}_notify-normal-stop`;
  const chatMessages = normalizedToChatMessages([
    {
      id: `hook_activity_${executionId}_execution`,
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: `hook_activity_${executionId}_execution`,
      executionId,
      hookName: '对话正常结束通知',
      actionTypes: ['invoke_skill'],
    },
    {
      id: 'legacy-recovery-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'HOOK_NOTIFICATION_SKILL_EXECUTED',
      hookActivityId: activityId,
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].hookActivity?.followups?.length, 1);
  assert.equal(chatMessages[0].hookActivity?.followups?.[0].jobId, activityId);
  assert.equal(chatMessages[0].hookActivity?.followups?.[0].actionType, 'invoke_skill');
  assert.equal(
    chatMessages[0].hookActivity?.followups?.[0].messages?.[0].content,
    'HOOK_NOTIFICATION_SKILL_EXECUTED',
  );
});

test('normalizedToChatMessages recovers pre-marker Skill output within the Stop turn boundary', () => {
  const executionId = 'legacy-execution';
  const chatMessages = normalizedToChatMessages([
    {
      id: `hook_activity_${executionId}_execution`,
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: `hook_activity_${executionId}_execution`,
      executionId,
      hookName: '对话正常结束通知',
      actionTypes: ['invoke_skill'],
    },
    {
      id: 'legacy-thinking',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude',
      kind: 'thinking',
      content: 'Record the notification.',
    },
    {
      id: 'legacy-result',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:03.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'HOOK_NOTIFICATION_SKILL_EXECUTED',
    },
    {
      id: 'next-user',
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:04.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'user',
      content: 'Next question',
    },
  ]);

  assert.equal(chatMessages.length, 2);
  assert.deepEqual(
    chatMessages[0].hookActivity?.followups?.[0].messages?.map((message) => message.id),
    ['legacy-thinking', 'legacy-result'],
  );
  assert.equal(chatMessages[1].id, 'next-user');
});

test('normalizedToChatMessages groups legacy Hook activities by their shared job id prefix', () => {
  const executionId = 'e412c904-92d8-4551-9e6f-b1359d7e017b';
  const chatMessages = normalizedToChatMessages([
    {
      id: `hook_activity_${executionId}_execution`,
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: `hook_activity_${executionId}_execution`,
      hookName: '对话正常结束通知',
    },
    {
      id: `hook_activity_${executionId}_notify-normal-stop`,
      sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'followup',
      status: 'succeeded',
      jobId: `hook_activity_${executionId}_notify-normal-stop`,
      hookName: '对话正常结束通知',
      skillName: 'hook-notification',
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].hookActivity?.followups?.length, 1);
});

test('normalizedToChatMessages preserves generic Hook execution details', () => {
  const [hookMessage] = normalizedToChatMessages([{
    id: 'hook_activity_execution-2_execution',
    sessionId: 'session-1',
    timestamp: '2026-06-30T00:00:01.000Z',
    provider: 'claude',
    kind: 'hook_activity',
    origin: 'hook',
    activityKind: 'execution',
    status: 'succeeded',
    hookId: 'sql-check',
    hookName: 'SQL Check 强制校验',
    eventName: 'Stop',
    actionTypes: ['call_mcp_tool'],
    actionResults: [{
      actionId: 'check-sql',
      actionType: 'call_mcp_tool',
      output: { valid: true, issueCount: 0 },
    }],
    hasScript: true,
    summary: '校验模型返回的 SQL。',
  }]);

  assert.equal(hookMessage.hookActivity?.activityKind, 'execution');
  assert.equal(hookMessage.hookActivity?.eventName, 'Stop');
  assert.deepEqual(hookMessage.hookActivity?.actionTypes, ['call_mcp_tool']);
  assert.deepEqual(hookMessage.hookActivity?.actionResults, [{
    actionId: 'check-sql',
    actionType: 'call_mcp_tool',
    output: { valid: true, issueCount: 0 },
  }]);
  assert.equal(hookMessage.hookActivity?.hasScript, true);
});

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

test('normalizedToChatMessages keeps the original MCP result on the tool card after a loop replacement', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'status-tool-use',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolName: 'mcp__demo__get_task_status',
      toolId: 'toolu_status_1',
      toolInput: { task_id: 'task-1' },
      toolResult: {
        content: JSON.stringify({ task_id: 'task-1', status: 'running' }),
        isError: false,
      },
    },
    {
      id: 'original-running-result',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:00.100Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_status_1',
      content: JSON.stringify({ task_id: 'task-1', status: 'running' }),
      toolUseResult: { task_id: 'task-1', status: 'running' },
      isError: false,
    },
    {
      id: 'mcp-loop-final-result',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:01.000Z',
      provider: 'claude',
      kind: 'tool_result',
      toolId: 'toolu_status_1',
      content: JSON.stringify({ task_id: 'task-1', status: 'success' }),
      toolUseResult: { task_id: 'task-1', status: 'success' },
      isError: false,
      mcpLoopReplacement: true,
      mcpLoopJobId: 'loop-1',
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].toolId, 'toolu_status_1');
  assert.deepEqual(chatMessages[0].toolResult?.toolUseResult, {
    task_id: 'task-1',
    status: 'running',
  });
  assert.match(String(chatMessages[0].toolResult?.content || ''), /running/);
});

test('normalizedToChatMessages attaches the final MCP loop result to its Hook card', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'hook-loop-execution',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:00.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      jobId: 'hook-loop-execution',
      executionId: 'execution-loop-1',
      hookId: 'wait-for-task',
      hookName: '等待异步任务完成',
      actionTypes: ['mcp_loop_run'],
    },
    {
      id: 'hook-loop-followup',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'followup',
      status: 'succeeded',
      jobId: 'hook-loop-followup',
      executionId: 'execution-loop-1',
      hookId: 'wait-for-task',
      hookName: '等待异步任务完成',
      actionId: 'loop-action',
      actionType: 'mcp_loop_run',
      loopJobId: 'loop-1',
      loopAttemptCount: 3,
    },
    {
      id: 'mcp-loop-final-result',
      sessionId: 'session-loop',
      timestamp: '2026-08-28T00:00:01.100Z',
      provider: 'claude',
      kind: 'tool_result',
      origin: 'hook',
      toolId: 'toolu_status_1',
      content: JSON.stringify({ task_id: 'task-1', status: 'success' }),
      toolUseResult: { task_id: 'task-1', status: 'success' },
      isError: false,
      mcpLoopReplacement: true,
      mcpLoopJobId: 'loop-1',
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.deepEqual(chatMessages[0].hookActivity?.followups?.[0].loopResult, {
    task_id: 'task-1',
    status: 'success',
  });
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
  assert.equal(agentCard.subagentState?.agentId, 'agent-1');
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

test('normalizedToChatMessages completes a running Agent card when manual stop arrives', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'agent-tool-use', sessionId: 'session-1', timestamp: '2026-08-31T00:00:00.000Z',
      provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_1',
      toolInput: { description: 'Review authentication', run_in_background: true },
      toolResult: {
        content: 'Agent launched.', isError: false,
        toolUseResult: { status: 'async_launched', agentId: 'agent-1' },
      },
    },
    {
      id: 'agent-stopped', sessionId: 'session-1', timestamp: '2026-08-31T00:00:05.000Z',
      provider: 'claude', kind: 'task_notification', taskId: 'agent-1',
      toolUseId: 'toolu_agent_1', status: 'stopped', summary: 'Stopped by user', usage: {},
    },
  ]);

  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0]?.subagentState?.isComplete, true);
  assert.equal(chatMessages[0]?.taskStatus, 'stopped');
  assert.equal(chatMessages[0]?.toolResult?.content, 'Stopped by user');
  assert.equal(chatMessages[0]?.toolResult?.isError, true);
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

test('normalizedToChatMessages routes all realtime subagent output into its Agent panel', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-tool-use', sessionId: 'session-1', timestamp: '2026-06-30T00:00:00.000Z',
      provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_1',
      toolInput: { description: 'Inspect output' },
    },
    {
      id: 'subagent-thinking', sessionId: 'session-1', timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude', kind: 'thinking', content: 'I should inspect the file.',
      parentToolUseId: 'toolu_agent_1',
    },
    {
      id: 'subagent-text', sessionId: 'session-1', timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude', kind: 'text', role: 'assistant', content: 'The issue is in auth.ts.',
      parentToolUseId: 'toolu_agent_1',
    },
    {
      id: '__streaming_session-1_toolu_agent_1_1', sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:03.000Z', provider: 'claude', kind: 'stream_delta',
      content: 'Streaming detail', parentToolUseId: 'toolu_agent_1',
    },
  ];

  const chatMessages = normalizedToChatMessages(messages);

  assert.equal(chatMessages.length, 1);
  assert.deepEqual(
    chatMessages[0]?.subagentState?.messages?.map((message) => ({
      content: message.content,
      isThinking: message.isThinking,
      isStreaming: message.isStreaming,
    })),
    [
      { content: 'I should inspect the file.', isThinking: true, isStreaming: undefined },
      { content: 'The issue is in auth.ts.', isThinking: undefined, isStreaming: undefined },
      { content: 'Streaming detail', isThinking: undefined, isStreaming: true },
    ],
  );
});

test('normalizedToChatMessages restores the complete attached subagent transcript', () => {
  const attached: NormalizedMessage[] = [
    {
      id: 'history-text', sessionId: 'session-1', timestamp: '2026-06-30T00:00:01.000Z',
      provider: 'claude', kind: 'text', role: 'assistant', content: 'Historical answer.',
      parentToolUseId: 'toolu_agent_1',
    },
  ];
  const [agentCard] = normalizedToChatMessages([{
    id: 'agent-tool-use', sessionId: 'session-1', timestamp: '2026-06-30T00:00:00.000Z',
    provider: 'claude', kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_1',
    toolInput: { description: 'Restore output' }, subagentMessages: attached,
  }]);

  assert.equal(agentCard?.subagentState?.messages?.[0]?.content, 'Historical answer.');
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

test('normalizedToChatMessages routes reused task ids to the invocation active at each event', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-a', sessionId: 'session-1', timestamp: '2026-06-30T01:00:00.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_a',
      toolInput: { description: 'First pass', run_in_background: true },
      toolResult: { content: 'launched', isError: false, toolUseResult: { status: 'async_launched', agentId: 'agent-shared' } },
    },
    {
      id: 'output-a', sessionId: 'session-1', timestamp: '2026-06-30T01:00:01.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'TaskOutput', toolId: 'toolu_output_a',
      toolInput: { task_id: 'agent-shared', block: true, timeout: 1000 },
    },
    {
      id: 'output-a-result', sessionId: 'session-1', timestamp: '2026-06-30T01:00:01.100Z', provider: 'claude',
      kind: 'tool_result', toolId: 'toolu_output_a', isError: false,
      content: '<status>completed</status><output>First result</output>',
    },
    {
      id: 'agent-b', sessionId: 'session-1', timestamp: '2026-06-30T01:00:02.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_b',
      toolInput: { description: 'Second pass', resume: 'agent-shared', run_in_background: true },
      toolResult: { content: 'resumed', isError: false, toolUseResult: { status: 'async_launched', agentId: 'agent-shared' } },
    },
    {
      id: 'read-b', sessionId: 'session-1', timestamp: '2026-06-30T01:00:03.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Read', toolId: 'toolu_read_b', parentToolUseId: 'toolu_agent_b',
      toolInput: { file_path: '/workspace/current.ts' },
    },
    {
      id: 'output-b', sessionId: 'session-1', timestamp: '2026-06-30T01:00:04.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'TaskOutput', toolId: 'toolu_output_b',
      toolInput: { task_id: 'agent-shared', block: false, timeout: 1000 },
    },
    {
      id: 'output-b-result', sessionId: 'session-1', timestamp: '2026-06-30T01:00:04.100Z', provider: 'claude',
      kind: 'tool_result', toolId: 'toolu_output_b', isError: false,
      content: '<status>running</status>',
    },
  ];

  const cards = normalizedToChatMessages(messages).filter((message) => message.isSubagentContainer);
  const first = cards.find((message) => message.toolId === 'toolu_agent_a');
  const second = cards.find((message) => message.toolId === 'toolu_agent_b');

  assert.equal(first?.subagentState?.isComplete, true);
  assert.match(String(first?.toolResult?.content), /First result/);
  assert.equal(second?.subagentState?.isComplete, false);
  assert.equal(second?.toolResult, null);
  assert.deepEqual(second?.subagentState?.childTools.map((tool) => tool.toolName), ['Read', 'TaskOutput']);
});

test('normalizedToChatMessages lets newer child activity supersede an old terminal notification', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-tool', sessionId: 'session-1', timestamp: '2026-06-30T02:00:00.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent',
      toolInput: { description: 'Interactive pass', run_in_background: true },
      toolResult: { content: 'launched', isError: false, toolUseResult: { status: 'async_launched', agentId: 'agent-1' } },
    },
    {
      id: 'old-terminal', sessionId: 'session-1', timestamp: '2026-06-30T02:00:01.000Z', provider: 'claude',
      kind: 'task_notification', taskId: 'agent-1', toolUseId: 'toolu_agent', status: 'completed',
      summary: 'Old completion', result: 'Old result', usage: {},
    },
    {
      id: 'new-read', sessionId: 'session-1', timestamp: '2026-06-30T02:00:02.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Read', toolId: 'toolu_read', parentToolUseId: 'toolu_agent',
      toolInput: { file_path: '/workspace/new.ts' },
    },
  ];

  const [agentCard] = normalizedToChatMessages(messages);
  assert.equal(agentCard.subagentState?.isComplete, false);
  assert.equal(agentCard.toolResult, null);
  assert.equal(agentCard.subagentState?.childTools[0]?.toolName, 'Read');
});

test('normalizedToChatMessages restores subagent tools when tool use and result came from separate pages', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-use', sessionId: 'session-1', timestamp: '2026-06-30T03:00:00.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent',
      toolInput: { description: 'Paged history' },
    },
    {
      id: 'agent-result', sessionId: 'session-1', timestamp: '2026-06-30T03:00:01.000Z', provider: 'claude',
      kind: 'tool_result', toolId: 'toolu_agent', content: 'Complete', isError: false,
      toolUseResult: { status: 'completed', agentId: 'agent-1' },
      subagentTools: [{
        toolId: 'toolu_read',
        toolName: 'Read',
        toolInput: { file_path: '/workspace/paged.ts' },
        toolResult: { content: 'source', isError: false },
        timestamp: '2026-06-30T03:00:00.500Z',
      }],
    },
  ];

  const [agentCard] = normalizedToChatMessages(messages);
  assert.deepEqual(agentCard.subagentState?.childTools.map((tool) => tool.toolId), ['toolu_read']);
  assert.equal(agentCard.subagentState?.childTools[0]?.toolResult?.content, 'source');
});

test('normalizedToChatMessages lets newer restored activity supersede an old terminal notification', () => {
  const messages: NormalizedMessage[] = [
    {
      id: 'agent-use', sessionId: 'session-1', timestamp: '2026-06-30T04:00:00.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent',
      toolInput: { description: 'Restored interactive pass', run_in_background: true },
      toolResult: { content: 'launched', isError: false, toolUseResult: { status: 'async_launched', agentId: 'agent-1' } },
      subagentTools: [{
        toolId: 'toolu_read_new',
        toolName: 'Read',
        toolInput: { file_path: '/workspace/new.ts' },
        timestamp: '2026-06-30T04:00:02.000Z',
      }],
    },
    {
      id: 'old-terminal', sessionId: 'session-1', timestamp: '2026-06-30T04:00:01.000Z', provider: 'claude',
      kind: 'task_notification', taskId: 'agent-1', toolUseId: 'toolu_agent', status: 'completed',
      summary: 'Old completion', result: 'Old result', usage: {},
    },
  ];

  const [agentCard] = normalizedToChatMessages(messages);
  assert.equal(agentCard.subagentState?.isComplete, false);
  assert.equal(agentCard.toolResult, null);
  assert.deepEqual(agentCard.subagentState?.childTools.map((tool) => tool.toolId), ['toolu_read_new']);
});

test('normalizedToChatMessages surfaces a background subagent launch failure as terminal', () => {
  const [agentCard] = normalizedToChatMessages([{
    id: 'agent-use', sessionId: 'session-1', timestamp: '2026-06-30T05:00:00.000Z', provider: 'claude',
    kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent',
    toolInput: { description: 'Failing launch', run_in_background: true },
    toolResult: {
      content: 'Unable to launch subagent',
      isError: true,
      toolUseResult: { status: 'failed' },
    },
  }]);

  assert.equal(agentCard.subagentState?.isComplete, true);
  assert.equal(agentCard.toolResult?.isError, true);
  assert.equal(agentCard.toolResult?.content, 'Unable to launch subagent');
});

test('normalizedToChatMessages does not pair a current Agent alias with an older unmatched Task', () => {
  const subagentResult = {
    content: 'launched',
    isError: false,
    toolUseResult: { status: 'async_launched', agentId: 'agent-shared' },
  };
  const messages: NormalizedMessage[] = [
    {
      id: 'task-old', sessionId: 'session-1', timestamp: '2026-06-30T06:00:00.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Task', toolId: 'toolu_task_old',
      toolInput: { description: 'Old unmatched generation', run_in_background: true },
      toolResult: subagentResult,
    },
    {
      id: 'task-current', sessionId: 'session-1', timestamp: '2026-06-30T06:00:01.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Task', toolId: 'toolu_task_current',
      toolInput: { description: 'Current generation', run_in_background: true },
      toolResult: subagentResult,
    },
    {
      id: 'agent-current', sessionId: 'session-1', timestamp: '2026-06-30T06:00:01.100Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Agent', toolId: 'toolu_agent_current',
      toolInput: { description: 'Current generation', resume: 'agent-shared', run_in_background: true },
      toolResult: subagentResult,
    },
    {
      id: 'read-current', sessionId: 'session-1', timestamp: '2026-06-30T06:00:02.000Z', provider: 'claude',
      kind: 'tool_use', toolName: 'Read', toolId: 'toolu_read_current',
      parentToolUseId: 'toolu_agent_current', toolInput: { file_path: '/workspace/current.ts' },
    },
  ];

  const cards = normalizedToChatMessages(messages).filter((message) => message.isSubagentContainer);
  const oldTask = cards.find((message) => message.toolId === 'toolu_task_old');
  const currentTask = cards.find((message) => message.toolId === 'toolu_task_current');
  const currentAgent = cards.find((message) => message.toolId === 'toolu_agent_current');

  assert.equal(oldTask?.subagentState?.detailsOwnerToolId, undefined);
  assert.equal(currentTask?.subagentState?.detailsOwnerToolId, 'toolu_agent_current');
  assert.deepEqual(currentAgent?.subagentState?.childTools.map((tool) => tool.toolId), [
    'toolu_read_current',
  ]);
});
