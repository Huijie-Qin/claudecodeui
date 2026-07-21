import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaudeDockerExecArgs,
  buildClaudeDockerWrapperScript,
  buildContainerName,
  buildDockerRunArgs,
  buildRuntimePaths,
  createAgentSessionRuntimeManager,
  createClaudeDockerSpawn,
  ensureClaudeCleanupPeriod,
  ensureRuntimeHomeWritable,
  migratePathOwnership,
  parseDockerPythonPackages,
  resolveClaudeExecutionMode,
} from './agent-session-runtime.js';
import { MCP_CONTAINER_CONFIG_PATH } from './mcp-presets.js';
import {
  WORKSPACE_CONTAINER_ROOT_ENV,
  WORKSPACE_HOST_ROOT_ENV,
} from './workspace-path-mapping.js';

const emptyUserEnvDb = {
  getUserById: (userId) => ({ id: userId, username: `user-${userId}` }),
  getEnvForUser: () => ({}),
};

test('resolveClaudeExecutionMode defaults to local and accepts docker', () => {
  assert.equal(resolveClaudeExecutionMode({}), 'local');
  assert.equal(resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'local' }), 'local');
  assert.equal(resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'docker' }), 'docker');
  assert.throws(
    () => resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'podman' }),
    /CLAUDE_EXECUTION_MODE must be local or docker/,
  );
});

test('parseDockerPythonPackages accepts comma and whitespace separated package names', () => {
  assert.deepEqual(parseDockerPythonPackages('requests, httpx pyyaml\nrich'), [
    'requests',
    'httpx',
    'pyyaml',
    'rich',
  ]);
  assert.deepEqual(parseDockerPythonPackages('  ,  '), []);
});

test('runtime paths stay under the configured runtime root', () => {
  const runtimeRoot = path.resolve('/var/cloudcli/runtimes');
  const paths = buildRuntimePaths({
    runtimeRoot: '/var/cloudcli/runtimes',
    provider: 'claude',
    tenantCode: 'tenantA',
    username: 'userA',
    workspaceSlug: 'workspaceA',
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
  });

  assert.equal(
    paths.runtimeHomePath,
    path.join(runtimeRoot, 'claude', 'tenantA', 'userA', 'workspaceA', 'home'),
  );
  assert.equal(
    paths.wrapperDir,
    path.join(runtimeRoot, 'claude', 'tenantA', 'userA', 'workspaceA', 'wrapper'),
  );
});

test('container names are docker-safe and bounded', () => {
  const name = buildContainerName({
    provider: 'claude',
    tenantId: 300,
    userId: 400,
    workspaceId: 500,
    runtimeId: 'Runtime_With unsafe symbols and a very long suffix that should be shortened',
  });

  assert.match(name, /^cloudcli-claude-t300-u400-w500-r[a-z0-9-]+$/);
  assert.ok(name.length <= 120);
});

test('docker run args mount only workspace and runtime home', () => {
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rabc',
    image: 'cloudcli/test:claude',
    uid: 501,
    gid: 20,
    workspaceHostPath: '/tmp/team-a/workspace',
    runtimeHomePath: '/tmp/runtime/home',
    memory: '1g',
    cpus: '1',
  });
  const joined = args.join(' ');

  assert.equal(args[0], 'run');
  assert.ok(joined.includes('src=/tmp/team-a/workspace,dst=/workspace'));
  assert.ok(joined.includes('src=/tmp/runtime/home,dst=/home/cloudcli'));
  assert.ok(joined.includes('--cap-drop=ALL'));
  assert.ok(joined.includes('--security-opt no-new-privileges'));
  assert.ok(joined.includes('--read-only'));
  assert.equal(joined.includes('/.claude'), false);
  assert.equal(joined.includes('/var/run/docker.sock'), false);
});

test('docker workspace bind mount exposes project-level Claude skills to the container', () => {
  const workspaceHostPath = '/tmp/team-a/workspace';
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rabc',
    image: 'cloudcli/test:claude',
    uid: 501,
    gid: 20,
    workspaceHostPath,
    runtimeHomePath: '/tmp/runtime/home',
  });
  const joined = args.join(' ');

  assert.ok(joined.includes(`src=${workspaceHostPath},dst=/workspace`));
  assert.equal(
    path.relative(workspaceHostPath, path.join(workspaceHostPath, '.claude', 'skills')).replace(/\\/g, '/'),
    '.claude/skills',
  );
  assert.equal(path.posix.join('/workspace', '.claude', 'skills'), '/workspace/.claude/skills');
});

test('docker run args inject sanitized user environment values', () => {
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rabc',
    image: 'cloudcli/test:claude',
    uid: 501,
    gid: 20,
    workspaceHostPath: '/tmp/team-a/workspace',
    runtimeHomePath: '/tmp/runtime/home',
    containerEnv: {
      USER_KEY: 'security:AAAAAAAAAAAAAAAAAAAAAAAA:BBBB:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      W3_NAME: 'alice',
      TENANT_ID: '1',
      WORKSPACE_ID: '3',
      'BAD-NAME': 'ignored',
    },
  });
  const joined = args.join(' ');

  assert.ok(joined.includes('-e USER_KEY=security:AAAAAAAAAAAAAAAAAAAAAAAA:BBBB:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'));
  assert.ok(joined.includes('-e W3_NAME=alice'));
  assert.ok(joined.includes('-e TENANT_ID=1'));
  assert.ok(joined.includes('-e WORKSPACE_ID=3'));
  assert.equal(joined.includes('BAD-NAME'), false);
});

