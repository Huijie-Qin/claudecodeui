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

function currentRuntimeOwnership() {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return {};
  }
  return {
    uid: process.getuid(),
    gid: process.getgid(),
  };
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

test('Claude display command store hardens the session directory and metadata file', async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const projectPath = '/workspace';
  const displayCommandPath = await createSessionTranscript({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-permissions',
  });
  const sessionDirectory = path.dirname(displayCommandPath);

  await fs.mkdir(sessionDirectory, { recursive: true, mode: 0o777 });
  await fs.chmod(sessionDirectory, 0o777);
  await fs.writeFile(displayCommandPath, '', { encoding: 'utf8', mode: 0o666 });
  await fs.chmod(displayCommandPath, 0o666);

  assert.equal(await appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-permissions',
    messageId: 'message-permissions',
    displayCommand: '/report-skill secure',
    modelContent: '# expanded',
    ...currentRuntimeOwnership(),
  }), true);

  const storedContent = await fs.readFile(displayCommandPath, 'utf8');
  assert.match(storedContent, /"messageId":"message-permissions"/);

  if (process.platform !== 'win32') {
    const claudeDirectory = path.join(runtimeHomePath, '.claude');
    const projectsDirectory = path.join(claudeDirectory, 'projects');
    const projectDirectory = path.dirname(sessionDirectory);
    const directoryStats = await fs.stat(sessionDirectory);
    const fileStats = await fs.stat(displayCommandPath);
    assert.equal((await fs.stat(claudeDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(projectsDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(projectDirectory)).mode & 0o777, 0o700);
    assert.equal(directoryStats.mode & 0o777, 0o700);
    assert.equal(fileStats.mode & 0o777, 0o600);
    assert.equal(directoryStats.uid, process.getuid());
    assert.equal(directoryStats.gid, process.getgid());
    assert.equal(fileStats.uid, process.getuid());
    assert.equal(fileStats.gid, process.getgid());
  }
});

test('Claude display command store rejects a symbolic-link metadata file', {
  skip: process.platform === 'win32',
}, async (t) => {
  const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-display-command-'));
  t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
  const projectPath = '/workspace';
  const displayCommandPath = await createSessionTranscript({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-symlink',
  });
  const sessionDirectory = path.dirname(displayCommandPath);
  const symlinkTarget = path.join(runtimeHomePath, 'must-not-change.jsonl');

  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(symlinkTarget, 'unchanged\n', 'utf8');
  await fs.symlink(symlinkTarget, displayCommandPath, 'file');

  await assert.rejects(appendClaudeDisplayCommand({
    runtimeHomePath,
    projectPath,
    sessionId: 'session-symlink',
    messageId: 'message-symlink',
    displayCommand: '/report-skill blocked',
    modelContent: '# expanded',
    ...currentRuntimeOwnership(),
  }), /must not be a symbolic link/);
  assert.equal(await fs.readFile(symlinkTarget, 'utf8'), 'unchanged\n');
});
