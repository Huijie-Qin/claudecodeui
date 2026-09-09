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

test('skill history pagination counts normalized messages without repeating queries', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skill-pages-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const sessionId = 'skill-pages';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  await fs.mkdir(projectDirectory, { recursive: true });
  const rows = [
    { uuid: 'query-1', type: 'user', message: { role: 'user', content: '/report weekly' } },
    { uuid: 'answer-1', type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'First report' },
      { type: 'text', text: 'Report details' },
    ] } },
    { uuid: 'query-2', type: 'user', message: { role: 'user', content: '<command-message>report</command-message>\n<command-name>/report</command-name>\n<command-args>weekly</command-args>' } },
    { uuid: 'body-2', type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /skills/report\nInstructions.' } },
    { uuid: 'answer-2', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second report' }] } },
    { uuid: 'internal', type: 'system', subtype: 'turn_duration' },
  ].map((row, index) => ({ ...row, sessionId, timestamp: `2026-09-09T10:00:0${index}.000Z` }));
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');

  const provider = new ClaudeSessionsProvider();
  const full = await provider.fetchHistory(sessionId, { runtimeHomePath });
  assert.equal(full.total, full.messages.length);
  assert.equal(full.messages.length, 5);
  for (const limit of [1, 2, 3]) {
    let loaded = [] as typeof full.messages;
    let hasMore = true;
    while (hasMore) {
      const page = await provider.fetchHistory(sessionId, { runtimeHomePath, limit, offset: loaded.length });
      assert.equal(page.total, full.total);
      assert.ok(page.messages.length > 0);
      assert.equal(page.messages.length, Math.min(limit, full.total - loaded.length));
      loaded = [...page.messages, ...loaded];
      hasMore = page.hasMore;
      assert.ok(loaded.length <= full.total);
    }
    assert.deepEqual(loaded, full.messages);
    // Identical queries with different request IDs are intentional submissions.
    assert.equal(loaded.filter(message => message.content === '/report weekly').length, 2);
  }
});

test('supplement display anchors survive JSONL reload and are applied before pagination', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-supplement-order-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const sessionId = 'supplement-session';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  await fs.mkdir(projectDirectory, { recursive: true });
  const rows = [
    { uuid: 'u1', type: 'user', timestamp: '2026-09-06T10:00:01.000Z', message: { role: 'user', content: 'Supplement 1' } },
    { uuid: 'u2', type: 'user', timestamp: '2026-09-06T10:00:02.000Z', message: { role: 'user', content: 'Supplement 2' } },
    { uuid: 'a', type: 'assistant', timestamp: '2026-09-06T10:00:03.000Z', message: { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text: 'Full current reply' }] } },
    { uuid: 'b', type: 'assistant', timestamp: '2026-09-06T10:00:04.000Z', message: { id: 'msg-b', role: 'assistant', content: [{ type: 'text', text: 'New reply' }] } },
  ].map(row => ({ ...row, sessionId }));
  const transcript = path.join(projectDirectory, `${sessionId}.jsonl`);
  const raw = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await fs.writeFile(transcript, raw);
  for (const sequence of [1, 2]) assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath, projectPath: '/workspace', sessionId, messageId: `u${sequence}`,
    displayCommand: `Supplement ${sequence}`, modelContent: `Supplement ${sequence}`,
    displayAfterAssistantId: 'msg-a', supplementSequence: sequence,
  }), true);
  const provider = new ClaudeSessionsProvider();
  const full = await provider.fetchHistory(sessionId, { runtimeHomePath });
  assert.deepEqual(full.messages.map(message => message.content), ['Full current reply', 'Supplement 1', 'Supplement 2', 'New reply']);
  const recent = await provider.fetchHistory(sessionId, { runtimeHomePath, limit: 2 });
  const older = await provider.fetchHistory(sessionId, { runtimeHomePath, limit: 2, offset: 2 });
  assert.deepEqual([...older.messages, ...recent.messages], full.messages);
  assert.equal(recent.hasMore, true);
  assert.equal(older.hasMore, false);
  assert.equal(await fs.readFile(transcript, 'utf8'), raw);
});

test('live and persisted Claude output expose the same assistant message identity', () => {
  const provider = new ClaudeSessionsProvider();
  const [live] = provider.normalizeMessage({ type: 'stream_event', assistantMessageId: 'msg-a',
    event: { type: 'content_block_delta', delta: { text: 'Answer' } } }, 's');
  const [persisted] = provider.normalizeMessage({ type: 'assistant', uuid: 'different-transcript-uuid',
    message: { id: 'msg-a', role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } }, 's');
  assert.equal(live.assistantMessageId, persisted.assistantMessageId);
  assert.equal(live.assistantMessageId, 'msg-a');
});

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