test('docker workspace bind mount exposes project-level MCP config to Claude CLI', () => {
  const workspaceHostPath = '/tmp/team-a/workspace';
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rabc',
    image: 'cloudcli/test:claude',
    uid: 501,
    gid: 20,
    workspaceHostPath,
    runtimeHomePath: '/tmp/runtime/home',
  });
  const joined = args.join(' ');

  assert.ok(joined.includes(`src=${workspaceHostPath},dst=/workspace`));
  assert.equal(path.relative(workspaceHostPath, path.join(workspaceHostPath, '.mcp.json')), '.mcp.json');
  assert.equal(MCP_CONTAINER_CONFIG_PATH, '/workspace/.mcp.json');
  assert.equal(path.posix.join('/workspace', '.mcp.json'), MCP_CONTAINER_CONFIG_PATH);
});

test('claude docker wrapper tolerates an empty forwarded env array', () => {
  const wrapper = buildClaudeDockerWrapperScript({
    containerName: 'cloudcli-claude-test',
  });

  assert.match(wrapper, /\$\{DOCKER_ENV\[@\]\+"\$\{DOCKER_ENV\[@\]\}"\}/);
  assert.match(wrapper, /set -euo pipefail/);
});

test('docker exec args forward allowed environment and Claude arguments', () => {
  const args = buildClaudeDockerExecArgs({
    containerName: 'cloudcli-claude-test',
    args: ['--model', 'glm-5.1'],
    env: {
      ANTHROPIC_BASE_URL: 'https://gateway.example.test',
      ANTHROPIC_MODEL: 'glm-5.1',
      PRIVATE_TOKEN: 'private-token',
      'BAD-NAME': 'ignored',
    },
  });

  assert.deepEqual(args.slice(0, 7), [
    'exec',
    '-i',
    '-w',
    '/workspace',
    '-e',
    'HOME=/home/cloudcli',
    '-e',
  ]);
  assert.ok(args.includes('ANTHROPIC_BASE_URL=https://gateway.example.test'));
  assert.ok(args.includes('ANTHROPIC_MODEL=glm-5.1'));
  assert.ok(args.includes('PRIVATE_TOKEN=private-token'));
  assert.equal(args.includes('BAD-NAME=ignored'), false);
  assert.deepEqual(args.slice(-4), ['cloudcli-claude-test', 'claude', '--model', 'glm-5.1']);
});

test('custom docker spawn bypasses host wrapper execution', () => {
  const calls = [];
  const child = { stdin: {}, stdout: {}, killed: false, exitCode: null };
  const spawnClaudeCodeProcess = createClaudeDockerSpawn({
    containerName: 'cloudcli-claude-test',
    envAllowlist: ['ANTHROPIC_MODEL'],
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    },
  });

  const result = spawnClaudeCodeProcess({
    command: 'C:\\runtime\\claude-docker-wrapper',
    args: ['--model', 'glm-5.1'],
    env: { ANTHROPIC_MODEL: 'glm-5.1', PATH: 'C:\\bin' },
    signal: new AbortController().signal,
  });

  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'docker');
  assert.deepEqual(calls[0][1], [
    'exec',
    '-i',
    '-w',
    '/workspace',
    '-e',
    'HOME=/home/cloudcli',
    '-e',
    'ANTHROPIC_MODEL=glm-5.1',
    'cloudcli-claude-test',
    'claude',
    '--model',
    'glm-5.1',
  ]);
  assert.equal(calls[0][2].env.PATH, 'C:\\bin');
  assert.deepEqual(calls[0][2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0][2].windowsHide, true);
});

test('docker runtime home is owned by the sandbox user when possible', async () => {
  const calls = [];
  const fsMock = {
    mkdir: async (targetPath, options) => calls.push(['mkdir', targetPath, options]),
    chown: async (targetPath, uid, gid) => calls.push(['chown', targetPath, uid, gid]),
    chmod: async (targetPath, mode) => calls.push(['chmod', targetPath, mode]),
  };

  await ensureRuntimeHomeWritable(fsMock, '/tmp/runtime/home', { uid: 1000, gid: 1000 });

  assert.deepEqual(calls, [
    ['mkdir', '/tmp/runtime/home', { recursive: true }],
    ['chown', '/tmp/runtime/home', 1000, 1000],
    ['chmod', '/tmp/runtime/home', 0o700],
  ]);
});

test('docker runtime home falls back to writable permissions when chown fails', async () => {
  const calls = [];
  const fsMock = {
    mkdir: async (targetPath, options) => calls.push(['mkdir', targetPath, options]),
    chown: async () => {
      throw new Error('operation not permitted');
    },
    chmod: async (targetPath, mode) => calls.push(['chmod', targetPath, mode]),
  };

  await ensureRuntimeHomeWritable(fsMock, '/tmp/runtime/home', { uid: 1000, gid: 1000 });

  assert.deepEqual(calls, [
    ['mkdir', '/tmp/runtime/home', { recursive: true }],
    ['chmod', '/tmp/runtime/home', 0o777],
  ]);
});

