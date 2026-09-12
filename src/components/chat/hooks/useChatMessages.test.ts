import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { getCancellableHookLoopJobId } from '../utils/hookLoopControls';
import { getHookDisplayFollowups } from '../utils/hookFollowupPresentation';

import { normalizedToChatMessages } from './useChatMessages';

test('live and restored child activity exposes cancellation only while its own loop is active', () => {
  const agent: NormalizedMessage = {
    id: 'agent', sessionId: 'session-1', provider: 'claude', timestamp: '2026-09-12T00:00:01.000Z',
    kind: 'tool_use', toolId: 'agent-call', toolName: 'Agent', toolInput: { description: 'Child' },
  };
  const running: NormalizedMessage = {
    id: 'child-hook', sessionId: 'session-1', provider: 'claude', timestamp: '2026-09-12T00:00:02.000Z',
    kind: 'hook_activity', activityKind: 'execution', agentId: 'child-a', parentToolUseId: 'agent-call',
    toolUseId: 'child-status', actionTypes: ['mcp_loop_run'], status: 'running',
    loopJobId: 'child-loop', loopStatus: 'queued', loopAttemptCount: 2,
  };
  for (const messages of [[agent, running], JSON.parse(JSON.stringify([agent, running]))]) {
    const chat = normalizedToChatMessages(messages);
    assert.equal(chat.length, 1, 'The main timeline has no duplicate child Hook');
    const hook = chat[0].subagentState?.messages?.find((message) => message.type === 'hook')?.hookActivity;
    assert.equal(hook?.loopAttemptCount, 2);
    assert.equal(getCancellableHookLoopJobId(hook), 'child-loop');
    const followups = getHookDisplayFollowups(hook, running.timestamp);
    assert.equal(followups.length, 1, 'Inline child progress fills the shared post-action section');
    assert.equal(followups[0].loopAttemptCount, 2);
    assert.equal(getCancellableHookLoopJobId(followups[0]), 'child-loop');
    assert.deepEqual(hook?.followups, [], 'No main-session follow-up is persisted');
  }
  const cancelled: NormalizedMessage = { ...running, status: 'succeeded', loopStatus: 'cancelled',
    actionResults: [{ actionId: 'loop', actionType: 'mcp_loop_run', output: {
      deliveredTo: 'subagent', agentId: 'child-a', status: 'cancelled',
      toolUseResult: { mcpLoop: true, status: 'cancelled', replacesToolUseId: 'child-status' },
    } }],
  };
  const hook = normalizedToChatMessages([agent, cancelled])[0].subagentState?.messages?.[0]?.hookActivity;
  assert.equal(hook?.loopStatus, 'cancelled');
  assert.equal(getCancellableHookLoopJobId(hook), undefined);
  assert.equal((hook?.loopResult as { status: string }).status, 'cancelled');
});

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

test('child Hook cards preserve agent identity without consuming main-agent output as a Skill follow-up', () => {
  const childExecution: NormalizedMessage = {
    id: 'hook_activity_child-execution_execution', sessionId: 'session-1',
    timestamp: '2026-06-30T00:00:01.000Z', provider: 'claude', kind: 'hook_activity',
    origin: 'hook', activityKind: 'execution', status: 'succeeded',
    jobId: 'hook_activity_child-execution_execution', executionId: 'child-execution',
    hookName: '子代理完成校验', eventName: 'SubagentStop', agentId: 'child-one', agentType: 'reviewer',
    actionTypes: ['invoke_skill'],
  };
  const parentAnswer: NormalizedMessage = {
    id: 'parent-answer', sessionId: 'session-1', timestamp: '2026-06-30T00:00:02.000Z',
    provider: 'claude', kind: 'text', role: 'assistant', content: 'All child tasks are complete.',
  };
  for (const identity of [
    { agentId: 'child-one', agentType: 'reviewer', eventName: 'SubagentStop' },
    { agentId: 'child-one', agentType: 'reviewer', eventName: 'Stop' },
    { agentId: undefined, agentType: undefined, eventName: 'SubagentStop' },
  ]) {
    const result = normalizedToChatMessages([{ ...childExecution, ...identity }, parentAnswer]);
    assert.equal(result.length, 2);
    assert.equal(result[0].hookActivity?.agentId, identity.agentId);
    assert.equal(result[0].hookActivity?.agentType, identity.agentType);
    assert.deepEqual(result[0].hookActivity?.followups, []);
    assert.equal(result[1].id, 'parent-answer');
    assert.equal(result[1].content, parentAnswer.content);
  }
});

