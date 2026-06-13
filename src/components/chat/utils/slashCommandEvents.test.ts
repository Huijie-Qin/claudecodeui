import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchSlashCommandsChangedForPath,
  isSlashCommandSourcePath,
  SLASH_COMMANDS_CHANGED_EVENT,
} from './slashCommandEvents';

function withMockWindow(run: (events: Event[]) => void) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const events: Event[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    },
  });

  try {
    run(events);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

test('isSlashCommandSourcePath recognizes skill and command paths', () => {
  assert.equal(isSlashCommandSourcePath('.claude/skills/demo/SKILL.md'), true);
  assert.equal(isSlashCommandSourcePath('C:\\work\\.claude\\commands\\ship.md'), true);
  assert.equal(isSlashCommandSourcePath('.cloudcli/skills/sources/demo/SKILL.md'), true);
  assert.equal(isSlashCommandSourcePath('src/App.tsx'), false);
});

test('dispatchSlashCommandsChangedForPath only dispatches for slash command source paths', () => {
  withMockWindow((events) => {
    dispatchSlashCommandsChangedForPath('src/App.tsx', { workspaceId: 7 });
    dispatchSlashCommandsChangedForPath('.claude/skills/demo/SKILL.md', {
      reason: 'skill-upload',
      workspaceId: 7,
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, SLASH_COMMANDS_CHANGED_EVENT);
    assert.deepEqual((events[0] as CustomEvent).detail, {
      filePath: '.claude/skills/demo/SKILL.md',
      reason: 'skill-upload',
      workspaceId: 7,
    });
  });
});
