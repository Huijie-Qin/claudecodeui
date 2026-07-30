import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendClaudeDisplayCommand,
  readClaudeDisplayCommands,
  resolveClaudeDisplayCommandPath,
} from './claude-display-command-store.js';

async function createSessionTranscript({ runtimeHomePath, projectPath, sessionId }) {
  const displayCommandPath = resolveClaudeDisplayCommandPath(
    runtimeHomePath,
    projectPath,
    sessionId,
  );
  assert.ok(displayCommandPath);
  const projectDirectory = path.dirname(path.dirname(displayCommandPath));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), '', 'utf8');
  return displayCommandPath;
}

test('Claude display command store records only expanded slash invocations', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const projectPath = '/workspace';
  await createSessionTranscript({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-1',
  });

  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-1',
    messageId: 'message-regular',
    displayCommand: '普通消息',
    modelContent: '普通消息',
  }), false);
  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-1',
    messageId: 'message-unexpanded',
    displayCommand: '/report-skill',
    modelContent: '/report-skill',
  }), false);
  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath,
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

test('Claude display command store keeps the latest command inside the session data directory', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const projectPath = '/workspace';
  const displayCommandPath = await createSessionTranscript({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-2',
  });

  await Promise.all([
    appendClaudeDisplayCommand({
      runtimeHomePath,
      projectPath,
      sessionId: 'session-2',
      messageId: 'message-1',
      displayCommand: '/report-skill first',
      modelContent: '# expanded',
    }),
    appendClaudeDisplayCommand({
      runtimeHomePath,
      projectPath,
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

  assert.equal(
    displayCommandPath,
    path.join(
      runtimeHomePath,
      '.claude',
      'projects',
      '-workspace',
      'session-2',
      'display-commands.jsonl',
    ),
  );
  await fs.access(displayCommandPath);
});