test('runtime ownership migration recursively chowns entries without following symlinks', async () => {
  const calls = [];
  const linkPath = path.join('/workspace', 'link');
  const fsMock = {
    lstat: async (targetPath) => ({
      isDirectory: () => targetPath === '/workspace',
      isSymbolicLink: () => targetPath === linkPath,
    }),
    readdir: async () => [
      { name: 'file.txt' },
      { name: 'link' },
    ],
    chown: async (targetPath, uid, gid) => calls.push(['chown', targetPath, uid, gid]),
    lchown: async (targetPath, uid, gid) => calls.push(['lchown', targetPath, uid, gid]),
  };

  const migratedEntries = await migratePathOwnership(
    fsMock,
    '/workspace',
    { uid: 1000, gid: 1000 },
  );

  assert.equal(migratedEntries, 3);
  assert.deepEqual(calls, [
    ['chown', path.join('/workspace', 'file.txt'), 1000, 1000],
    ['lchown', linkPath, 1000, 1000],
    ['chown', '/workspace', 1000, 1000],
  ]);
});

test('claude runtime settings preserve existing values and set the cleanup period', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-settings-test-'));
  const claudeDir = path.join(tempRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ theme: 'dark', cleanupPeriodDays: 30 }), 'utf8');

  assert.equal(await ensureClaudeCleanupPeriod(fs, tempRoot), true);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), {
    theme: 'dark',
    cleanupPeriodDays: 36500,
  });
});

test('claude runtime settings are not rewritten when the cleanup period is already configured', async () => {
  const calls = [];
  const fsMock = {
    readFile: async () => JSON.stringify({ cleanupPeriodDays: 36500 }),
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
  };

  assert.equal(await ensureClaudeCleanupPeriod(fsMock, '/tmp/runtime/home'), false);
  assert.deepEqual(calls, []);
});

test('docker mode creates runtime home, wrapper, DB row, and container', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  const createdRuntimes = [];
  const dockerCalls = [];
  const pythonPackageInstalls = [];
  const encryptedUserKey = 'security:AAAAAAAAAAAAAAAAAAAAAAAA:BBBB:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  let envUserId = null;
  let usernameUserId = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
      CLOUDCLI_DOCKER_PYTHON_PACKAGES: 'requests, httpx',
      ANTHROPIC_API_KEY: 'key-1',
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://secure-proxy.example:8443',
      http_proxy: 'http://lower-proxy.example:8080',
      https_proxy: 'http://lower-secure-proxy.example:8443',
      MCP_DATA_SOURCE_KEY: 'host-mcp-data-source-key',
      EXTRA_SECRET: 'do-not-forward',
    },
    multitenancy: {
      runtimes: {
        createRuntime: (runtime) => {
          createdRuntimes.push(runtime);
          return {
            runtime_id: runtime.runtimeId,
            tenant_id: runtime.tenantId,
            workspace_id: runtime.workspaceId,
            user_id: runtime.userId,
            provider: runtime.provider,
            container_name: runtime.containerName,
            image: runtime.image,
            workspace_host_path: runtime.workspaceHostPath,
            runtime_home_path: runtime.runtimeHomePath,
            status: 'pending',
          };
        },
        findByProviderSession: () => null,
        updateStatus: (input) => ({
          runtime_id: createdRuntimes[0].runtimeId,
          container_name: createdRuntimes[0].containerName,
          image: createdRuntimes[0].image,
          workspace_host_path: createdRuntimes[0].workspaceHostPath,
          runtime_home_path: createdRuntimes[0].runtimeHomePath,
          status: input.status,
        }),
      },
    },
    users: {
      getUserById: (userId) => {
        usernameUserId = userId;
        return { id: userId, username: 'alice' };
      },
      getEnvForUser: (userId) => {
        envUserId = userId;
        return {
          USER_KEY: encryptedUserKey,
          'BAD-NAME': 'do-not-forward',
        };
      },
    },
    docker: {
      inspectContainer: async () => null,
      runDetached: async (args) => {
        dockerCalls.push(args);
      },
      installPythonPackages: async (containerName, packages) => {
        pythonPackageInstalls.push({ containerName, packages });
      },
    },
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
  });

  assert.equal(runtime.mode, 'docker');
  assert.equal(runtime.cwd, workspaceRealPath);
  assert.equal(runtime.containerCwd, '/workspace');
  assert.equal(runtime.projectPath, '/workspace');
  assert.equal(typeof runtime.spawnClaudeCodeProcess, 'function');
  assert.equal(createdRuntimes.length, 1);
  assert.equal(dockerCalls.length, 1);
  assert.deepEqual(pythonPackageInstalls, [{
    containerName: createdRuntimes[0].containerName,
    packages: ['requests', 'httpx'],
  }]);
  assert.equal(usernameUserId, 4);
  assert.equal(envUserId, 4);
  assert.equal(createdRuntimes[0].workspaceHostPath, workspaceRealPath);
  assert.ok(runtime.runtimeHomePath.startsWith(runtimeRoot));
  assert.equal(runtime.executionEnv.USER_KEY, encryptedUserKey);
  assert.equal(runtime.executionEnv.W3_NAME, 'alice');
  assert.equal(runtime.executionEnv.TENANT_ID, '3');
  assert.equal(runtime.executionEnv.WORKSPACE_ID, '5');
  assert.equal(runtime.executionEnv.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(runtime.executionEnv.HTTPS_PROXY, 'http://secure-proxy.example:8443');
  assert.equal(runtime.executionEnv.http_proxy, 'http://lower-proxy.example:8080');
  assert.equal(runtime.executionEnv.https_proxy, 'http://lower-secure-proxy.example:8443');
  assert.equal(runtime.executionEnv.MCP_DATA_SOURCE_KEY, 'host-mcp-data-source-key');
  assert.equal(Object.hasOwn(runtime.executionEnv, 'BAD-NAME'), false);
  assert.ok(dockerCalls[0].join(' ').includes(`USER_KEY=${encryptedUserKey}`));
  assert.ok(dockerCalls[0].join(' ').includes('W3_NAME=alice'));
  assert.ok(dockerCalls[0].join(' ').includes('TENANT_ID=3'));
  assert.ok(dockerCalls[0].join(' ').includes('WORKSPACE_ID=5'));
  assert.ok(dockerCalls[0].join(' ').includes('MCP_DATA_SOURCE_KEY=host-mcp-data-source-key'));
  assert.equal(dockerCalls[0].join(' ').includes('BAD-NAME'), false);

  const wrapper = await fs.readFile(runtime.pathToClaudeCodeExecutable, 'utf8');
  assert.match(wrapper, /^#!\/usr\/bin\/env bash/);
  assert.match(wrapper, /docker exec -i/);
  assert.match(wrapper, /-e ANTHROPIC_API_KEY/);
  assert.match(wrapper, /-e HTTP_PROXY/);
  assert.match(wrapper, /-e HTTPS_PROXY/);
  assert.match(wrapper, /-e http_proxy/);
  assert.match(wrapper, /-e https_proxy/);
  assert.match(wrapper, /-e USER_KEY/);
  assert.match(wrapper, /-e W3_NAME/);
  assert.match(wrapper, /-e TENANT_ID/);
  assert.match(wrapper, /-e WORKSPACE_ID/);
  assert.match(wrapper, /-e MCP_DATA_SOURCE_KEY/);
  assert.equal(wrapper.includes('EXTRA_SECRET'), false);
  assert.equal(wrapper.includes('BAD-NAME'), false);
});

