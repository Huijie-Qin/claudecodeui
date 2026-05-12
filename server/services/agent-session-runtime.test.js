import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaudeDockerWrapperScript,
  buildContainerName,
  buildDockerRunArgs,
  buildRuntimePaths,
  createAgentSessionRuntimeManager,
  ensureRuntimeHomeWritable,
  resolveClaudeExecutionMode,
} from './agent-session-runtime.js';
import { MCP_CONTAINER_CONFIG_PATH } from './mcp-presets.js';

const emptyUserEnvDb = {
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

test('runtime paths stay under the configured runtime root', () => {
  const runtimeRoot = path.resolve('/var/cloudcli/runtimes');
  const paths = buildRuntimePaths({
    runtimeRoot: '/var/cloudcli/runtimes',
    provider: 'claude',
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    runtimeId: 'runtime-abc',
  });

  assert.equal(
    paths.runtimeHomePath,
    path.join(runtimeRoot, 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-runtime-abc', 'home'),
  );
  assert.equal(
    paths.wrapperDir,
    path.join(runtimeRoot, 'claude', 'tenant-3', 'user-4', 'workspace-5', 'runtime-runtime-abc', 'wrapper'),
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
      'BAD-NAME': 'ignored',
    },
  });
  const joined = args.join(' ');

  assert.ok(joined.includes('-e USER_KEY=security:AAAAAAAAAAAAAAAAAAAAAAAA:BBBB:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'));
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

test('docker mode creates runtime home, wrapper, DB row, and container', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  const createdRuntimes = [];
  const dockerCalls = [];
  const encryptedUserKey = 'security:AAAAAAAAAAAAAAAAAAAAAAAA:BBBB:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  let envUserId = null;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: runtimeRoot,
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
      ANTHROPIC_API_KEY: 'key-1',
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
  assert.equal(createdRuntimes.length, 1);
  assert.equal(dockerCalls.length, 1);
  assert.equal(envUserId, 4);
  assert.equal(createdRuntimes[0].workspaceHostPath, workspaceRealPath);
  assert.ok(runtime.runtimeHomePath.startsWith(runtimeRoot));
  assert.equal(runtime.executionEnv.USER_KEY, encryptedUserKey);
  assert.equal(Object.hasOwn(runtime.executionEnv, 'BAD-NAME'), false);
  assert.ok(dockerCalls[0].join(' ').includes(`USER_KEY=${encryptedUserKey}`));
  assert.equal(dockerCalls[0].join(' ').includes('BAD-NAME'), false);

  const wrapper = await fs.readFile(runtime.pathToClaudeCodeExecutable, 'utf8');
  assert.match(wrapper, /^#!\/usr\/bin\/env bash/);
  assert.match(wrapper, /docker exec -i/);
  assert.match(wrapper, /-e ANTHROPIC_API_KEY/);
  assert.match(wrapper, /-e USER_KEY/);
  assert.equal(wrapper.includes('EXTRA_SECRET'), false);
  assert.equal(wrapper.includes('BAD-NAME'), false);
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
