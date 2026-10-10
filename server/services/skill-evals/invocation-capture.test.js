import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvocationCapture } from './invocation-capture.js';

test('eligible invocation saves only the final main-agent output, exactly once', () => {
  const saved = [], capture = createInvocationCapture({ skillRoot: '/workspace/.claude/skills/test', save: (value) => saved.push(value) });
  capture.observe([{ kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/workspace/.claude/skills/test/SKILL.md' } },
    { kind: 'text', role: 'assistant', id: 'a', content: 'First response' },
    { kind: 'text', role: 'assistant', id: 'child', content: 'Child', parentToolUseId: 'subtask' },
    { kind: 'text', role: 'assistant', id: 'final', content: 'Final response' }]);
  capture.finish(); capture.finish();
  assert.deepEqual(saved, [{ messageId: 'final', output: 'Final response' }]);
});
test('external tools, shell access, failed and interrupted calls cannot become cases', () => {
  for (const message of [{ kind: 'tool_use', toolName: 'Bash', toolInput: { command: 'cat data' } },
    { kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/workspace/private.txt' } },
    { kind: 'tool_use', toolName: 'mcp__write' }, { kind: 'error' }]) {
    const capture = createInvocationCapture({ skillRoot: '/workspace/.claude/skills/test', save: () => assert.fail('Must not save') });
    capture.observe([message, { kind: 'text', role: 'assistant', id: 'final', content: 'Done' }]); capture.finish();
  }
  const capture = createInvocationCapture({ skillRoot: '/skill', save: () => assert.fail('Must not save') });
  capture.observe([{ kind: 'text', role: 'assistant', id: 'final', content: 'Done' }]); capture.reject(); capture.finish();
});
