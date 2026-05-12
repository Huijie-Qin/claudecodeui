import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeSessionsProvider,
  resolveClaudeProjectStorageName,
} from './claude-sessions.provider.js';

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
