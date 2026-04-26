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