test('child inline feedback does not create a recovered parent Skill card from an activity marker', () => {
  const result = normalizedToChatMessages([
    {
      id: 'hook_activity_child-execution_execution', sessionId: 'session-1',
      timestamp: '2026-06-30T00:00:01.000Z', provider: 'claude', kind: 'hook_activity',
      origin: 'hook', activityKind: 'execution', status: 'succeeded',
      jobId: 'hook_activity_child-execution_execution', executionId: 'child-execution',
      agentId: 'child-one', agentType: 'reviewer', eventName: 'SubagentStop', actionTypes: ['invoke_skill'],
    },
    {
      id: 'later-answer', sessionId: 'session-1', timestamp: '2026-06-30T00:00:02.000Z',
      provider: 'claude', kind: 'text', role: 'assistant', content: 'Main answer remains visible.',
      hookActivityId: 'hook_activity_child-execution_skill-action',
    },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].hookActivity?.followups, []);
  assert.equal(result[1].id, 'later-answer');
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

test('normalizedToChatMessages hides action-only Hook cards until a record or MCP call runs', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'hook_activity_custom-record-running_execution',
      sessionId: 'session-1',
      timestamp: '2026-09-03T00:00:00.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'running',
      hookId: 'custom-record',
      hookName: '自定义审计记录',
      actionTypes: ['write_record'],
    },
    {
      id: 'hook_activity_custom-record-skipped_execution',
      sessionId: 'session-1',
      timestamp: '2026-09-03T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      hookId: 'custom-record',
      hookName: '自定义审计记录',
      actionTypes: ['write_record'],
      actionResults: [{
        actionId: 'record-audit',
        actionType: 'write_record',
        output: { recorded: false, reason: 'condition_false' },
      }],
    },
    {
      id: 'hook_activity_custom-mcp-skipped_execution',
      sessionId: 'session-1',
      timestamp: '2026-09-03T00:00:02.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      hookId: 'custom-mcp',
      hookName: '自定义 MCP 检查',
      actionTypes: ['call_mcp_tool'],
      actionResults: [{
        actionId: 'run-check',
        actionType: 'call_mcp_tool',
        output: { called: false, reason: 'condition_false' },
      }],
    },
  ]);

  assert.deepEqual(chatMessages, []);
});

test('normalizedToChatMessages keeps action-only Hook cards for executed actions and failures', () => {
  const chatMessages = normalizedToChatMessages([
    {
      id: 'hook_activity_custom-mcp-executed_execution',
      sessionId: 'session-1',
      timestamp: '2026-09-03T00:00:00.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'succeeded',
      hookId: 'custom-mcp',
      hookName: '自定义 MCP 检查',
      actionTypes: ['call_mcp_tool'],
      actionResults: [{
        actionId: 'run-check',
        actionType: 'call_mcp_tool',
        output: { valid: true, issueCount: 0 },
      }],
    },
    {
      id: 'hook_activity_custom-record-failed_execution',
      sessionId: 'session-1',
      timestamp: '2026-09-03T00:00:01.000Z',
      provider: 'claude',
      kind: 'hook_activity',
      origin: 'hook',
      activityKind: 'execution',
      status: 'failed',
      hookId: 'custom-record',
      hookName: '自定义审计记录',
      actionTypes: ['write_record'],
      error: 'Hook failed',
    },
  ]);

  assert.deepEqual(
    chatMessages.map((message) => message.hookActivity?.status),
    ['succeeded', 'failed'],
  );
});

test('normalizedToChatMessages removes skipped record and MCP results from mixed Hook cards', () => {
  const [hookMessage] = normalizedToChatMessages([{
    id: 'hook_activity_mixed_execution',
    sessionId: 'session-1',
    timestamp: '2026-09-03T00:00:00.000Z',
    provider: 'claude',
    kind: 'hook_activity',
    origin: 'hook',
    activityKind: 'execution',
    status: 'succeeded',
    hookId: 'mixed-hook',
    hookName: '混合动作 Hook',
    actionTypes: ['invoke_skill', 'write_record', 'call_mcp_tool'],
    actionResults: [
      {
        actionId: 'record-if-needed',
        actionType: 'write_record',
        output: { recorded: false, reason: 'condition_false' },
      },
      {
        actionId: 'call-if-needed',
        actionType: 'call_mcp_tool',
        output: { called: false, reason: 'condition_false' },
      },
    ],
  }]);

  assert.equal(hookMessage.hookActivity?.activityKind, 'execution');
  assert.equal(hookMessage.hookActivity?.actionResults, undefined);
});

