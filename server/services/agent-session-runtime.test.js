import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