test('docker mode prepares new workspace ownership before creating its first container', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-new-ownership-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'root-owned.txt'), 'test');
  const workspaceRealPath = await fs.realpath(workspacePath);

  const events = [];
  const ownershipChanges = [];
  const logs = [];
  let runtimeRow = null;
  const fsMock = {
    ...fs,
    chown: async (targetPath, uid, gid) => {
      ownershipChanges.push({ targetPath, uid, gid });
    },
    lchown: async (targetPath, uid, gid) => {
      ownershipChanges.push({ targetPath, uid, gid, symlink: true });
    },
  };
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_DOCKER_UID: '1000',
      CLOUDCLI_DOCKER_GID: '1000',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => null,
        findByOwner: () => null,
        createRuntime: (input) => {
          runtimeRow = {
            runtime_id: input.runtimeId,
            tenant_id: input.tenantId,
            workspace_id: input.workspaceId,
            user_id: input.userId,
            provider: input.provider,
            container_name: input.containerName,
            image: input.image,
            workspace_host_path: input.workspaceHostPath,
            runtime_home_path: input.runtimeHomePath,
            status: input.status,
          };
          return runtimeRow;
        },
        updateStatus: (input) => ({ ...runtimeRow, status: input.status }),
      },
    },
    users: emptyUserEnvDb,
    fs: fsMock,
    docker: {
      inspectContainer: async () => null,
      runDetached: async (args) => events.push(`run:${args[args.indexOf('--user') + 1]}`),
      verifyWorkspaceCwd: async () => events.push('verify'),
    },
  });

  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await manager.prepareClaudeRuntime({
      tenantId: 3,
      userId: 4,
      workspaceId: 5,
      cwd: workspacePath,
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(events, ['run:1000:1000', 'verify']);
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === workspaceRealPath));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === path.join(workspaceRealPath, 'root-owned.txt')));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === runtimeRow.runtime_home_path));
  assert.ok(ownershipChanges.every((entry) => entry.uid === 1000 && entry.gid === 1000));
  assert.ok(logs.some((entry) => entry.includes('container_ownership_prepare_completed')));
  assert.ok(logs.some((entry) => entry.includes('"targetUser":"1000:1000"')));
});

