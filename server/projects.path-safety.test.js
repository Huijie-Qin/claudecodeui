import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  deleteSessionFromProjectsRoot,
  resolveClaudeProjectDirectory,
  validateClaudeProjectName,
  validateClaudeSessionId,
} from './projects.js';

test('Claude path identifiers preserve compatible legacy names', () => {
  for (const sessionId of ['session-delete', 'abc_123', 'abc.def', '.hidden', '...']) {
    assert.equal(validateClaudeSessionId(sessionId), sessionId);
  }

  for (const projectName of ['-Users-demo-project', 'project.v2', '项目-甲', 'name%20encoded']) {
    assert.equal(validateClaudeProjectName(projectName), projectName);
  }
});

test('Claude path identifiers reject traversal and cross-platform path syntax', () => {
  for (const sessionId of ['.', '..', '../outside', '..\\outside', '/outside']) {
    assert.throws(
      () => validateClaudeSessionId(sessionId),
      (error) => error?.statusCode === 400 && error?.code === 'INVALID_PATH_SEGMENT',
      sessionId,
    );
  }

  for (const projectName of [
    '.',
    '..',
    '../outside',
    '..\\outside',
    '/tmp/outside',
    'C:\\tmp\\outside',
    '\\\\server\\share',
    'C:outside',
  ]) {
    assert.throws(
      () => validateClaudeProjectName(projectName),
      (error) => error?.statusCode === 400 && error?.code === 'INVALID_PATH_SEGMENT',
      projectName,
    );
  }
});

test('legacy Claude project targets stay direct children of the projects root', () => {
  const projectsRoot = path.resolve('fake-home', '.claude', 'projects');

  assert.equal(
    resolveClaudeProjectDirectory('-Users-demo-project', projectsRoot),
    path.join(projectsRoot, '-Users-demo-project'),
  );

  for (const projectName of ['.', '..', '../outside', '..\\outside']) {
    assert.throws(
      () => resolveClaudeProjectDirectory(projectName, projectsRoot),
      (error) => error?.statusCode === 400,
      projectName,
    );
  }
});

test('runtime Claude deletion rejects dot segments without touching sibling data', async () => {
  for (const sessionId of ['.', '..']) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-delete-safety-'));
    const projectsRoot = path.join(root, '.claude', 'projects');
    const projectDir = path.join(projectsRoot, 'project-a');
    const siblingProjectDir = path.join(projectsRoot, 'project-b');
    const sentinelPaths = [
      path.join(projectDir, 'session-keep.jsonl'),
      path.join(projectDir, 'session-keep', 'sentinel.txt'),
      path.join(siblingProjectDir, 'sentinel.txt'),
    ];

    try {
      for (const sentinelPath of sentinelPaths) {
        await fs.mkdir(path.dirname(sentinelPath), { recursive: true });
        await fs.writeFile(sentinelPath, 'keep', 'utf8');
      }

      await assert.rejects(
        deleteSessionFromProjectsRoot(projectsRoot, sessionId),
        (error) => error?.statusCode === 400 && error?.code === 'INVALID_PATH_SEGMENT',
      );

      await fs.access(projectsRoot);
      await fs.access(projectDir);
      await fs.access(siblingProjectDir);
      for (const sentinelPath of sentinelPaths) {
        assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'keep');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
