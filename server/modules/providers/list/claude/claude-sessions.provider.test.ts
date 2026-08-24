import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ClaudeSessionsProvider,
  resolveClaudeProjectStorageName,
} from './claude-sessions.provider.js';
import { appendClaudeDisplayCommand } from './claude-display-command-store.js';

test('resolveClaudeProjectStorageName prefers encoded workspace path for tenant workspaces', () => {
  assert.equal(
    resolveClaudeProjectStorageName({
      projectName: 'cc-multitenant-default-02',
      projectPath: '/Users/huijieqin/project/claude-code-ui/cc-multitenant-default-02',
    }),
    '-Users-huijieqin-project-claude-code-ui-cc-multitenant-default-02',
  );
});

test('resolveClaudeProjectStorageName falls back to projectName for legacy project rows', () => {
  assert.equal(
    resolveClaudeProjectStorageName({ projectName: '-Users-demo-project' }),
    '-Users-demo-project',
  );
});

test('ClaudeSessionsProvider filters resume session summaries from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'resume-summary',
    timestamp: '2026-04-26T10:17:00.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: [
          'Previous session summary:',
          '# Session: 2026-04-26',
          '',
          '<!-- ECC:SUMMARY:START -->',
          '## Session Summary',
          '',
          '### Tasks',
          '- hello, who are you',
          '<!-- ECC:SUMMARY:END -->',
        ].join('\n'),
      }],
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters hook-wrapped resume summaries from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'hook-summary',
    timestamp: '2026-04-26T10:17:00.000Z',
    message: {
      role: 'user',
      content: [
        'Hook SessionStart:resume (SessionStart) success:',
        'Previous session summary:',
        '# Session: 2026-04-26',
        '',
        '### Tasks',
        '- hello, who are you',
      ].join('\n'),
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters sidechain subagent messages from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'subagent-prompt',
    isSidechain: true,
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Search the workspace for skill files.',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters meta messages from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'skill-meta',
    isMeta: true,
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Loaded skill body.',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters snake-case meta messages from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'skill-meta-snake',
    is_meta: true,
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Loaded skill body.',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters skill bodies even when the meta flag is missing', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'skill-body',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Base directory for this skill: /Users/song/.claude/skills/find-skills\n\n# Find Skills',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider restores a stored slash invocation without exposing expanded instructions', () => {
  const provider = new ClaudeSessionsProvider();
  const secretInstruction = 'INTERNAL_SKILL_INSTRUCTION_MUST_NOT_BE_VISIBLE';
  const displayCommand = [
    '/dataops-html-report 第一行',
    '',
    '# 测试',
    '',
    '## User request',
    '',
    '第二行',
  ].join('\n');
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'expanded-skill',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: [
        '## Related Skills',
        '',
        '# A title unrelated to the skill name',
        '',
        secretInstruction,
      ].join('\n'),
    },
  }, 'session-1', displayCommand);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, displayCommand);
  assert.equal(messages[0].content?.includes(secretInstruction), false);
});

test('ClaudeSessionsProvider restores a stored slash-only invocation', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'expanded-skill-without-query',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: '## Related Skills\n\n# Report Building\n\nExpanded instructions.',
    },
  }, 'session-1', '/dataops-html-report');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '/dataops-html-report');
});

test('ClaudeSessionsProvider hides an internal Hook display command', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'hook-recovery',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Internal Hook model prompt',
    },
  }, 'session-1', '<ccui-hook-recovery activity="activity-1"></ccui-hook-recovery>');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider restores one stored invocation from array text content', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'expanded-skill-array',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '# Display title\n\nExpanded instructions.',
        },
        {
          type: 'text',
          text: 'More expanded instructions.',
        },
      ],
    },
  }, 'session-1', '/report-skill 生成日报');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '/report-skill 生成日报');
});

