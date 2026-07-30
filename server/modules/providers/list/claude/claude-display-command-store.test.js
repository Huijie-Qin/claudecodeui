import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendClaudeDisplayCommand,
  deleteClaudeDisplayCommands,
  readClaudeDisplayCommands,
  resolveClaudeDisplayCommandPath,
} from './claude-display-command-store.js';

test('Claude display command store records only expanded slash invocations', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));

  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    sessionId: 'session-1',
    messageId: 'message-regular',
    displayCommand: '普通消息',
    modelContent: '普通消息',
  }), false);
  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    sessionId: 'session-1',
    messageId: 'message-unexpanded',
    displayCommand: '/report-skill',
    modelContent: '/report-skill',
  }), false);
  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    sessionId: 'session-1',
    messageId: 'message-expanded',
    displayCommand: '  /report-skill 生成日报  ',
    modelContent: '# report-skill\n\nExpanded instructions.',
  }), true);

  const commands = await readClaudeDisplayCommands({
    runtimeHomePath,
    sessionId: 'session-1',
  });
  assert.deepEqual([...commands.entries()], [
    ['message-expanded', '/report-skill 生成日报'],
  ]);
});

test('Claude display command store keeps the latest command for one message and deletes with the session', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));

  await Promise.all([
    appendClaudeDisplayCommand({
      runtimeHomePath,
      sessionId: 'session-2',
      messageId: 'message-1',
      displayCommand: '/report-skill first',
      modelContent: '# expanded',
    }),
    appendClaudeDisplayCommand({
      runtimeHomePath,
      sessionId: 'session-2',
      messageId: 'message-1',
      displayCommand: '/report-skill second',
      modelContent: '# expanded',
    }),
  ]);

  const commands = await readClaudeDisplayCommands({
    runtimeHomePath,
    sessionId: 'session-2',
  });
  assert.equal(commands.size, 1);
  assert.equal(commands.get('message-1'), '/report-skill second');

  assert.equal(await deleteClaudeDisplayCommands({
    runtimeHomePath,
    sessionId: 'session-2',
  }), true);
  assert.equal(await fs.access(
    resolveClaudeDisplayCommandPath(runtimeHomePath, 'session-2'),
  ).then(() => true, () => false), false);
});