test('docker mode validates a mapped container workspace while keeping the host path', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-mapped-workspace-'));
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  const containerRoot = path.join(tempRoot, 'host-home');
  const mappedWorkspacePath = path.join(containerRoot, 'default', 'j00939207', 'test');
  await fs.mkdir(mappedWorkspacePath, { recursive: true });

  const hostRoot = `C:\\cloudcli-missing-${Date.now()}-${process.pid}`;
  const workspacePath = `${hostRoot}\\default\\j00939207\\test`;
  const createdRuntimes = [];
  const dockerCalls = [];
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
      [WORKSPACE_HOST_ROOT_ENV]: hostRoot,
      [WORKSPACE_CONTAINER_ROOT_ENV]: containerRoot,
    },
    multitenancy: {
      runtimes: {
        createRuntime: (runtime) => {
          createdRuntimes.push(runtime);
          return {
            runtime_id: runtime.runtimeId,
            tenant_id: runtime.tenantId,
            workspace_id: runtime.workspaceId,
            user_id: runtime.userId,
            provider: runtime.provider,
            container_name: runtime.containerName,
            image: runtime.image,
            workspace_host_path: runtime.workspaceHostPath,
            runtime_home_path: runtime.runtimeHomePath,
            status: 'pending',
          };
        },
        findByProviderSession: () => null,
        updateStatus: (input) => ({
          runtime_id: createdRuntimes[0].runtimeId,
          container_name: createdRuntimes[0].containerName,
          image: createdRuntimes[0].image,
          workspace_host_path: createdRuntimes[0].workspaceHostPath,
          runtime_home_path: createdRuntimes[0].runtimeHomePath,
          status: input.status,
        }),
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => null,
      runDetached: async (args) => {
        dockerCalls.push(args);
      },
    },
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 1,
    userId: 2,
    workspaceId: 3,
    cwd: workspacePath,
  });

  assert.equal(runtime.cwd, workspacePath);
  assert.equal(runtime.hostWorkspacePath, workspacePath);
  assert.equal(createdRuntimes[0].workspaceHostPath, workspacePath);
  assert.ok(dockerCalls[0].join(' ').includes(`src=${workspacePath},dst=/workspace`));
});

test('docker mode does not wait for configured Python package installation', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-async-python-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  const createdRuntimes = [];
  let installStarted = false;
  let installFinished = false;
  let releaseInstall;
  let installPromise;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
      CLOUDCLI_DOCKER_PYTHON_PACKAGES: 'requests',
    },
    multitenancy: {
      runtimes: {
        createRuntime: (runtime) => {
          createdRuntimes.push(runtime);
          return {
            runtime_id: runtime.runtimeId,
            tenant_id: runtime.tenantId,
            workspace_id: runtime.workspaceId,
            user_id: runtime.userId,
            provider: runtime.provider,
            container_name: runtime.containerName,
            image: runtime.image,
            workspace_host_path: runtime.workspaceHostPath,
            runtime_home_path: runtime.runtimeHomePath,
            status: 'pending',
          };
        },
        findByProviderSession: () => null,
        updateStatus: (input) => ({
          runtime_id: createdRuntimes[0].runtimeId,
          container_name: createdRuntimes[0].containerName,
          image: createdRuntimes[0].image,
          workspace_host_path: createdRuntimes[0].workspaceHostPath,
          runtime_home_path: createdRuntimes[0].runtimeHomePath,
          status: input.status,
        }),
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => null,
      runDetached: async () => undefined,
      installPythonPackages: () => {
        installStarted = true;
        installPromise = new Promise((resolve) => {
          releaseInstall = resolve;
        }).then(() => {
          installFinished = true;
        });
        return installPromise;
      },
    },
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
  });

  assert.equal(runtime.mode, 'docker');
  assert.equal(runtime.cwd, workspaceRealPath);
  assert.equal(installStarted, true);
  assert.equal(installFinished, false);

  releaseInstall();
  await installPromise;
  assert.equal(installFinished, true);
});

test('docker mode resumes an existing runtime home for provider session id', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-resume-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtimes', 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-existing', 'home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  let created = false;
  let startedContainer = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        createRuntime: () => {
          created = true;
        },
        findByProviderSession: () => ({
          runtime_id: 'existing',
          tenant_id: 3,
          workspace_id: 5,
          user_id: 4,
          provider: 'claude',
          provider_session_id: 'claude-session-1',
          container_name: 'cloudcli-claude-existing',
          image: 'cloudcli/test:claude',
          workspace_host_path: workspaceRealPath,
          runtime_home_path: runtimeHomePath,
          status: 'idle',
        }),
        updateStatus: () => ({
          runtime_id: 'existing',
          container_name: 'cloudcli-claude-existing',
          image: 'cloudcli/test:claude',
          workspace_host_path: workspaceRealPath,
          runtime_home_path: runtimeHomePath,
          status: 'active',
        }),
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => ({ exists: true, running: false }),
      startContainer: async (name) => {
        startedContainer = name;
      },
      runDetached: async () => {
        throw new Error('must not create a fresh container for resume');
      },
    },
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });

  assert.equal(created, false);
  assert.equal(startedContainer, 'cloudcli-claude-existing');
  assert.equal(runtime.runtimeHomePath, runtimeHomePath);
  assert.equal(runtime.runtimeId, 'existing');
});

