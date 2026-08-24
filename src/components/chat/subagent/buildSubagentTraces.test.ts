import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, TaskNotificationDetails } from '../types/types';

import { buildSubagentTraces } from './buildSubagentTraces';

function notification(
  status: string,
  result?: string,
  usage: TaskNotificationDetails['usage'] = {},
): TaskNotificationDetails {
  return {
    status,
    summary: `${status} summary`,
    result,
    usage,
    extraFields: {},
    raw: '',
  };
}

function subagentMessage(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'toolId' | 'timestamp'>): ChatMessage {
  return {
    type: 'assistant',
    content: '',
    isToolUse: true,
    isSubagentContainer: true,
    toolName: 'Agent',
    toolInput: {},
    subagentState: {
      childTools: [],
      currentToolIndex: -1,
      isComplete: false,
    },
    ...overrides,
  };
}

test('buildSubagentTraces keeps concurrent subagent activity isolated and ordered', () => {
  const messages: ChatMessage[] = [
    subagentMessage({
      toolId: 'agent-a',
      timestamp: '2026-08-17T01:00:00.000Z',
      toolInput: {
        description: 'Review API',
        subagent_type: 'reviewer',
        prompt: 'Review the API implementation.',
      },
      subagentState: {
        currentToolIndex: 1,
        isComplete: false,
        childTools: [
          {
            toolId: 'bash-a',
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolResult: null,
            timestamp: new Date('2026-08-17T01:00:03.000Z'),
          },
          {
            toolId: 'read-a',
            toolName: 'Read',
            toolInput: { file_path: '/workspace/api.ts' },
            toolResult: { content: 'source' },
            timestamp: new Date('2026-08-17T01:00:01.000Z'),
          },
        ],
      },
    }),
    subagentMessage({
      toolId: 'agent-b',
      timestamp: '2026-08-17T01:00:00.500Z',
      toolInput: { description: 'Review UI' },
      subagentState: {
        currentToolIndex: 0,
        isComplete: false,
        childTools: [{
          toolId: 'read-b',
          toolName: 'Read',
          toolInput: { file_path: '/workspace/ui.tsx' },
          toolResult: null,
          timestamp: new Date('2026-08-17T01:00:02.000Z'),
        }],
      },
    }),
  ];

  const traces = buildSubagentTraces(messages);

  assert.deepEqual(traces.map((trace) => trace.id), ['agent-a', 'agent-b']);
  assert.deepEqual(
    traces[0]?.activities.map((activity) => activity.toolId),
    ['read-a', 'bash-a'],
  );
  assert.deepEqual(
    traces[0]?.activities.map((activity) => activity.status),
    ['completed', 'running'],
  );
  assert.deepEqual(
    traces[1]?.activities.map((activity) => activity.toolId),
    ['read-b'],
  );
  assert.equal(traces[0]?.activities[0]?.summary, 'Read api.ts');
});

test('buildSubagentTraces merges a legacy Task alias into its non-alias Agent owner', () => {
  const alias = subagentMessage({
    toolId: 'task-legacy',
    toolName: 'Task',
    timestamp: '2026-08-17T02:00:00.000Z',
    toolInput: {
      description: 'Legacy description',
      prompt: 'Legacy prompt',
    },
    subagentState: {
      currentToolIndex: 0,
      isComplete: false,
      detailsOwnerToolId: 'agent-owner',
      childTools: [{
        toolId: 'shared-read',
        toolName: 'Read',
        toolInput: { file_path: '/workspace/auth.ts' },
        toolResult: null,
        timestamp: new Date('2026-08-17T02:00:01.000Z'),
      }],
    },
  });
  const owner = subagentMessage({
    toolId: 'agent-owner',
    timestamp: '2026-08-17T02:00:00.100Z',
    toolInput: JSON.stringify({
      description: 'Review authentication',
      subagent_type: 'security-reviewer',
      prompt: 'Find authentication flaws.',
    }),
    subagentState: {
      currentToolIndex: 1,
      isComplete: true,
      childTools: [
        {
          toolId: 'shared-read',
          toolName: 'Read',
          toolInput: { file_path: '/workspace/auth.ts' },
          toolResult: { content: 'auth source' },
          timestamp: new Date('2026-08-17T02:00:01.000Z'),
        },
        {
          toolId: 'grep-owner',
          toolName: 'Grep',
          toolInput: { pattern: 'password' },
          toolResult: { content: 'one match' },
          timestamp: new Date('2026-08-17T02:00:02.000Z'),
        },
      ],
    },
    toolResult: {
      content: 'Found one issue.',
      timestamp: '2026-08-17T02:00:03.000Z',
    },
    toolCompletedAt: '2026-08-17T02:00:03.000Z',
    taskNotification: notification('completed', 'Found one issue.', { total_tokens: 900 }),
  });

  const [trace] = buildSubagentTraces([alias, owner]);

  assert.equal(buildSubagentTraces([alias, owner]).length, 1);
  assert.equal(trace?.id, 'agent-owner');
  assert.deepEqual(trace?.sourceToolIds, ['agent-owner', 'task-legacy']);
  assert.equal(trace?.description, 'Review authentication');
  assert.equal(trace?.agentType, 'security-reviewer');
  assert.equal(trace?.prompt, 'Find authentication flaws.');
  assert.equal(trace?.title, 'Subagent / security-reviewer: Review authentication');
  assert.equal(trace?.startedAt.toISOString(), '2026-08-17T02:00:00.000Z');
  assert.equal(trace?.completedAt?.toISOString(), '2026-08-17T02:00:03.000Z');
  assert.deepEqual(trace?.activities.map((activity) => activity.toolId), [
    'shared-read',
    'grep-owner',
  ]);
  assert.equal(trace?.activities[0]?.toolResult?.content, 'auth source');
  assert.equal(trace?.result, 'Found one issue.');
  assert.deepEqual(trace?.usage, { total_tokens: 900 });
});

