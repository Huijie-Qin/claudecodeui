import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractSlashCommandArguments,
  getLeadingSlashCommandName,
  isSkillSlashCommand,
  shouldExpandSlashCommand,
} from './useSlashCommands.utils';

test('getLeadingSlashCommandName recognizes every whitespace boundary without consuming arguments', () => {
  assert.equal(getLeadingSlashCommandName('/demo single line'), '/demo');
  assert.equal(getLeadingSlashCommandName('/demo\nsecond line\nthird line'), '/demo');
  assert.equal(getLeadingSlashCommandName('/demo\tsecond field'), '/demo');
  assert.equal(getLeadingSlashCommandName('  /demo\nsecond line'), '/demo');
  assert.equal(getLeadingSlashCommandName('prefix /demo'), null);
});

test('isSkillSlashCommand recognizes skill metadata and namespaces', () => {
  assert.equal(isSkillSlashCommand({ metadata: { type: 'skill' }, namespace: 'custom' }), true);
  assert.equal(isSkillSlashCommand({ namespace: 'project-skill' }), true);
  assert.equal(isSkillSlashCommand({ namespace: 'project' }), false);
  assert.equal(isSkillSlashCommand(null), false);
});

test('shouldExpandSlashCommand keeps skills native while retaining custom command expansion', () => {
  assert.equal(shouldExpandSlashCommand({ metadata: { type: 'skill' } }), false);
  assert.equal(shouldExpandSlashCommand({ namespace: 'plugin-skill' }), false);
  assert.equal(shouldExpandSlashCommand({ namespace: 'project' }), true);
  assert.equal(shouldExpandSlashCommand(null), false);
});

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