test('docker mode migrates an existing root container to the configured non-root user', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-user-migration-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'project.txt'), 'project');
  await fs.writeFile(path.join(runtimeHomePath, 'session.json'), '{}');
  const workspaceRealPath = await fs.realpath(workspacePath);

  const runtimeRow = {
    runtime_id: 'existing-root-runtime',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-root',
    container_name: 'cloudcli-claude-existing-root',
    image: 'cloudcli/test:claude',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'idle',
  };
  const events = [];
  const ownershipChanges = [];
  const logs = [];
  const fsMock = {
    ...fs,
    chown: async (targetPath, uid, gid) => ownershipChanges.push({ targetPath, uid, gid }),
    lchown: async (targetPath, uid, gid) => ownershipChanges.push({ targetPath, uid, gid, symlink: true }),
  };
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_DOCKER_UID: '1000',
      CLOUDCLI_DOCKER_GID: '1000',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => runtimeRow,
        updateStatus: (input) => ({ ...runtimeRow, status: input.status }),
      },
    },
    users: emptyUserEnvDb,
    fs: fsMock,
    docker: {
      inspectContainer: async () => ({ exists: true, running: true, user: '0:0' }),
      stopContainer: async () => events.push('stop'),
      removeContainer: async () => events.push('remove'),
      runDetached: async (args) => events.push(`run:${args[args.indexOf('--user') + 1]}`),
      verifyWorkspaceCwd: async () => events.push('verify'),
    },
  });

  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await manager.prepareClaudeRuntime({
      tenantId: 3,
      userId: 4,
      workspaceId: 5,
      cwd: workspacePath,
      sessionId: 'claude-session-root',
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(events, ['stop', 'remove', 'run:1000:1000', 'verify']);
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === workspaceRealPath));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === runtimeHomePath));
  assert.ok(ownershipChanges.every((entry) => entry.uid === 1000 && entry.gid === 1000));
  assert.ok(logs.some((entry) => entry.includes('container_user_migration_completed')));
  assert.ok(logs.some((entry) => entry.includes('"previousUser":"0:0"')));
  assert.ok(logs.some((entry) => entry.includes('"targetUser":"1000:1000"')));
});

test('docker mode recreates a running container when workspace cwd is unhealthy', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-unhealthy-workspace-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtimes', 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-existing', 'home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: null,
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:claude',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'active',
  };
  let created = false;
  let removedContainer = null;
  const dockerRuns = [];
  let workspaceChecks = 0;

  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        createRuntime: () => {
          created = true;
        },
        findByProviderSession: () => null,
        findByOwner: () => runtimeRow,
        updateStatus: (input) => ({ ...runtimeRow, status: input.status }),
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => ({ exists: true, running: true, status: 'running' }),
      verifyWorkspaceCwd: async () => {
        workspaceChecks += 1;
        if (workspaceChecks === 1) {
          const error = new Error('OCI runtime exec failed');
          error.stderr = 'current working directory is outside of container mount namespace root';
          throw error;
        }
      },
      removeContainer: async (name) => {
        removedContainer = name;
      },
      runDetached: async (args) => {
        dockerRuns.push(args);
      },
    },
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
  });

  assert.equal(created, false);
  assert.equal(removedContainer, 'cloudcli-claude-existing');
  assert.equal(dockerRuns.length, 1);
  assert.equal(workspaceChecks, 2);
  assert.equal(runtime.runtimeId, 'existing');
});

test('docker mode stopRuntime stops the session container and marks runtime idle', async () => {
  let stoppedContainer = null;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findByRuntimeId: (runtimeId) => ({
          runtime_id: runtimeId,
          container_name: 'cloudcli-claude-active',
          status: 'active',
        }),
        updateStatus: (input) => {
          statusUpdate = input;
          return { runtime_id: input.runtimeId, status: input.status };
        },
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: true }),
      stopContainer: async (name) => {
        stoppedContainer = name;
      },
    },
  });

  const stopped = await manager.stopRuntime('runtime-1');

  assert.equal(stopped, true);
  assert.equal(stoppedContainer, 'cloudcli-claude-active');
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-1', status: 'idle' });
});

test('docker mode stopRuntime is idempotent for an exited container', async () => {
  let stoppedContainer = null;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findByRuntimeId: (runtimeId) => ({
          runtime_id: runtimeId,
          container_name: 'cloudcli-claude-exited',
          status: 'active',
        }),
        updateStatus: (input) => {
          statusUpdate = input;
          return { runtime_id: input.runtimeId, status: input.status };
        },
      },
    },
    docker: {
      inspectContainer: async () => ({
        exists: true,
        running: false,
        state: {
          Running: false,
          Status: 'exited',
          ExitCode: 0,
        },
        status: 'exited',
        exitCode: 0,
      }),
      stopContainer: async (name) => {
        stoppedContainer = name;
      },
    },
  });

  const stopped = await manager.stopRuntime('runtime-exited');

  assert.equal(stopped, true);
  assert.equal(stoppedContainer, null);
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-exited', status: 'idle' });
});

test('docker mode stopRuntime is idempotent for a missing container', async () => {
  let stoppedContainer = null;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findByRuntimeId: (runtimeId) => ({
          runtime_id: runtimeId,
          container_name: 'cloudcli-claude-missing',
          status: 'active',
        }),
        updateStatus: (input) => {
          statusUpdate = input;
          return { runtime_id: input.runtimeId, status: input.status };
        },
      },
    },
    docker: {
      inspectContainer: async () => null,
      stopContainer: async (name) => {
        stoppedContainer = name;
      },
    },
  });

  const stopped = await manager.stopRuntime('runtime-missing');

  assert.equal(stopped, true);
  assert.equal(stoppedContainer, null);
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-missing', status: 'idle' });
});

