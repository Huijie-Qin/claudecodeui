import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import commandsRouter from './commands.js';
import {
  appendClaudeDisplayCommand,
  readClaudeDisplayCommands,
  resolveClaudeDisplayCommandPath,
} from '../modules/providers/list/claude/claude-display-command-store.js';

async function withCommandServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/commands', commandsRouter);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('nested commands use hyphenated names and preserve the invocation through storage', async (t) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-nested-command-'));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  const commandsDirectory = path.join(projectPath, '.claude', 'commands');
  const fixtures = [
    ['review.md', '/review'],
    ['frontend/review.md', '/frontend-review'],
    ['backend/database/check.md', '/backend-database-check'],
  ];
  for (const [relativePath] of fixtures) {
    const commandPath = path.join(commandsDirectory, relativePath);
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, 'Check:\n$ARGUMENTS\n');
  }

  await withCommandServer(async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/commands/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath }),
    });
    assert.equal(listResponse.status, 200);
    const listed = (await listResponse.json()).custom.filter(command => command.namespace === 'project');
    assert.equal(listed.length, fixtures.length);
    for (const [relativePath, name] of fixtures) {
      const command = listed.find(candidate => candidate.name === name);
      assert.ok(command, name);
      assert.equal(command.path, path.join(commandsDirectory, relativePath));
    }

    const command = listed.find(candidate => candidate.name === '/backend-database-check');
    const rawArgs = '只检查权限\n\n保留中文说明';
    const response = await fetch(`${baseUrl}/api/commands/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandName: command.name, commandPath: command.path,
        args: ['只检查权限', '保留中文说明'], rawArgs, context: { projectPath },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.content, `Check:\n${rawArgs}\n`);

    const sessionId = 'nested-command';
    const displayPath = resolveClaudeDisplayCommandPath(projectPath, projectPath, sessionId);
    const transcriptDirectory = path.dirname(path.dirname(displayPath));
    await fs.mkdir(transcriptDirectory, { recursive: true });
    await fs.writeFile(path.join(transcriptDirectory, `${sessionId}.jsonl`), '');
    const invocation = `${command.name} ${rawArgs}`;
    assert.equal(await appendClaudeDisplayCommand({
      runtimeHomePath: projectPath, projectPath, sessionId,
      messageId: 'user-command', displayCommand: invocation, modelContent: result.content,
    }), true);
    const restored = await readClaudeDisplayCommands({ runtimeHomePath: projectPath, sessionId });
    assert.equal(restored.get('user-command'), invocation);
  });
});

test('POST /execute preserves command arguments without placeholders', async (t) => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-command-arguments-'));
  t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
  const commandPath = path.join(projectPath, '.claude', 'commands', 'review.md');
  await fs.mkdir(path.dirname(commandPath), { recursive: true });
  await fs.writeFile(commandPath, 'Review the code.\n');
  await withCommandServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/commands/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commandName: '/review', commandPath,
        args: ['只检查权限', '保留中文说明'], rawArgs: '只检查权限\n\n保留中文说明',
        context: { projectPath },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content,
      'Review the code.\n\n## User request\n\n只检查权限\n\n保留中文说明\n');
  });
});

test('POST /execute preserves multiline skill user requests', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-command-route-'));
  const skillDirectory = path.join(projectPath, '.claude', 'skills', 'demo');
  const skillPath = path.join(skillDirectory, 'SKILL.md');

  try {
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(skillPath, '# demo\n\nFollow these instructions.\n', 'utf8');

    await withCommandServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/commands/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandName: '/demo',
          commandPath: skillPath,
          args: ['第一行', '第二行', '第三行'],
          rawArgs: '第一行\n第二行\n\n第三行',
          context: { projectPath },
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(
        body.content,
        '# demo\n\nFollow these instructions.\n\n## User request\n\n第一行\n第二行\n\n第三行\n',
      );
    });
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});

test('POST /execute preserves multiline $ARGUMENTS replacements', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-command-route-'));
  const commandDirectory = path.join(projectPath, '.claude', 'commands');
  const commandPath = path.join(commandDirectory, 'demo.md');

  try {
    await fs.mkdir(commandDirectory, { recursive: true });
    await fs.writeFile(commandPath, 'Request:\n$ARGUMENTS\n', 'utf8');

    await withCommandServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/commands/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commandName: '/demo',
          commandPath,
          args: ['第一行', '第二行'],
          rawArgs: '第一行\n第二行',
          context: { projectPath },
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.content, 'Request:\n第一行\n第二行\n');
    });
  } finally {
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});