test('buildSubagentTraces derives running, waiting, completed, and error states', () => {
  const messages: ChatMessage[] = [
    subagentMessage({
      toolId: 'running-agent',
      timestamp: '2026-08-17T03:00:00.000Z',
    }),
    subagentMessage({
      toolId: 'waiting-agent',
      timestamp: '2026-08-17T03:00:01.000Z',
      taskNotification: notification('waiting'),
    }),
    subagentMessage({
      toolId: 'completed-agent',
      timestamp: '2026-08-17T03:00:02.000Z',
      toolCompletedAt: '2026-08-17T03:00:05.000Z',
      toolResult: { content: 'done' },
      subagentState: {
        currentToolIndex: -1,
        isComplete: true,
        childTools: [],
      },
    }),
    subagentMessage({
      toolId: 'failed-agent',
      timestamp: '2026-08-17T03:00:03.000Z',
      toolCompletedAt: '2026-08-17T03:00:06.000Z',
      toolResult: { content: 'failed', isError: true },
      taskNotification: notification('failed', 'failed'),
      subagentState: {
        currentToolIndex: -1,
        isComplete: true,
        childTools: [],
      },
    }),
  ];

  const traces = buildSubagentTraces(messages);

  assert.deepEqual(traces.map((trace) => trace.status), [
    'running',
    'waiting',
    'completed',
    'error',
  ]);
  assert.equal(traces[0]?.completedAt, undefined);
  assert.equal(traces[1]?.taskStatus, 'waiting');
  assert.equal(traces[2]?.completedAt?.toISOString(), '2026-08-17T03:00:05.000Z');
  assert.equal(traces[3]?.taskStatus, 'failed');
});

test('buildSubagentTraces treats stopped and killed lifecycle states as errors', () => {
  const messages = ['stopped', 'killed'].map((status, index) => subagentMessage({
    toolId: `${status}-agent`,
    timestamp: `2026-08-17T03:10:0${index}.000Z`,
    taskNotification: notification(status, `${status} result`),
    subagentState: {
      childTools: [],
      currentToolIndex: -1,
      isComplete: true,
    },
  }));

  assert.deepEqual(
    buildSubagentTraces(messages).map((trace) => trace.status),
    ['error', 'error'],
  );
});

test('buildSubagentTraces trusts the current owner generation and hides stale final output while running', () => {
  const alias = subagentMessage({
    toolId: 'legacy-task',
    toolName: 'Task',
    timestamp: '2026-08-17T04:00:00.000Z',
    toolResult: { content: 'Old alias result' },
    subagentState: {
      childTools: [],
      currentToolIndex: -1,
      isComplete: true,
      detailsOwnerToolId: 'current-agent',
    },
  });
  const runningOwner = subagentMessage({
    toolId: 'current-agent',
    timestamp: '2026-08-17T04:00:01.000Z',
    toolResult: { content: 'Old owner result', toolUseResult: { agentId: 'agent-42' } },
    taskNotification: {
      ...notification('completed', 'Old owner result'),
      taskId: 'agent-42',
    },
    subagentState: {
      childTools: [{
        toolId: 'new-read',
        toolName: 'Read',
        toolInput: { file_path: '/workspace/new.ts' },
        toolResult: null,
        timestamp: new Date('2026-08-17T04:00:02.000Z'),
      }],
      currentToolIndex: 0,
      isComplete: false,
    },
  });

  const [runningTrace] = buildSubagentTraces([alias, runningOwner]);
  assert.equal(runningTrace?.status, 'running');
  assert.equal(runningTrace?.result, undefined);
  assert.equal(runningTrace?.agentId, 'agent-42');

  const completedOwner = subagentMessage({
    ...runningOwner,
    toolId: 'current-agent',
    timestamp: '2026-08-17T04:00:01.000Z',
    toolResult: { content: 'Current result', toolUseResult: { agentId: 'agent-42' } },
    taskNotification: {
      ...notification('completed', 'Current result'),
      taskId: 'agent-42',
    },
    subagentState: {
      ...runningOwner.subagentState!,
      isComplete: true,
    },
  });
  const [completedTrace] = buildSubagentTraces([alias, completedOwner]);
  assert.equal(completedTrace?.status, 'completed');
  assert.equal(completedTrace?.result, 'Current result');
});
