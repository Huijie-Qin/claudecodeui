import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveContainerUser } from './container-user.js';
import { applyWorkspaceOwnership } from './workspace-ownership.js';

test('container user defaults root UI processes to the non-root sandbox user', () => {
  assert.deepEqual(resolveContainerUser({}, { getuid: () => 0, getgid: () => 0 }), {
    uid: 1000,
    gid: 1000,
  });
  assert.deepEqual(resolveContainerUser({
    CLOUDCLI_DOCKER_UID: '0',
    CLOUDCLI_DOCKER_GID: '0',
  }, { getuid: () => 1000, getgid: () => 1000 }), {
    uid: 0,
    gid: 0,
  });
  assert.throws(
    () => resolveContainerUser({ CLOUDCLI_DOCKER_UID: '1000abc' }, { getuid: () => 0, getgid: () => 0 }),
    /CLOUDCLI_DOCKER_UID must be a non-negative integer/,
  );
});

test('workspace ownership applies to a file and each parent through the workspace root', async () => {
  const workspaceRoot = path.resolve('/workspace/project');
  const targetPath = path.join(workspaceRoot, 'docs', 'api', 'readme.md');
  const calls = [];
  const fsImpl = {
    lstat: async () => ({ isSymbolicLink: () => false }),
    realpath: async (ownedPath) => ownedPath,
    chown: async (ownedPath, uid, gid) => calls.push([ownedPath, uid, gid]),
  };

  const result = await applyWorkspaceOwnership({
    workspaceRoot,
    targetPaths: [targetPath],
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_DOCKER_UID: '1001',
      CLOUDCLI_DOCKER_GID: '1002',
    },
    fsImpl,
    logger: null,
  });

  assert.equal(result.entries, 4);
  assert.deepEqual(calls, [
    [path.join(workspaceRoot, 'docs', 'api'), 1001, 1002],
    [path.join(workspaceRoot, 'docs'), 1001, 1002],
    [workspaceRoot, 1001, 1002],
    [targetPath, 1001, 1002],
  ]);
});

test('workspace ownership rejects paths outside the workspace', async () => {
  await assert.rejects(
    applyWorkspaceOwnership({
      workspaceRoot: '/workspace/project',
      targetPaths: ['/workspace/other/file.txt'],
      env: { CLAUDE_EXECUTION_MODE: 'docker' },
      fsImpl: {},
      logger: null,
    }),
    /must stay under workspace root/,
  );
});

test('workspace ownership is skipped outside docker execution mode', async () => {
  const result = await applyWorkspaceOwnership({
    workspaceRoot: '/workspace/project',
    targetPaths: ['/workspace/project/file.txt'],
    env: { CLAUDE_EXECUTION_MODE: 'local' },
    fsImpl: {},
    logger: null,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.entries, 0);
});

test('recursive ownership is not downgraded when a child target is also listed', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-ownership-recursive-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  const skillRoot = path.join(workspaceRoot, '.claude', 'skills', 'reviewer');
  const manifestPath = path.join(skillRoot, 'SKILL.md');
  const referencePath = path.join(skillRoot, 'references', 'guide.md');
  await fs.mkdir(path.dirname(referencePath), { recursive: true });
  await fs.writeFile(manifestPath, '# Reviewer\n', 'utf8');
  await fs.writeFile(referencePath, '# Guide\n', 'utf8');

  const calls = [];
  const fsImpl = {
    ...fs,
    chown: async (ownedPath, uid, gid) => calls.push([path.resolve(ownedPath), uid, gid]),
    lchown: async (ownedPath, uid, gid) => calls.push([path.resolve(ownedPath), uid, gid, 'symlink']),
  };

  await applyWorkspaceOwnership({
    workspaceRoot,
    targetPaths: [skillRoot, manifestPath],
    recursive: true,
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_DOCKER_UID: '1001',
      CLOUDCLI_DOCKER_GID: '1002',
    },
    fsImpl,
    logger: null,
  });

  assert.equal(calls.some(([ownedPath]) => ownedPath === path.resolve(referencePath)), true);
});

test('workspace ownership rejects an existing target reached through an escaping symlink ancestor', async () => {
  const workspaceRoot = path.resolve('/workspace/project');
  const targetPath = path.join(workspaceRoot, 'link', 'outside.txt');
  const outsidePath = path.resolve('/outside/outside.txt');
  const fsImpl = {
    lstat: async () => ({ isSymbolicLink: () => false }),
    realpath: async (requestedPath) => (
      path.basename(requestedPath) === 'outside.txt' ? outsidePath : path.resolve(requestedPath)
    ),
    chown: async () => {},
  };

  await assert.rejects(
    applyWorkspaceOwnership({
      workspaceRoot,
      targetPaths: [targetPath],
      env: { CLAUDE_EXECUTION_MODE: 'docker' },
      fsImpl,
      logger: null,
    }),
    /resolves outside workspace root/,
  );
});

test('workspace ownership uses lchown without following a final symlink', async () => {
  const workspaceRoot = path.resolve('/workspace/project');
  const targetPath = path.join(workspaceRoot, 'linked-file');
  const calls = [];
  const fsImpl = {
    lstat: async (requestedPath) => ({
      isSymbolicLink: () => path.resolve(requestedPath) === targetPath,
    }),
    realpath: async (requestedPath) => path.resolve(requestedPath),
    chown: async (ownedPath) => calls.push(['chown', ownedPath]),
    lchown: async (ownedPath, uid, gid) => calls.push(['lchown', ownedPath, uid, gid]),
  };

  await applyWorkspaceOwnership({
    workspaceRoot,
    targetPaths: [targetPath],
    includeParents: false,
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_DOCKER_UID: '1001',
      CLOUDCLI_DOCKER_GID: '1002',
    },
    fsImpl,
    logger: null,
  });

  assert.deepEqual(calls, [['lchown', targetPath, 1001, 1002]]);
});

test('workspace ownership changes owner without changing regular file mode', async () => {
  const workspaceRoot = path.resolve('/workspace/project');
  const targetPath = path.join(workspaceRoot, 'notes.md');
  const calls = [];
  const fsImpl = {
    lstat: async () => ({
      isSymbolicLink: () => false,
      uid: 0,
      gid: 0,
      mode: 0o100644,
    }),
    realpath: async (requestedPath) => path.resolve(requestedPath),
    chown: async (ownedPath, uid, gid) => calls.push(['chown', ownedPath, uid, gid]),
    chmod: async () => assert.fail('ownership normalization must not chmod files'),
  };

  await applyWorkspaceOwnership({
    workspaceRoot,
    targetPaths: [targetPath],
    includeParents: false,
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_DOCKER_UID: '1001',
      CLOUDCLI_DOCKER_GID: '1002',
    },
    fsImpl,
    logger: null,
  });

  assert.deepEqual(calls, [['chown', targetPath, 1001, 1002]]);
});
