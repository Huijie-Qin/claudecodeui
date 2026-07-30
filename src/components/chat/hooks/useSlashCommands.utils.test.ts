import assert from 'node:assert/strict';
import test from 'node:test';

import { extractSlashCommandArguments } from './useSlashCommands.utils';

test('extractSlashCommandArguments preserves multiline argument text', () => {
  const result = extractSlashCommandArguments({
    commandName: '/demo',
    input: '/demo 第一行\n第二行\n\n第三行',
  });

  assert.equal(result.rawArgs, '第一行\n第二行\n\n第三行');
  assert.deepEqual(result.args, ['第一行', '第二行', '第三行']);
});

test('extractSlashCommandArguments rejects a command-name prefix match', () => {
  const result = extractSlashCommandArguments({
    commandName: '/demo',
    input: '/demo-extra request',
  });

  assert.deepEqual(result, { args: [], rawArgs: '' });
});