test('ClaudeSessionsProvider restores native user skill commands and preserves multiline queries', () => {
  const provider = new ClaudeSessionsProvider();
  for (const args of ['user_query', '第一行\n\n第二行  保留空格', '']) {
    const content = [
      '<command-message>game_skill</command-message>',
      '<command-name>/game_skill</command-name>',
      `<command-args>${args}</command-args>`,
    ].join('\n');
    for (const messageContent of [content, [{ type: 'text', text: content }]]) {
      const messages = provider.normalizeMessage({
        type: 'user',
        uuid: 'native-skill',
        message: { role: 'user', content: messageContent },
      }, 'session-1');

      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'text');
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, `/game_skill${args ? ` ${args}` : ''}`);
    }
  }
});

test('ClaudeSessionsProvider keeps internal and incomplete skill command records hidden', () => {
  const provider = new ClaudeSessionsProvider();
  const content = '<command-message>game_skill</command-message>\n<command-name>/game_skill</command-name>\n<command-args>user_query</command-args>';
  for (const raw of [
    { type: 'user', isMeta: true, message: { role: 'user', content } },
    { type: 'user', isSidechain: true, message: { role: 'user', content } },
    { type: 'user', message: { role: 'assistant', content } },
    { type: 'system', message: { role: 'user', content } },
    { type: 'user', message: { role: 'user', content: '<command-args>user_query</command-args>' } },
    { type: 'user', message: { role: 'user', content: `${content}\nBase directory for this skill: /skills/game_skill\nExpanded instructions.` } },
    { type: 'user', message: { role: 'user', content: content.replace('/game_skill', 'game_skill') + '\n<skill-format>true</skill-format>' } },
  ]) {
    assert.deepEqual(provider.normalizeMessage(raw, 'session-1'), []);
  }
  const restored = provider.normalizeMessage({
    type: 'user',
    message: { role: 'user', content },
  }, 'session-1', '/game_skill original query');
  assert.equal(restored[0].content, '/game_skill original query');
});

test('ClaudeSessionsProvider loads native skill queries from JSONL while hiding expanded skill bodies', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-provider-native-skill-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const sessionId = 'native-skill-session';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  const rows = [
    {
      type: 'user', uuid: 'native-skill-query', sessionId,
      message: {
        role: 'user',
        content: '<command-message>game_skill</command-message>\n<command-name>/game_skill</command-name>\n<command-args>user_query</command-args>',
      },
    },
    {
      type: 'user', uuid: 'native-skill-body', sessionId, isMeta: true,
      message: { role: 'user', content: 'Base directory for this skill: /skills/game_skill\nExpanded instructions.' },
    },
    {
      type: 'assistant', uuid: 'native-skill-answer', sessionId,
      message: { role: 'assistant', content: 'Working on the game.' },
    },
  ];
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  const result = await new ClaudeSessionsProvider().fetchHistory(sessionId, { runtimeHomePath });
  assert.deepEqual(result.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '/game_skill user_query' },
    { role: 'assistant', content: 'Working on the game.' },
  ]);
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