test('docker mode stopExpiredIdleRuntime skips runtimes that are no longer expired idle', async () => {
  let inspected = false;
  let stopped = false;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findExpiredIdleRuntimeById: () => null,
        updateStatus: (input) => {
          statusUpdate = input;
          return { runtime_id: input.runtimeId, status: input.status };
        },
      },
    },
    docker: {
      inspectContainer: async () => {
        inspected = true;
        return { exists: true, running: true };
      },
      stopContainer: async () => {
        stopped = true;
      },
    },
  });

  const result = await manager.stopExpiredIdleRuntime({
    runtimeId: 'runtime-resumed',
    olderThanMinutes: 30,
  });

  assert.equal(result, false);
  assert.equal(inspected, false);
  assert.equal(stopped, false);
  assert.equal(statusUpdate, null);
});

test('docker mode stopExpiredIdleRuntime returns false for missing or invalid args', async () => {
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findExpiredIdleRuntimeById: () => {
          throw new Error('invalid args should not query DB');
        },
      },
    },
    docker: {},
  });

  assert.equal(await manager.stopExpiredIdleRuntime(), false);
  assert.equal(await manager.stopExpiredIdleRuntime({ runtimeId: '', olderThanMinutes: 30 }), false);
  assert.equal(await manager.stopExpiredIdleRuntime({ runtimeId: 'runtime-1', olderThanMinutes: 0 }), false);
});

test('docker mode stopExpiredIdleRuntime stops a running expired idle container and marks idle', async () => {
  let stoppedContainer = null;
  let statusUpdate = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
    },
    multitenancy: {
      runtimes: {
        findExpiredIdleRuntimeById: ({ runtimeId, olderThanMinutes }) => {
          assert.equal(runtimeId, 'runtime-idle');
          assert.equal(olderThanMinutes, 30);
          return {
            runtime_id: runtimeId,
            container_name: 'cloudcli-claude-idle',
            status: 'idle',
          };
        },
        updateStatus: (input) => {
          statusUpdate = input;
          return { runtime_id: input.runtimeId, status: input.status };
        },
      },
    },
    docker: {
      inspectContainer: async () => ({ exists: true, running: true }),
      stopContainer: async (name) => {
        stoppedContainer = name;
      },
    },
  });

  const result = await manager.stopExpiredIdleRuntime({
    runtimeId: 'runtime-idle',
    olderThanMinutes: 30,
  });

  assert.equal(result, true);
  assert.equal(stoppedContainer, 'cloudcli-claude-idle');
  assert.deepEqual(statusUpdate, { runtimeId: 'runtime-idle', status: 'idle' });
});

test('docker mode serializes protected stop and existing-runtime resume for the same runtime', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-lock-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtimes', 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-existing', 'home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const events = [];
  let stopped = false;
  let resolveStopStarted;
  let releaseStop;
  const stopStarted = new Promise((resolve) => {
    resolveStopStarted = resolve;
  });
  const stopRelease = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:claude',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'idle',
  };
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        findExpiredIdleRuntimeById: () => runtimeRow,
        findByProviderSession: () => runtimeRow,
        updateStatus: (input) => {
          events.push(`mark-${input.status}`);
          return { ...runtimeRow, status: input.status };
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => ({ exists: true, running: !stopped }),
      stopContainer: async () => {
        events.push('stop-start');
        resolveStopStarted();
        await stopRelease;
        stopped = true;
        events.push('stop-end');
      },
      startContainer: async () => {
        events.push('start');
      },
      runDetached: async () => {
        throw new Error('must not create a fresh container for resume');
      },
    },
  });

  const stopPromise = manager.stopExpiredIdleRuntime({
    runtimeId: 'existing',
    olderThanMinutes: 30,
  });
  await stopStarted;

  const preparePromise = manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stop-start']);

  releaseStop();
  assert.equal(await stopPromise, true);
  const prepared = await preparePromise;

  assert.equal(prepared.runtimeId, 'existing');
  assert.deepEqual(events, ['stop-start', 'stop-end', 'mark-idle', 'start', 'mark-active']);
});

test('docker mode serializes manual stop after existing-runtime resume when prepare wins first', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-manual-lock-prepare-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtimes', 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-existing', 'home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const events = [];
  let stopped = false;
  let status = 'idle';
  let inspectCount = 0;
  let resolvePrepareInspectStarted;
  let releasePrepareInspect;
  const prepareInspectStarted = new Promise((resolve) => {
    resolvePrepareInspectStarted = resolve;
  });
  const prepareInspectRelease = new Promise((resolve) => {
    releasePrepareInspect = resolve;
  });
  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:claude',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status,
  };
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ ...runtimeRow, status }),
        findByRuntimeId: () => ({ ...runtimeRow, status }),
        updateStatus: (input) => {
          status = input.status;
          events.push(`mark-${input.status}`);
          return { ...runtimeRow, status };
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => {
        inspectCount += 1;
        if (inspectCount === 1) {
          events.push('inspect-prepare-start');
          resolvePrepareInspectStarted();
          await prepareInspectRelease;
          events.push('inspect-prepare-end');
          return { exists: true, running: true };
        }
        events.push('inspect-stop');
        return { exists: true, running: !stopped };
      },
      stopContainer: async () => {
        events.push('stop');
        stopped = true;
      },
      startContainer: async () => {
        events.push('start');
        stopped = false;
      },
      runDetached: async () => {
        throw new Error('must not create a fresh container for resume');
      },
    },
  });

  const preparePromise = manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });
  await prepareInspectStarted;

  const stopPromise = manager.stopRuntime('existing');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['inspect-prepare-start']);

  releasePrepareInspect();
  const prepared = await preparePromise;
  assert.equal(prepared.runtimeId, 'existing');
  assert.equal(await stopPromise, true);

  assert.equal(status, 'idle');
  assert.equal(stopped, true);
  assert.deepEqual(events, [
    'inspect-prepare-start',
    'inspect-prepare-end',
    'mark-active',
    'inspect-stop',
    'stop',
    'mark-idle',
  ]);
});