test('ClaudeSessionsProvider joins runtime display metadata to JSONL by user message UUID', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-provider-display-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));

  const sessionId = 'runtime-session-1';
  const messageId = '11111111-1111-4111-8111-111111111111';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(
    path.join(projectDirectory, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: 'user',
      uuid: messageId,
      sessionId,
      timestamp: '2026-04-29T01:19:50.247Z',
      message: {
        role: 'user',
        content: '# report-skill\n\nINTERNAL_SKILL_INSTRUCTION_MUST_NOT_BE_VISIBLE',
      },
    })}\n`,
    'utf8',
  );
  await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath: '/workspace',
    sessionId,
    messageId,
    displayCommand: '/report-skill generate report',
    modelContent: '# report-skill\n\nINTERNAL_SKILL_INSTRUCTION_MUST_NOT_BE_VISIBLE',
  });

  const provider = new ClaudeSessionsProvider();
  const result = await provider.fetchHistory(sessionId, {
    runtimeHomePath,
  });

  assert.equal(result.total, 1);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, '/report-skill generate report');
});

test('ClaudeSessionsProvider restores nested subagent tools into the Agent history card', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'claude-provider-subagent-history-'),
  );
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));

  const sessionId = 'runtime-subagent-session';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  const mainRows = [
    {
      sessionId,
      uuid: 'agent-use',
      type: 'assistant',
      timestamp: '2026-08-24T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_agent_1',
          name: 'Agent',
          input: { description: 'Inspect authentication' },
        }],
      },
    },
    {
      sessionId,
      uuid: 'agent-result',
      type: 'user',
      timestamp: '2026-08-24T01:00:01.000Z',
      tool_use_result: { status: 'async_launched', agent_id: 'agent-1' },
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_agent_1',
          content: 'Agent launched.',
        }],
      },
    },
  ];
  const subagentRows = [
    {
      timestamp: '2026-08-24T01:00:00.200Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'Read',
          input: { file_path: '/workspace/auth.ts' },
        }],
      },
    },
    {
      timestamp: '2026-08-24T01:00:00.300Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_read_1',
          content: 'source',
        }],
      },
    },
  ];

  await fs.mkdir(path.join(projectDirectory, sessionId, 'subagents'), { recursive: true });
  await fs.writeFile(
    path.join(projectDirectory, `${sessionId}.jsonl`),
    `${mainRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(projectDirectory, sessionId, 'subagents', 'agent-agent-1.jsonl'),
    `${subagentRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );

  const provider = new ClaudeSessionsProvider();
  const result = await provider.fetchHistory(sessionId, { runtimeHomePath });
  const agentMessage = result.messages.find((message) => (
    message.kind === 'tool_use' && message.toolId === 'toolu_agent_1'
  ));

  assert.deepEqual(agentMessage?.subagentTools, [{
    toolId: 'toolu_read_1',
    toolName: 'Read',
    toolInput: { file_path: '/workspace/auth.ts' },
    timestamp: '2026-08-24T01:00:00.200Z',
    toolResult: { content: 'source', isError: false },
  }]);
});

test('ClaudeSessionsProvider does not infer skill names from unmarked markdown headings', () => {
  const provider = new ClaudeSessionsProvider();
  const content = [
    '# dataops-html-report',
    '',
    'Expanded instructions.',
    '',
    '## User request',
    '',
    '帮我分析这份数据',
  ].join('\n');
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'unmarked-expanded-skill',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content,
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, content);
});

test('ClaudeSessionsProvider filters snake-case sidechain messages from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'subagent-prompt-snake',
    is_sidechain: true,
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: 'Search the workspace for skill files.',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider filters nested sidechain messages from user-visible messages', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'subagent-prompt-nested',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      isSidechain: true,
      content: 'Search the workspace for skill files.',
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});

test('ClaudeSessionsProvider normalizes SDK partial stream events into stream messages', () => {
  const provider = new ClaudeSessionsProvider();
  const deltaMessages = provider.normalizeMessage({
    type: 'stream_event',
    uuid: 'partial-1',
    session_id: 'session-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'Hel',
      },
    },
  }, 'session-1');
  const endMessages = provider.normalizeMessage({
    type: 'stream_event',
    uuid: 'partial-2',
    session_id: 'session-1',
    event: {
      type: 'content_block_stop',
      index: 0,
    },
  }, 'session-1');

  assert.equal(deltaMessages.length, 1);
  assert.equal(deltaMessages[0].kind, 'stream_delta');
  assert.equal(deltaMessages[0].content, 'Hel');
  assert.equal(deltaMessages[0].sessionId, 'session-1');

  assert.equal(endMessages.length, 1);
  assert.equal(endMessages[0].kind, 'stream_end');
  assert.equal(endMessages[0].sessionId, 'session-1');
});

test('ClaudeSessionsProvider normalizes SDK background task lifecycle events', () => {
  const provider = new ClaudeSessionsProvider();
  const started = provider.normalizeMessage({
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-started',
    task_id: 'agent-1',
    tool_use_id: 'toolu_agent_1',
    description: 'Review authentication',
  }, 'session-1');
  const progress = provider.normalizeMessage({
    type: 'system',
    subtype: 'task_progress',
    uuid: 'task-progress',
    task_id: 'agent-1',
    tool_use_id: 'toolu_agent_1',
    description: 'Review authentication',
    summary: 'Reading auth.ts',
    usage: { total_tokens: 120 },
  }, 'session-1');
  const completed = provider.normalizeMessage({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'task-completed',
    task_id: 'agent-1',
    tool_use_id: 'toolu_agent_1',
    status: 'completed',
    summary: 'Review complete',
    output_file: '/tmp/agent-1.output',
    usage: { total_tokens: 900, tool_uses: 3 },
  }, 'session-1');
  const killed = provider.normalizeMessage({
    type: 'system',
    subtype: 'task_notification',
    uuid: 'task-killed',
    task_id: 'agent-2',
    tool_use_id: 'toolu_agent_2',
    status: 'killed',
  }, 'session-1');

  assert.deepEqual(started.map(({ id: _id, timestamp: _timestamp, ...message }) => message), [{
    sessionId: 'session-1',
    provider: 'claude',
    kind: 'task_notification',
    taskId: 'agent-1',
    toolUseId: 'toolu_agent_1',
    status: 'running',
    summary: 'Review authentication',
  }]);
  assert.equal(progress[0]?.status, 'running');
  assert.equal(progress[0]?.summary, 'Reading auth.ts');
  assert.deepEqual(progress[0]?.usage, { total_tokens: 120 });
  assert.equal(completed[0]?.status, 'completed');
  assert.equal(completed[0]?.outputFile, '/tmp/agent-1.output');
  assert.deepEqual(completed[0]?.usage, { total_tokens: 900, tool_uses: 3 });
  assert.equal(killed[0]?.status, 'stopped');
});

test('ClaudeSessionsProvider strips assistant sentinel tokens from Claude text', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'assistant-sentinel',
    timestamp: '2026-04-29T02:55:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'SKILL_FINAL_OK<|assistant|>',
      }],
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'SKILL_FINAL_OK');
});

test('ClaudeSessionsProvider trusts top-level assistant type over nested role', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'assistant-top-level',
    timestamp: '2026-05-12T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: 'Top-level assistant entry.',
      }],
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Top-level assistant entry.');
});

test('ClaudeSessionsProvider drops stream deltas that only contain assistant sentinel tokens', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'stream_event',
    uuid: 'partial-sentinel',
    session_id: 'session-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: '<|assistant|>',
      },
    },
  }, 'session-1');

  assert.deepEqual(messages, []);
});