test('normalizedToChatMessages hides persisted mcp loop scheduling metadata from Hook results', () => {
  const [hookMessage] = normalizedToChatMessages([{
    id: 'hook_activity_execution-loop_execution',
    sessionId: 'session-loop',
    timestamp: '2026-08-31T00:00:00.000Z',
    provider: 'claude',
    kind: 'hook_activity',
    origin: 'hook',
    activityKind: 'execution',
    status: 'succeeded',
    hookId: 'wait-for-task',
    hookName: '等待异步任务完成',
    actionTypes: ['mcp_loop_run', 'write_record'],
    actionResults: [
      {
        actionId: 'wait-status',
        actionType: 'mcp_loop_run',
        output: { scheduled: true, jobId: 'loop-1', status: 'running' },
      },
      {
        actionId: 'audit',
        actionType: 'write_record',
        output: { recorded: true, id: 'record-1' },
      },
    ],
  }]);

  assert.deepEqual(hookMessage.hookActivity?.actionResults?.map((result) => result.actionId), ['audit']);
});

test('inline child MCP loop terminal outcomes remain visible when Hook transport succeeded', () => {
  for (const loopStatus of ['succeeded', 'failed', 'timed_out', 'cancelled']) {
    const finalResult = loopStatus === 'succeeded'
      ? { status: 'done', answer: 42 }
      : loopStatus === 'failed'
        ? { state: 'Rejected', reason: 'Quality check failed' }
        : { mcpLoop: true, status: loopStatus, error: `Loop ${loopStatus}` };
    const [message] = normalizedToChatMessages([{
      id: 'child-loop-execution', sessionId: 'loop-session', provider: 'claude',
      timestamp: '2026-09-10T00:00:00.000Z', kind: 'hook_activity', activityKind: 'execution',
      status: 'succeeded', agentId: 'child-one', agentType: 'worker', eventName: 'PostToolUse',
      actionTypes: ['mcp_loop_run'],
      actionResults: [{
        actionId: 'loop', actionType: 'mcp_loop_run',
        output: {
          scheduled: true, jobId: 'child-job', deliveredTo: 'subagent', agentId: 'child-one',
          status: loopStatus, attemptCount: 3, toolUseResult: finalResult,
        },
      }],
    }]);
    assert.equal(message.hookActivity?.status, 'succeeded', 'The Hook transport status remains unchanged');
    assert.equal(message.hookActivity?.loopStatus, loopStatus);
    assert.equal(message.hookActivity?.loopAttemptCount, 3);
    assert.deepEqual(message.hookActivity?.loopResult, finalResult);
    assert.equal(message.hookActivity?.actionResults, undefined, 'Scheduling metadata is not duplicated as a raw result');
    assert.deepEqual(message.hookActivity?.followups, [], 'Inline child loops do not create a main-session follow-up');
  }
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

test('child loop panels retain the initial result in live and restored transcripts without changing model data', () => {
  for (const restored of [false, true]) {
    const common = { sessionId: 'session-loop', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
    const initial = { status: 'running', task_id: 'task-child', elapsed_ms: 10 };
    const final = { status: 'success', task_id: 'task-child', elapsed_ms: 30000 };
    const childMessages: NormalizedMessage[] = [{
      ...common, id: 'child-status-use', kind: 'tool_use', toolId: 'child-status',
      toolName: 'mcp__demo__get_task_status', parentToolUseId: 'parent-agent',
      toolResult: { content: JSON.stringify(final), isError: false, toolUseResult: final },
    }, {
      ...common, id: 'child-status-result', kind: 'tool_result', toolId: 'child-status',
      content: JSON.stringify(final), toolUseResult: final, parentToolUseId: 'parent-agent',
    }, {
      ...common, id: 'unrelated-use', kind: 'tool_use', toolId: 'other-status',
      toolName: 'mcp__demo__get_task_status', parentToolUseId: 'parent-agent',
      toolResult: { content: 'unrelated-result', isError: false },
    }];
    const messages: NormalizedMessage[] = [{
      ...common, id: 'parent-agent', kind: 'tool_use', toolId: 'parent-agent', toolName: 'Agent',
      ...(restored ? {
        subagentMessages: childMessages,
        subagentTools: [{ toolId: 'child-status', toolName: 'mcp__demo__get_task_status',
          toolResult: childMessages[0].toolResult, timestamp: common.timestamp }],
      } : {}),
    }, ...(restored ? [] : childMessages), {
      ...common, id: 'loop-hook', kind: 'hook_activity', activityKind: 'execution',
      agentId: 'child-agent', toolUseId: 'child-status', status: 'succeeded',
      actionTypes: ['mcp_loop_run'], actionResults: [{
        actionId: 'loop', actionType: 'mcp_loop_run', output: {
          deliveredTo: 'subagent', agentId: 'child-agent', status: 'succeeded',
          initialResult: initial, toolUseResult: final,
        },
      }],
    }];
    const before = JSON.stringify(messages);
    const cards = normalizedToChatMessages(messages);
    const agent = cards.find((card) => card.toolId === 'parent-agent');
    const panelTool = agent?.subagentState?.messages?.find((card) => card.toolId === 'child-status');
    assert.deepEqual(panelTool?.toolResult?.toolUseResult, initial);
    assert.deepEqual(JSON.parse(String(panelTool?.toolResult?.content)), initial);
    assert.deepEqual(JSON.parse(String(agent?.subagentState?.childTools?.find((tool) => tool.toolId === 'child-status')?.toolResult?.content)), initial);
    assert.equal(agent?.subagentState?.messages?.find((card) => card.toolId === 'other-status')?.toolResult?.content, 'unrelated-result');
    assert.equal(cards.some((card) => card.type === 'hook'), false, 'Child Hooks do not duplicate into the main conversation');
    assert.deepEqual(agent?.subagentState?.messages?.find((card) => card.type === 'hook')?.hookActivity?.loopResult, final);
    assert.equal(JSON.stringify(messages), before, 'Rendering must not mutate model-facing data');
  }
});

test('child Hook cards route into concurrent child timelines for live and historical tool events', () => {
  const common = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
  for (const history of ['live', 'transcript', 'compact']) {
    for (const status of ['running', 'succeeded', 'failed']) {
      const messages: NormalizedMessage[] = [];
      for (const child of ['a', 'b']) {
        const tool: NormalizedMessage = {
          ...common, id: `tool-${child}`, kind: 'tool_use', toolId: `tool-${child}`,
          toolName: 'mcp__demo__status', parentToolUseId: `agent-${child}`,
          toolResult: { content: 'running', isError: false },
        };
        messages.push({
          ...common, id: `agent-${child}`, toolId: `agent-${child}`, kind: 'tool_use', toolName: 'Agent',
          toolInput: { subagent_type: 'general-purpose' },
          ...(history === 'transcript' ? { subagentMessages: [tool] } : {}),
          ...(history === 'compact' ? { subagentTools: [tool] } : {}),
        });
        if (history === 'live') messages.push(tool);
      }
      for (const child of ['b', 'a']) {
        messages.push({
          ...common, id: `hook-${child}`, kind: 'hook_activity', activityKind: 'execution',
          timestamp: '2026-09-12T00:00:01.000Z', status, agentId: `child-${child}`,
          agentType: 'general-purpose', toolUseId: `tool-${child}`, actionTypes: ['mcp_loop_run'],
        });
      }
      messages.push({ ...common, id: 'main-hook', kind: 'hook_activity', status, eventName: 'Stop' });
      const result = normalizedToChatMessages(messages);
      assert.deepEqual(result.map((card) => card.id), ['agent-a', 'agent-b', 'main-hook']);
      for (const child of ['a', 'b']) {
        const timeline = result.find((card) => card.toolId === `agent-${child}`)?.subagentState?.messages || [];
        assert.deepEqual(timeline.map((card) => card.toolId || card.id), [`tool-${child}`, `hook-${child}`]);
        assert.equal(timeline[1].hookActivity?.status, status);
        assert.equal(timeline[1].hookActivity?.agentId, `child-${child}`);
      }
    }
  }
});

test('child Hooks route by explicit parent before tools arrive and by agent identity on SubagentStop', () => {
  const common = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
  for (const hookIdentity of [
    { parentToolUseId: 'agent-tool', agentId: 'child-a', eventName: 'PreToolUse' },
    { agentId: 'child-a', eventName: 'SubagentStop' },
  ]) {
    const result = normalizedToChatMessages([{
      ...common, id: 'agent', toolId: 'agent-tool', kind: 'tool_use', toolName: 'Agent', agentId: 'child-a',
    }, {
      ...common, id: 'child-hook', kind: 'hook_activity', status: 'running', ...hookIdentity,
    }, {
      ...common, id: 'main-answer', kind: 'text', role: 'assistant', content: 'Parent answer',
    }]);
    assert.deepEqual(result.map((card) => card.id), ['agent', 'main-answer']);
    assert.equal(result[0].subagentState?.messages?.[0].id, 'child-hook');
  }
});

test('unresolved child Hooks stay visible and do not attach to a same-type unrelated agent', () => {
  const common = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
  const result = normalizedToChatMessages([{
    ...common, id: 'agent', toolId: 'agent-tool', kind: 'tool_use', toolName: 'Agent', agentId: 'child-a',
    toolInput: { subagent_type: 'general-purpose' },
  }, {
    ...common, id: 'orphan', kind: 'hook_activity', agentId: 'unknown-child', agentType: 'general-purpose',
  }, {
    ...common, id: 'other-session', kind: 'hook_activity', sessionId: 's2', agentId: 'child-a',
  }]);
  assert.deepEqual(result.map((card) => card.id), ['agent', 'orphan', 'other-session']);
  assert.deepEqual(result[0].subagentState?.messages, []);
});

test('child Hook cards follow a legacy Task alias into the canonical Agent panel without duplication', () => {
  const common = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
  for (const explicitParent of [false, true]) {
    const result = normalizedToChatMessages([{
      ...common, id: 'legacy', toolId: 'legacy', kind: 'tool_use', toolName: 'Task', agentId: 'child-a',
    }, {
      ...common, id: 'hook', kind: 'hook_activity', agentId: 'child-a', status: 'succeeded',
      ...(explicitParent ? { parentToolUseId: 'legacy' } : {}),
    }, {
      ...common, id: 'agent', toolId: 'agent', kind: 'tool_use', toolName: 'Agent', agentId: 'child-a',
    }]);
    assert.equal(result.some((card) => card.type === 'hook'), false);
    assert.deepEqual(result.find((card) => card.toolId === 'agent')?.subagentState?.messages?.map((card) => card.id), ['hook']);
  }
});

test('child loop display snapshots require the exact session, tool and child identity', () => {
  const common = { sessionId: 's1', provider: 'claude' as const, timestamp: '2026-09-12T00:00:00.000Z' };
  for (const mismatch of [
    { sessionId: 'other-session' }, { toolUseId: 'other-tool' }, { agentId: 'other-agent' },
  ]) {
    const cards = normalizedToChatMessages([{
      ...common, id: 'tool', kind: 'tool_use', toolId: 'tool', toolName: 'mcp__demo__status',
      toolResult: { content: 'original', isError: false },
    }, {
      ...common, id: 'hook', kind: 'hook_activity', toolUseId: 'tool', agentId: 'child', ...mismatch,
      actionResults: [{ actionId: 'loop', actionType: 'mcp_loop_run',
        output: { deliveredTo: 'subagent', agentId: 'child', initialResult: { status: 'running' } } }],
    }]);
    assert.equal(cards[0].toolResult?.content, 'original');
  }
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

test('normalizedToChatMessages preserves a restored running child identity and two tools without a parent result', () => {
  const invocation: NormalizedMessage = {
    id: 'running-agent', sessionId: 'session-1', timestamp: '2026-09-11T08:00:00.000Z', provider: 'claude',
    kind: 'tool_use', toolName: 'Agent', toolId: 'parent-agent-tool', agentId: 'restored-child',
    toolInput: { description: 'Wait for the twenty-minute task', run_in_background: false },
    subagentTools: [
      {
        toolId: 'execute-task', toolName: 'mcp__tasks__execute_task', toolInput: {},
        timestamp: '2026-09-11T08:00:01.000Z',
        toolResult: { content: '{"task_id":"task-1","status":"running"}', isError: false },
      },
      {
        toolId: 'get-status', toolName: 'mcp__tasks__get_task_status', toolInput: { task_id: 'task-1' },
        timestamp: '2026-09-11T08:00:02.000Z',
      },
    ],
  };
  const [agentCard] = normalizedToChatMessages([invocation]);
  assert.equal(agentCard.subagentState?.agentId, 'restored-child');
  assert.equal(agentCard.subagentState?.isComplete, false);
  assert.equal(agentCard.toolResult, null);
  assert.equal(agentCard.toolCompletedAt, undefined);
  assert.deepEqual(agentCard.subagentState?.childTools.map((tool) => tool.toolId), ['execute-task', 'get-status']);
  assert.equal(agentCard.subagentState?.childTools[0].toolResult?.content, '{"task_id":"task-1","status":"running"}');
  assert.equal(agentCard.subagentState?.childTools[1].toolResult, null);

  const cardsWithProgress = normalizedToChatMessages([invocation, {
    id: 'child-progress', sessionId: 'session-1', timestamp: '2026-09-11T08:01:00.000Z', provider: 'claude',
    kind: 'task_notification', taskId: 'restored-child', status: 'running', summary: 'Still waiting for the task',
  }]);
  assert.equal(cardsWithProgress.length, 1, 'A later task-id-only update must associate with the restored invocation');
  assert.equal(cardsWithProgress[0].taskNotification?.summary, 'Still waiting for the task');
  assert.equal(cardsWithProgress[0].subagentState?.isComplete, false);
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