test('docker mode serializes manual stop after new-runtime activation when prepare wins first', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-new-lock-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const events = [];
  let runtimeRow = null;
  let stopped = false;
  let status = 'pending';
  let inspectCount = 0;
  let resolveRunStarted;
  let releaseRun;
  const runStarted = new Promise((resolve) => {
    resolveRunStarted = resolve;
  });
  const runRelease = new Promise((resolve) => {
    releaseRun = resolve;
  });
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        createRuntime: (runtime) => {
          runtimeRow = {
            runtime_id: runtime.runtimeId,
            tenant_id: runtime.tenantId,
            workspace_id: runtime.workspaceId,
            user_id: runtime.userId,
            provider: runtime.provider,
            provider_session_id: null,
            container_name: runtime.containerName,
            image: runtime.image,
            workspace_host_path: runtime.workspaceHostPath,
            runtime_home_path: runtime.runtimeHomePath,
            status,
          };
          events.push('create-pending');
          return runtimeRow;
        },
        findByRuntimeId: () => ({ ...runtimeRow, status }),
        updateStatus: (input) => {
          status = input.status;
          events.push(`mark-${input.status}`);
          return { ...runtimeRow, status };
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => {
        inspectCount += 1;
        if (inspectCount === 1) {
          events.push('inspect-prepare');
          return null;
        }
        events.push('inspect-stop');
        return { exists: true, running: !stopped };
      },
      runDetached: async () => {
        events.push('run-start');
        resolveRunStarted();
        await runRelease;
        stopped = false;
        events.push('run-end');
      },
      stopContainer: async () => {
        events.push('stop');
        stopped = true;
      },
      startContainer: async () => {
        events.push('start');
        stopped = false;
      },
    },
  });

  const preparePromise = manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
  });
  await runStarted;

  const stopPromise = manager.stopRuntime(runtimeRow.runtime_id);
  await new Promise((resolve) => setImmediate(resolve));
  const eventsBeforeRelease = [...events];

  releaseRun();
  const prepared = await preparePromise;
  assert.equal(await stopPromise, true);

  assert.deepEqual(eventsBeforeRelease, ['create-pending', 'inspect-prepare', 'run-start']);
  assert.equal(prepared.runtimeId, runtimeRow.runtime_id);
  assert.equal(status, 'idle');
  assert.equal(stopped, true);
  assert.deepEqual(events, [
    'create-pending',
    'inspect-prepare',
    'run-start',
    'run-end',
    'mark-active',
    'inspect-stop',
    'stop',
    'mark-idle',
  ]);
  assert.equal(runtimeRow.workspace_host_path, workspaceRealPath);
});

test('docker mode serializes existing-runtime resume after manual stop when stop wins first', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-manual-lock-stop-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtimes', 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-existing', 'home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const events = [];
  let stopped = false;
  let status = 'active';
  let resolveStopStarted;
  let releaseStop;
  const stopStarted = new Promise((resolve) => {
    resolveStopStarted = resolve;
  });
  const stopRelease = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:claude',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status,
  };
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => ({ ...runtimeRow, status }),
        findByRuntimeId: () => ({ ...runtimeRow, status }),
        updateStatus: (input) => {
          status = input.status;
          events.push(`mark-${input.status}`);
          return { ...runtimeRow, status };
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => {
        if (events.includes('stop-start')) {
          events.push('inspect-prepare');
          return { exists: true, running: !stopped };
        }
        events.push('inspect-stop');
        return { exists: true, running: !stopped };
      },
      stopContainer: async () => {
        events.push('stop-start');
        resolveStopStarted();
        await stopRelease;
        stopped = true;
        events.push('stop-end');
      },
      startContainer: async () => {
        events.push('start');
        stopped = false;
      },
      runDetached: async () => {
        throw new Error('must not create a fresh container for resume');
      },
    },
  });

  const stopPromise = manager.stopRuntime('existing');
  await stopStarted;

  const preparePromise = manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['inspect-stop', 'stop-start']);

  releaseStop();
  assert.equal(await stopPromise, true);
  const prepared = await preparePromise;

  assert.equal(prepared.runtimeId, 'existing');
  assert.equal(status, 'active');
  assert.equal(stopped, false);
  assert.deepEqual(events, [
    'inspect-stop',
    'stop-start',
    'stop-end',
    'mark-idle',
    'inspect-prepare',
    'start',
    'mark-active',
  ]);
});