test('ClaudeSessionsProvider associates Hook recovery output until the next visible user turn', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-provider-hook-recovery-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));

  const sessionId = 'runtime-hook-recovery-session';
  const messageId = '22222222-2222-4222-8222-222222222222';
  const activityId = 'hook_activity_execution-1_notify';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  const rows = [
    {
      type: 'user',
      uuid: messageId,
      sessionId,
      timestamp: '2026-04-29T01:19:50.247Z',
      message: { role: 'user', content: 'Internal Hook recovery prompt' },
    },
    {
      type: 'assistant',
      uuid: 'hook-recovery-output',
      sessionId,
      timestamp: '2026-04-29T01:19:51.247Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'HOOK_RECOVERY_DONE' }] },
    },
    {
      type: 'user',
      uuid: 'next-user-turn',
      sessionId,
      timestamp: '2026-04-29T01:19:52.247Z',
      message: { role: 'user', content: 'Next question' },
    },
    {
      type: 'assistant',
      uuid: 'next-assistant-turn',
      sessionId,
      timestamp: '2026-04-29T01:19:53.247Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Next answer' }] },
    },
  ];
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(
    path.join(projectDirectory, `${sessionId}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath: '/workspace',
    sessionId,
    messageId,
    displayCommand: `<ccui-hook-recovery activity="${activityId}"></ccui-hook-recovery>`,
    modelContent: 'Internal Hook recovery prompt',
  });

  const provider = new ClaudeSessionsProvider();
  const result = await provider.fetchHistory(sessionId, { runtimeHomePath });

  assert.equal(result.messages.find((message) => message.content === 'HOOK_RECOVERY_DONE')?.hookActivityId, activityId);
  assert.equal(result.messages.find((message) => message.content === 'Next question')?.hookActivityId, undefined);
  assert.equal(result.messages.find((message) => message.content === 'Next answer')?.hookActivityId, undefined);
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
      timestamp: '2026-08-24T01:00:00.100Z',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Inspecting authentication.' }],
      },
    },
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
  assert.deepEqual(
    agentMessage?.subagentMessages?.map((message) => [message.kind, message.content]),
    [
      ['text', 'Inspecting authentication.'],
      ['tool_use', undefined],
      ['tool_result', 'source'],
    ],
  );
  assert.ok(agentMessage?.subagentMessages?.every((message) => (
    message.parentToolUseId === 'toolu_agent_1'
  )));
});

test('ClaudeSessionsProvider restores running children separately before either Agent result exists', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-provider-active-subagents-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const sessionId = 'active-subagent-session';
  const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
  const childDirectory = path.join(projectDirectory, sessionId, 'subagents');
  await fs.mkdir(childDirectory, { recursive: true });
  const parentRow = {
    sessionId, uuid: 'parallel-agent-use', type: 'assistant', timestamp: '2026-09-11T08:00:00.000Z',
    message: { role: 'assistant', content: ['a', 'b'].map((label) => ({
      type: 'tool_use', id: `agent-tool-${label}`, name: label === 'a' ? 'Agent' : 'Task',
      input: { description: `Wait for task ${label}` },
    })) },
  };
  const mainTranscript = `${JSON.stringify(parentRow)}\n`;
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), mainTranscript);
  for (const label of ['a', 'b']) {
    const childRows = [
      { uuid: `child-${label}-text`, type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: `Waiting ${label}` }] } },
      { uuid: `child-${label}-execute`, type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: `execute-${label}`, name: 'mcp__tasks__execute_task', input: {} }] } },
      { uuid: `child-${label}-result`, type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `execute-${label}`, content: JSON.stringify({ task_id: `task-${label}`, status: 'running' }) }] } },
      { uuid: `child-${label}-status`, type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: `status-${label}`, name: 'mcp__tasks__get_task_status', input: { task_id: `task-${label}` } }] } },
    ];
    await fs.writeFile(path.join(childDirectory, `agent-child-${label}.meta.json`), JSON.stringify({ toolUseId: `agent-tool-${label}` }));
    await fs.writeFile(path.join(childDirectory, `agent-child-${label}.jsonl`), `${childRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }

  const result = await new ClaudeSessionsProvider().fetchHistory(sessionId, { runtimeHomePath });
  assert.equal(result.messages.length, 2);
  for (const label of ['a', 'b']) {
    const agent = result.messages.find((message) => message.toolId === `agent-tool-${label}`);
    assert.ok(agent);
    assert.equal(agent.agentId, `child-${label}`);
    assert.equal(agent.toolResult, undefined, 'Running Agent must not receive a synthetic completion');
    const tools = agent.subagentTools as Array<{ toolId: string; toolResult?: { content: string } }>;
    assert.deepEqual(tools.map((tool) => tool.toolId), [`execute-${label}`, `status-${label}`]);
    assert.equal(JSON.parse(tools[0].toolResult!.content).task_id, `task-${label}`);
    assert.equal(tools[1].toolResult, undefined, 'The child status call is still waiting for its Hook');
    assert.deepEqual(agent.subagentMessages?.map((message) => message.kind), ['text', 'tool_use', 'tool_result', 'tool_use']);
    assert.equal(agent.subagentMessages?.[0].content, `Waiting ${label}`);
    assert.ok(agent.subagentMessages?.every((message) => message.parentToolUseId === `agent-tool-${label}`));
    assert.ok(agent.subagentMessages?.every((message) => !String(message.id).includes(`child-${label === 'a' ? 'b' : 'a'}-`)));
  }
  assert.equal(await fs.readFile(path.join(projectDirectory, `${sessionId}.jsonl`), 'utf8'), mainTranscript);
});

test('ClaudeSessionsProvider attaches indexed history only to its matching Agent or Task part', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'assistant', uuid: 'indexed-parts',
    subagentInvocations: {
      'agent-a': { agentId: 'child-a', subagentTools: [{ toolId: 'child-tool-a' }], subagentMessages: [] },
      'bash-b': { agentId: 'not-a-child', subagentTools: [{ toolId: 'wrong-tool' }] },
    },
    message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'agent-a', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'agent-c', name: 'Agent', input: {} },
      { type: 'tool_use', id: 'bash-b', name: 'Bash', input: {} },
    ] },
  }, 'session');
  assert.deepEqual(messages[0].subagentTools, [{ toolId: 'child-tool-a' }]);
  assert.deepEqual(messages[0].subagentMessages, []);
  assert.equal(messages[0].agentId, 'child-a');
  for (const message of messages.slice(1)) {
    assert.equal(message.agentId, undefined);
    assert.equal(message.subagentTools, undefined);
    assert.equal(message.subagentMessages, undefined);
  }
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
