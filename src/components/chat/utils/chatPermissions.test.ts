import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage } from '../types/types';

import { CLAUDE_SETTINGS_KEY } from './chatStorage';
import { getClaudePermissionSuggestion, isClaudePermissionErrorContent } from './chatPermissions';

function installLocalStorage(initialValues: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialValues));

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
}

function createToolMessage(content: string): ChatMessage {
  return {
    type: 'assistant',
    timestamp: new Date().toISOString(),
    isToolUse: true,
    toolName: 'Bash',
    toolInput: JSON.stringify({ command: 'ls -la /home/xxx/' }),
    toolResult: {
      isError: true,
      content,
    },
  };
}

test('Claude permission detection ignores normal command exit failures', () => {
  const content = "Exit code 2 ls: cannot access '/home/xxx/': No such file or directory";

  assert.equal(isClaudePermissionErrorContent(content), false);
  assert.equal(getClaudePermissionSuggestion(createToolMessage(content), 'claude'), null);
});

test('Claude permission detection only suggests grants for explicit permission denials', () => {
  installLocalStorage();

  const suggestion = getClaudePermissionSuggestion(createToolMessage('User denied tool use'), 'claude');

  assert.deepEqual(suggestion, {
    toolName: 'Bash',
    entry: 'Bash(ls:*)',
    isAllowed: false,
  });
});

test('Claude permission suggestion reflects already saved allow rules', () => {
  installLocalStorage({
    [CLAUDE_SETTINGS_KEY]: JSON.stringify({
      allowedTools: ['Bash(ls:*)'],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    }),
  });

  const suggestion = getClaudePermissionSuggestion(createToolMessage('Tool interaction timed out'), 'claude');

  assert.equal(suggestion?.isAllowed, true);
});
