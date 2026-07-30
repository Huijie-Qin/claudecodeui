import assert from 'node:assert/strict';
import test from 'node:test';

import { attachClaudeDisplayCommand } from '@/shared/utils.js';

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

test('ClaudeSessionsProvider restores marked slash invocation without exposing expanded instructions', () => {
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
      content: attachClaudeDisplayCommand([
        '## Related Skills',
        '',
        '# A title unrelated to the skill name',
        '',
        secretInstruction,
      ].join('\n'), displayCommand),
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, displayCommand);
  assert.equal(messages[0].content?.includes(secretInstruction), false);
});

test('ClaudeSessionsProvider restores marked slash-only invocation', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'expanded-skill-without-query',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: attachClaudeDisplayCommand(
        '## Related Skills\n\n# Report Building\n\nExpanded instructions.',
        '\n\n  /dataops-html-report  ',
      ),
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'text');
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '/dataops-html-report');
});

test('ClaudeSessionsProvider restores marked invocation from array text content', () => {
  const provider = new ClaudeSessionsProvider();
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'expanded-skill-array',
    timestamp: '2026-04-29T01:19:50.247Z',
    message: {
      role: 'user',
      content: [{
        type: 'text',
        text: attachClaudeDisplayCommand(
          '# Display title\n\nExpanded instructions.',
          '/report-skill 生成日报',
        ),
      }],
    },
  }, 'session-1');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '/report-skill 生成日报');
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

test('ClaudeSessionsProvider leaves malformed display markers unchanged', () => {
  const provider = new ClaudeSessionsProvider();
  const content = '<!-- ccui-display-command:v1:not+base64 -->\n# Expanded instructions';
  const messages = provider.normalizeMessage({
    type: 'user',
    uuid: 'malformed-display-marker',
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
