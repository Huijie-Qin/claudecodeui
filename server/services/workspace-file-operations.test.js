import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  moveWorkspaceItem,
  savePlanMarkdownToWorkspaceRoot,
} from './workspace-file-operations.js';

test('moveWorkspaceItem moves a file into a workspace subdirectory', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-files-move-'));
  await fs.mkdir(path.join(workspaceRoot, 'docs'));
  await fs.writeFile(path.join(workspaceRoot, 'note.md'), 'hello', 'utf8');

  const result = await moveWorkspaceItem({
    workspaceRoot,
    sourcePath: 'note.md',
    targetDirectory: 'docs',
  });

  assert.equal(result.relativePath, 'docs/note.md');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'docs', 'note.md'), 'utf8'), 'hello');
  await assert.rejects(fs.access(path.join(workspaceRoot, 'note.md')));
});

test('moveWorkspaceItem rejects moves outside the workspace root', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-files-move-outside-'));
  await fs.writeFile(path.join(workspaceRoot, 'note.md'), 'hello', 'utf8');

  await assert.rejects(
    moveWorkspaceItem({
      workspaceRoot,
      sourcePath: 'note.md',
      targetDirectory: '..',
    }),
    /Path must be under workspace root/,
  );
});

test('savePlanMarkdownToWorkspaceRoot writes a markdown plan in the workspace root', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-plan-root-'));

  const result = await savePlanMarkdownToWorkspaceRoot({
    workspaceRoot,
    plan: '## Plan\\n\\n- Build it',
    now: new Date('2026-04-30T07:08:09.000Z'),
    sessionId: 'session/abc',
  });

  assert.equal(result.relativePath, 'plan-20260430-070809-session-abc.md');
  assert.equal(
    await fs.readFile(path.join(workspaceRoot, result.relativePath), 'utf8'),
    '## Plan\n\n- Build it\n',
  );
});
