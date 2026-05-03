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
  resolveClaudeExecutionMode,
} from './agent-session-runtime.js';

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
    '/var/cloudcli/runtimes/claude/tenant-3/user-4/workspace-5/runtime-runtime-abc/home',
  );
  assert.equal(
    paths.wrapperDir,
    '/var/cloudcli/runtimes/claude/tenant-3/user-4/workspace-5/runtime-runtime-abc/wrapper',
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

test('claude docker wrapper tolerates an empty forwarded env array', () => {
  const wrapper = buildClaudeDockerWrapperScript({
    containerName: 'cloudcli-claude-test',
  });

  assert.match(wrapper, /\$\{DOCKER_ENV\[@\]\+"\$\{DOCKER_ENV\[@\]\}"\}/);
  assert.match(wrapper, /set -euo pipefail/);
});

test('docker mode creates runtime home, wrapper, DB row, and container', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  await fs.mkdir(workspacePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  const createdRuntimes = [];
  const dockerCalls = [];
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
  assert.equal(createdRuntimes[0].workspaceHostPath, workspaceRealPath);
  assert.ok(runtime.runtimeHomePath.startsWith(runtimeRoot));

  const wrapper = await fs.readFile(runtime.pathToClaudeCodeExecutable, 'utf8');
  assert.match(wrapper, /^#!\/usr\/bin\/env bash/);
  assert.match(wrapper, /docker exec -i/);
  assert.match(wrapper, /-e ANTHROPIC_API_KEY/);
  assert.equal(wrapper.includes('EXTRA_SECRET'), false);
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
