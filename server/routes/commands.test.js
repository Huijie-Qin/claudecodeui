import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import commandsRouter from './commands.js';

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
