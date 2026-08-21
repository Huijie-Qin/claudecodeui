import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildClaudeDockerExecArgs,
  buildClaudeDockerCreateEnv,
  buildClaudeDockerGuestEnv,
  buildClaudeDockerWrapperScript,
  buildClaudeWrapperDefaultEnv,
  buildContainerName,
  buildDockerHostProcessEnv,
  buildDockerPythonInstallArgs,
  buildDockerRunArgs,
  buildRuntimePaths,
  buildWrapperHostEnv,
  createAgentSessionRuntimeManager as createAgentSessionRuntimeManagerImpl,
  createClaudeDockerSpawn,
  CLAUDE_DOCKER_ENV_POLICY_ENV_NAME,
  DOCKER_BIND_CONTAINER_ROOT_ENV_NAME,
  DOCKER_BIND_HOST_ROOT_ENV_NAME,
  ensureClaudeCleanupPeriod,
  ensureRuntimeHomeWritable,
  inspectedContainerUsesClaudeEnvPolicy,
  inspectedContainerUsesSharedPython,
  migratePathOwnership,
  parseDockerPythonPackages,
  resolveClaudeExecutionMode,
  resolveDockerBindSourcePath,
  resolveDockerSharedPythonPath,
  rewriteDockerProxyEnv,
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

function createLayeredClaudeEnvResolver({ tenantEnvs = {}, personalEnv = {} } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      resolveEffectiveEnv(input) {
        calls.push(input);
        const env = {};
        const sources = {};
        const apply = (layer, source) => {
          for (const [name, value] of Object.entries(layer || {})) {
            env[name] = String(value);
            sources[name] = source;
          }
        };
        apply(input.baseEnv, 'baseEnv');
        apply(input.adminUserEnv, 'adminUserEnv');
        if (input.tenantId != null) apply(tenantEnvs[input.tenantId], 'tenant');
        const personalCredentialNames = [
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_API_KEY',
        ];
        if (personalCredentialNames.some((name) => Object.hasOwn(personalEnv, name))) {
          for (const name of personalCredentialNames) {
            delete env[name];
            delete sources[name];
          }
        }
        apply(personalEnv, 'personal');
        apply(input.managedEnv, 'managed');
        return { env, sources, blockedVariables: [] };
      },
    },
  };
}

const testDefaultClaudeEnvService = createLayeredClaudeEnvResolver().service;

function createAgentSessionRuntimeManager(options = {}) {
  return createAgentSessionRuntimeManagerImpl({
    claudeEnv: testDefaultClaudeEnvService,
    ...options,
  });
}

test('resolveClaudeExecutionMode defaults to local and accepts docker', () => {
  assert.equal(resolveClaudeExecutionMode({}), 'local');
  assert.equal(resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'local' }), 'local');
  assert.equal(resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'docker' }), 'docker');
  assert.throws(
    () => resolveClaudeExecutionMode({ CLAUDE_EXECUTION_MODE: 'podman' }),
    /CLAUDE_EXECUTION_MODE must be local or docker/,
  );
});

test('local Claude runtime resolves base, admin, selected tenant, personal, then managed env', async () => {
  const resolver = createLayeredClaudeEnvResolver({
    tenantEnvs: {
      8: { LAYER_VALUE: 'wrong-tenant' },
      9: { LAYER_VALUE: 'tenant', TENANT_ONLY: 'tenant-value' },
    },
    personalEnv: { LAYER_VALUE: 'personal', PERSONAL_ONLY: 'personal-value' },
  });
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'local',
      LAYER_VALUE: 'base',
      BASE_ONLY: 'base-value',
      LEGACY_EMPTY_OVERRIDE: 'keep-base-value',
      W3_NAME: 'base-name',
    },
    users: {
      getUserById: (userId) => ({ id: userId, username: 'alice' }),
      getEnvForUser: () => ({
        LAYER_VALUE: 'admin',
        ADMIN_ONLY: 'admin-value',
        ADMIN_EMPTY_ONLY: '',
        LEGACY_EMPTY_OVERRIDE: '',
        W3_NAME: 'admin-name',
      }),
    },
    claudeEnv: resolver.service,
  });

  const runtime = await manager.prepareClaudeRuntime({
    tenantId: 9,
    userId: 4,
    cwd: '/workspace/project',
  });

  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].tenantId, 9);
  assert.equal(resolver.calls[0].userId, 4);
  assert.equal(resolver.calls[0].baseEnv.LAYER_VALUE, 'base');
  assert.equal(resolver.calls[0].adminUserEnv.LAYER_VALUE, 'admin');
  assert.equal(Object.hasOwn(resolver.calls[0].adminUserEnv, 'LEGACY_EMPTY_OVERRIDE'), false);
  assert.equal(resolver.calls[0].adminUserEnv.ADMIN_EMPTY_ONLY, '');
  assert.equal(resolver.calls[0].managedEnv.W3_NAME, 'alice');
  assert.equal(resolver.calls[0].managedEnv.TENANT_ID, '9');
  assert.equal(runtime.executionEnv.LAYER_VALUE, 'personal');
  assert.equal(runtime.executionEnv.BASE_ONLY, 'base-value');
  assert.equal(runtime.executionEnv.ADMIN_ONLY, 'admin-value');
  assert.equal(runtime.executionEnv.ADMIN_EMPTY_ONLY, '');
  assert.equal(runtime.executionEnv.LEGACY_EMPTY_OVERRIDE, 'keep-base-value');
  assert.equal(runtime.executionEnv.TENANT_ONLY, 'tenant-value');
  assert.equal(runtime.executionEnv.PERSONAL_ONLY, 'personal-value');
  assert.equal(runtime.executionEnv.W3_NAME, 'alice');
});

test('local Claude runtime resolves global personal env without a tenant', async () => {
  const resolver = createLayeredClaudeEnvResolver({
    personalEnv: {
      ANTHROPIC_MODEL: 'personal-model',
      GLOBAL_PERSONAL: 'personal-value',
    },
  });
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'local',
      ANTHROPIC_MODEL: 'base-model',
    },
    users: emptyUserEnvDb,
    claudeEnv: resolver.service,
  });

  const runtime = await manager.prepareClaudeRuntime({
    userId: 4,
    cwd: '/workspace/project',
  });

  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].tenantId, null);
  assert.equal(runtime.executionEnv.ANTHROPIC_MODEL, 'personal-model');
  assert.equal(runtime.executionEnv.GLOBAL_PERSONAL, 'personal-value');
  assert.equal(runtime.executionEnv.W3_NAME, 'user-4');
});

test('DAS falls back to the server environment like other Claude variables', () => {
  const env = {
    DAS: 'env-das',
    ANTHROPIC_MODEL: 'env-model',
  };

  assert.equal(buildWrapperHostEnv(env).DAS, 'env-das');
  assert.deepEqual(buildClaudeWrapperDefaultEnv(env), {
    ANTHROPIC_MODEL: 'env-model',
    DAS: 'env-das',
  });
});

test('user DAS overrides the server environment', () => {
  const env = { DAS: 'env-das' };
  const userEnv = { DAS: 'user-das' };

  assert.equal(buildWrapperHostEnv(env, userEnv).DAS, 'user-das');
  assert.equal(buildClaudeWrapperDefaultEnv(env, userEnv).DAS, 'user-das');
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

test('configured Docker Python installs use the shared pip cache', () => {
  const args = buildDockerPythonInstallArgs('cloudcli-claude-test', ['requests', 'httpx']);
  assert.deepEqual(args, [
    'exec',
    '-e',
    'HOME=/home/cloudcli',
    'cloudcli-claude-test',
    'python3',
    '-m',
    'pip',
    'install',
    '--user',
    '--break-system-packages',
    '--disable-pip-version-check',
    'requests',
    'httpx',
  ]);
  assert.equal(args.includes('--no-cache-dir'), false);
  assert.deepEqual(buildDockerPythonInstallArgs('cloudcli-claude-test', []), []);
});

test('shared Python path is stable per image and can be disabled', () => {
  const env = {
    CLOUDCLI_RUNTIME_ROOT: '/var/cloudcli/runtimes',
    CLOUDCLI_DOCKER_PYTHON_SHARED_ROOT: '/var/cloudcli/python',
  };
  const first = resolveDockerSharedPythonPath(env, 'cloudcli/python:3.12');
  const second = resolveDockerSharedPythonPath(env, 'cloudcli/python:3.12');
  const otherImage = resolveDockerSharedPythonPath(env, 'cloudcli/python:3.11');

  assert.equal(first, second);
  assert.ok(first.startsWith(path.join(path.resolve('/var/cloudcli/python'), 'image-')));
  assert.notEqual(first, otherImage);
  assert.equal(resolveDockerSharedPythonPath({
    ...env,
    CLOUDCLI_DOCKER_SHARED_PYTHON: 'false',
  }, 'cloudcli/python:3.12'), null);
  assert.throws(
    () => resolveDockerSharedPythonPath({ CLOUDCLI_DOCKER_SHARED_PYTHON: 'sometimes' }),
    /CLOUDCLI_DOCKER_SHARED_PYTHON must be a boolean/,
  );
});

test('Docker proxy env rewrites host loopback without changing remote proxies', () => {
  assert.deepEqual(rewriteDockerProxyEnv({
    HTTP_PROXY: 'http://127.0.0.1:7890',
    https_proxy: 'http://localhost:7891',
    HTTPS_PROXY: 'http://proxy.example:8443',
    NO_PROXY: 'localhost,127.0.0.1',
  }), {
    HTTP_PROXY: 'http://host.docker.internal:7890/',
    https_proxy: 'http://host.docker.internal:7891/',
    HTTPS_PROXY: 'http://proxy.example:8443',
    NO_PROXY: 'localhost,127.0.0.1',
  });
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
  assert.ok(joined.includes('--add-host host.docker.internal:host-gateway'));
  assert.equal(joined.includes('/.claude'), false);
  assert.equal(joined.includes('/var/run/docker.sock'), false);
});

test('docker run args map container-local data paths to Docker daemon bind sources', () => {
  const containerRoot = '/var/lib/cloudcli';
  const hostRoot = '/var/lib/docker/volumes/ccui-data/_data';
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rnested',
    image: 'cloudcli/test:claude',
    uid: 1000,
    gid: 1000,
    workspaceHostPath: `${containerRoot}/workspaces/default/user/project`,
    runtimeHomePath: `${containerRoot}/runtimes/claude/default/user/project/home`,
    sharedPythonHostPath: `${containerRoot}/runtimes/.shared/python/image-abc`,
    bindContainerRoot: containerRoot,
    bindHostRoot: hostRoot,
  });
  const joined = args.join(' ');

  assert.ok(joined.includes(`src=${hostRoot}/workspaces/default/user/project,dst=/workspace`));
  assert.ok(joined.includes(`src=${hostRoot}/runtimes/claude/default/user/project/home,dst=/home/cloudcli`));
  assert.ok(joined.includes(`src=${hostRoot}/runtimes/.shared/python/image-abc,dst=/opt/cloudcli/python`));
  assert.equal(joined.includes(`src=${containerRoot}/`), false);
});

test('Docker bind source mapping leaves paths outside the configured container root unchanged', () => {
  assert.equal(resolveDockerBindSourcePath('/external/workspace', {
    containerRoot: '/var/lib/cloudcli',
    hostRoot: '/var/lib/docker/volumes/ccui-data/_data',
  }), '/external/workspace');
  assert.equal(DOCKER_BIND_HOST_ROOT_ENV_NAME, 'CLOUDCLI_DOCKER_BIND_HOST_ROOT');
  assert.equal(DOCKER_BIND_CONTAINER_ROOT_ENV_NAME, 'CLOUDCLI_DOCKER_BIND_CONTAINER_ROOT');
});

test('shared Python inspection compares the Docker daemon bind source after root mapping', () => {
  const containerRoot = '/var/lib/cloudcli';
  const hostRoot = '/var/lib/docker/volumes/ccui-data/_data';
  const sharedPythonHostPath = `${containerRoot}/runtimes/.shared/python/image-abc`;
  assert.equal(inspectedContainerUsesSharedPython({
    mounts: [{
      Destination: '/opt/cloudcli/python',
      Source: `${hostRoot}/runtimes/.shared/python/image-abc`,
    }],
    env: [
      'PYTHONUSERBASE=/opt/cloudcli/python/user-base',
      'PIP_CACHE_DIR=/opt/cloudcli/python/pip-cache',
      'PIP_BREAK_SYSTEM_PACKAGES=1',
      'PIP_USER=1',
      'PATH=/opt/cloudcli/python/user-base/bin:/home/cloudcli/.local/bin:/home/agent/.local/bin:/usr/local/share/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ],
  }, sharedPythonHostPath, {
    containerRoot,
    hostRoot,
  }), true);
});

test('docker run args mount a shared Python user base and pip cache', () => {
  const args = buildDockerRunArgs({
    containerName: 'cloudcli-claude-t1-u2-w3-rabc',
    image: 'cloudcli/test:claude',
    uid: 501,
    gid: 20,
    workspaceHostPath: '/tmp/team-a/workspace',
    runtimeHomePath: '/tmp/runtime/home',
    sharedPythonHostPath: '/var/cloudcli/python/image-abc',
    containerEnv: {
      PYTHONUSERBASE: '/tmp/user-controlled',
      PIP_CACHE_DIR: '/tmp/user-cache',
      PIP_USER: '0',
      PIP_BREAK_SYSTEM_PACKAGES: '0',
      PIP_TARGET: '/tmp/user-target',
      PATH: '/tmp/user-bin',
      HTTP_PROXY: 'http://127.0.0.1:7890',
    },
  });
  const joined = args.join(' ');

  assert.ok(joined.includes('src=/var/cloudcli/python/image-abc,dst=/opt/cloudcli/python'));
  assert.ok(joined.includes('PYTHONUSERBASE=/opt/cloudcli/python/user-base'));
  assert.ok(joined.includes('PIP_CACHE_DIR=/opt/cloudcli/python/pip-cache'));
  assert.ok(joined.includes('PIP_BREAK_SYSTEM_PACKAGES=1'));
  assert.ok(joined.includes('PIP_USER=1'));
  assert.ok(joined.includes('UV_CACHE_DIR=/opt/cloudcli/python/uv-cache'));
  assert.ok(joined.includes('PIPX_HOME=/opt/cloudcli/python/pipx'));
  assert.ok(joined.includes('PATH=/opt/cloudcli/python/user-base/bin:/home/cloudcli/.local/bin:'));
  assert.ok(joined.includes('HTTP_PROXY=http://host.docker.internal:7890/'));
  assert.equal(joined.includes('/tmp/user-controlled'), false);
  assert.equal(joined.includes('/tmp/user-cache'), false);
  assert.equal(joined.includes('/tmp/user-target'), false);
  assert.equal(joined.includes('/tmp/user-bin'), false);
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
      codehub_email: 'developer@example.com',
      CODEHUB_EMAIL: 'developer@example.com',
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
  assert.ok(args.includes('codehub_email=developer@example.com'));
  assert.ok(args.includes('CODEHUB_EMAIL=developer@example.com'));
  assert.equal(args.includes('BAD-NAME=ignored'), false);
  assert.deepEqual(args.slice(-4), ['cloudcli-claude-test', 'claude', '--model', 'glm-5.1']);
});

test('docker exec args explicitly clear CodeHub email variables when git_email is empty', () => {
  const args = buildClaudeDockerExecArgs({
    containerName: 'cloudcli-claude-test',
    env: {
      codehub_email: '',
      CODEHUB_EMAIL: '',
    },
  });

  assert.ok(args.includes('codehub_email='));
  assert.ok(args.includes('CODEHUB_EMAIL='));
});

test('docker host process env contains only server-owned Docker client variables', () => {
  const hostEnv = buildDockerHostProcessEnv({
    PATH: 'C:\\server-bin',
    HOME: 'C:\\server-home',
    DOCKER_HOST: 'tcp://docker.example.test:2376',
    DOCKER_CONTEXT: 'production',
    DOCKER_CONFIG: 'C:\\server-docker-config',
    XDG_RUNTIME_DIR: '/run/user/1000',
    HTTP_PROXY: 'http://host-proxy.example.test:8080',
    NO_PROXY: 'docker.example.test',
    ANTHROPIC_API_KEY: 'server-claude-key',
    TENANT_API_KEY: 'tenant-key',
    LD_PRELOAD: '/tmp/guest.so',
    NODE_OPTIONS: '--require=/tmp/guest.js',
  });

  assert.deepEqual(hostEnv, {
    PATH: 'C:\\server-bin',
    HOME: 'C:\\server-home',
    DOCKER_HOST: 'tcp://docker.example.test:2376',
    DOCKER_CONTEXT: 'production',
    DOCKER_CONFIG: 'C:\\server-docker-config',
    XDG_RUNTIME_DIR: '/run/user/1000',
    HTTP_PROXY: 'http://host-proxy.example.test:8080',
    NO_PROXY: 'docker.example.test',
  });
});

test('Claude Docker env split keeps scoped values exec-only and filters arbitrary base env', () => {
  const resolvedEnv = {
    env: {
      ANTHROPIC_MODEL: 'base-model',
      HTTP_PROXY: 'http://proxy.example.test:8080',
      SERVER_INTERNAL_SECRET: 'do-not-forward',
      ADMIN_CUSTOM: 'legacy-admin',
      TENANT_ENCRYPTED_TOKEN: 'tenant-secret',
      PERSONAL_ENCRYPTED_TOKEN: 'personal-secret',
      W3_NAME: 'managed-user',
      PATH: '/untrusted/path',
      UNKNOWN_SOURCE: 'do-not-forward',
    },
    sources: {
      ANTHROPIC_MODEL: 'baseEnv',
      HTTP_PROXY: 'baseEnv',
      SERVER_INTERNAL_SECRET: 'baseEnv',
      ADMIN_CUSTOM: 'adminUserEnv',
      TENANT_ENCRYPTED_TOKEN: 'tenant',
      PERSONAL_ENCRYPTED_TOKEN: 'personal',
      W3_NAME: 'managed',
      PATH: 'managed',
      UNKNOWN_SOURCE: 'unexpected',
    },
  };

  assert.deepEqual(buildClaudeDockerGuestEnv(resolvedEnv), {
    ANTHROPIC_MODEL: 'base-model',
    HTTP_PROXY: 'http://proxy.example.test:8080',
    ADMIN_CUSTOM: 'legacy-admin',
    TENANT_ENCRYPTED_TOKEN: 'tenant-secret',
    PERSONAL_ENCRYPTED_TOKEN: 'personal-secret',
    W3_NAME: 'managed-user',
  });
  assert.deepEqual(buildClaudeDockerCreateEnv(resolvedEnv), {
    [CLAUDE_DOCKER_ENV_POLICY_ENV_NAME]: 'exec-only-v1',
    W3_NAME: 'managed-user',
  });
});

test('Claude Docker env policy migrates legacy containers that may retain revoked keys', () => {
  assert.equal(inspectedContainerUsesClaudeEnvPolicy({
    env: [
      'W3_NAME=managed-user',
      'ANTHROPIC_API_KEY=revoked-key',
    ],
  }), false);
  assert.equal(inspectedContainerUsesClaudeEnvPolicy({
    env: [
      `${CLAUDE_DOCKER_ENV_POLICY_ENV_NAME}=exec-only-v1`,
      'W3_NAME=managed-user',
    ],
  }), true);
  assert.equal(inspectedContainerUsesClaudeEnvPolicy({ running: true }), true);
});

test('custom docker spawn bypasses host wrapper execution', () => {
  const calls = [];
  const child = { stdin: {}, stdout: {}, killed: false, exitCode: null };
  const spawnClaudeCodeProcess = createClaudeDockerSpawn({
    containerName: 'cloudcli-claude-test',
    envAllowlist: ['ANTHROPIC_MODEL'],
    hostEnv: { PATH: 'C:\\bin', HOME: 'C:\\service-home' },
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

test('custom docker spawn keeps arbitrary guest env out of the Docker host process', () => {
  const calls = [];
  const child = { stdin: {}, stdout: {}, killed: false, exitCode: null };
  const spawnClaudeCodeProcess = createClaudeDockerSpawn({
    containerName: 'cloudcli-claude-test',
    envAllowlist: ['TENANT_API_KEY', 'USER_SETTING', 'DOCKER_HOST', 'LD_PRELOAD', 'NODE_OPTIONS'],
    hostEnv: {
      PATH: '/server/bin',
      HOME: '/home/cloudcli-server',
      DOCKER_HOST: 'tcp://server-docker.example.test:2376',
      DOCKER_CONFIG: '/etc/cloudcli/docker',
      HTTP_PROXY: 'http://server-proxy.example.test:8080',
      SERVER_INTERNAL_SECRET: 'do-not-copy',
    },
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    },
  });

  const result = spawnClaudeCodeProcess({
    args: ['--model', 'sonnet'],
    env: {
      TENANT_API_KEY: 'tenant-key',
      USER_SETTING: 'user-value',
      DOCKER_HOST: 'tcp://guest-controlled.example.test:2375',
      LD_PRELOAD: '/workspace/guest.so',
      NODE_OPTIONS: '--require=/workspace/guest.js',
    },
  });

  assert.equal(result, child);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].includes('TENANT_API_KEY=tenant-key'));
  assert.ok(calls[0][1].includes('USER_SETTING=user-value'));
  assert.ok(calls[0][1].includes('DOCKER_HOST=tcp://guest-controlled.example.test:2375'));
  assert.ok(calls[0][1].includes('LD_PRELOAD=/workspace/guest.so'));
  assert.ok(calls[0][1].includes('NODE_OPTIONS=--require=/workspace/guest.js'));
  assert.deepEqual(calls[0][2].env, {
    PATH: '/server/bin',
    HOME: '/home/cloudcli-server',
    DOCKER_HOST: 'tcp://server-docker.example.test:2376',
    DOCKER_CONFIG: '/etc/cloudcli/docker',
    HTTP_PROXY: 'http://server-proxy.example.test:8080',
  });
  assert.equal(Object.hasOwn(calls[0][2].env, 'TENANT_API_KEY'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'USER_SETTING'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'LD_PRELOAD'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(calls[0][2].env, 'SERVER_INTERNAL_SECRET'), false);
});

test('docker runtime directory and home are owned by the sandbox user when possible', async () => {
  const calls = [];
  const fsMock = {
    mkdir: async (targetPath, options) => calls.push(['mkdir', targetPath, options]),
    chown: async (targetPath, uid, gid) => calls.push(['chown', targetPath, uid, gid]),
    chmod: async (targetPath, mode) => calls.push(['chmod', targetPath, mode]),
  };

  await ensureRuntimeHomeWritable(fsMock, '/tmp/runtime/home', { uid: 1000, gid: 1000 });

  assert.deepEqual(calls, [
    ['mkdir', '/tmp/runtime/home', { recursive: true }],
    ['chown', '/tmp/runtime', 1000, 1000],
    ['chmod', '/tmp/runtime', 0o700],
    ['chown', '/tmp/runtime/home', 1000, 1000],
    ['chmod', '/tmp/runtime/home', 0o700],
  ]);
});

test('docker runtime directory and home fall back to writable permissions when chown fails', async () => {
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
    ['chmod', '/tmp/runtime', 0o777],
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

test('claude runtime settings permissions are corrected even when content is not rewritten', async () => {
  const calls = [];
  const logs = [];
  const claudeDir = path.join('/tmp/runtime/home', '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const fsMock = {
    lstat: async (targetPath) => ({
      uid: 0,
      gid: 0,
      mode: targetPath === claudeDir ? 0o755 : 0o644,
      isSymbolicLink: () => false,
      isDirectory: () => targetPath === claudeDir,
      isFile: () => targetPath === settingsPath,
    }),
    readFile: async () => JSON.stringify({ cleanupPeriodDays: 36500 }),
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
    chown: async (...args) => calls.push(['chown', ...args]),
    chmod: async (...args) => calls.push(['chmod', ...args]),
  };

  assert.equal(await ensureClaudeCleanupPeriod(fsMock, '/tmp/runtime/home', {
    uid: 1000,
    gid: 1000,
    logger: {
      log: (...args) => logs.push(args),
    },
    context: {
      runtimeId: 'runtime-1',
    },
  }), false);
  assert.equal(calls.some(([operation]) => operation === 'writeFile'), false);
  assert.deepEqual(calls.filter(([operation]) => operation === 'chown'), [
    ['chown', claudeDir, 1000, 1000],
    ['chown', settingsPath, 1000, 1000],
  ]);
  assert.deepEqual(calls.filter(([operation]) => operation === 'chmod'), [
    ['chmod', claudeDir, 0o700],
    ['chmod', settingsPath, 0o600],
  ]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[agent-session-runtime]');
  assert.deepEqual(JSON.parse(logs[0][1]), {
    event: 'runtime_settings_permissions_updated',
    runtimeId: 'runtime-1',
    targetUser: '1000:1000',
    ownershipEntries: 2,
    modeEntries: 2,
    settingsUpdated: false,
  });
});

test('new claude runtime settings use secure mode and target container ownership', async () => {
  const calls = [];
  const claudeDir = path.join('/tmp/runtime/home', '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settingsCreated = false;
  const fsMock = {
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    lstat: async (targetPath) => {
      if (targetPath === settingsPath && !settingsCreated) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return {
        uid: 0,
        gid: 0,
        mode: targetPath === claudeDir ? 0o755 : 0o600,
        isSymbolicLink: () => false,
        isDirectory: () => targetPath === claudeDir,
        isFile: () => targetPath === settingsPath,
      };
    },
    writeFile: async (...args) => {
      settingsCreated = true;
      calls.push(['writeFile', ...args]);
    },
    chown: async (...args) => calls.push(['chown', ...args]),
    chmod: async (...args) => calls.push(['chmod', ...args]),
  };

  assert.equal(await ensureClaudeCleanupPeriod(fsMock, '/tmp/runtime/home', {
    uid: 1000,
    gid: 1000,
  }), true);
  const writeCall = calls.find(([operation]) => operation === 'writeFile');
  assert.equal(writeCall[1], settingsPath);
  assert.deepEqual(writeCall[3], {
    encoding: 'utf8',
    mode: 0o600,
  });
  assert.deepEqual(calls.filter(([operation]) => operation === 'chown'), [
    ['chown', claudeDir, 1000, 1000],
    ['chown', settingsPath, 1000, 1000],
  ]);
  assert.deepEqual(calls.filter(([operation]) => operation === 'chmod'), [
    ['chmod', claudeDir, 0o700],
  ]);
});

test('claude runtime settings permission handling is idempotent', async () => {
  const calls = [];
  const logs = [];
  const claudeDir = path.join('/tmp/runtime/home', '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const fsMock = {
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    lstat: async (targetPath) => ({
      uid: 1000,
      gid: 1000,
      mode: targetPath === claudeDir ? 0o700 : 0o600,
      isSymbolicLink: () => false,
      isDirectory: () => targetPath === claudeDir,
      isFile: () => targetPath === settingsPath,
    }),
    readFile: async () => JSON.stringify({ cleanupPeriodDays: 36500 }),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
    chown: async (...args) => calls.push(['chown', ...args]),
    chmod: async (...args) => calls.push(['chmod', ...args]),
  };

  assert.equal(await ensureClaudeCleanupPeriod(fsMock, '/tmp/runtime/home', {
    uid: 1000,
    gid: 1000,
    logger: {
      log: (...args) => logs.push(args),
    },
  }), false);
  assert.equal(calls.some(([operation]) => (
    operation === 'writeFile'
    || operation === 'chown'
    || operation === 'chmod'
  )), false);
  assert.deepEqual(logs, []);
});

test('claude runtime settings reject a symbolic-link settings file before reading it', async () => {
  const calls = [];
  const claudeDir = path.join('/tmp/runtime/home', '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const fsMock = {
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    lstat: async (targetPath) => ({
      uid: 1000,
      gid: 1000,
      mode: targetPath === claudeDir ? 0o700 : 0o600,
      isSymbolicLink: () => targetPath === settingsPath,
      isDirectory: () => targetPath === claudeDir,
      isFile: () => false,
    }),
    readFile: async (...args) => calls.push(['readFile', ...args]),
    writeFile: async (...args) => calls.push(['writeFile', ...args]),
    chown: async (...args) => calls.push(['chown', ...args]),
    chmod: async (...args) => calls.push(['chmod', ...args]),
  };

  await assert.rejects(
    ensureClaudeCleanupPeriod(fsMock, '/tmp/runtime/home', {
      uid: 1000,
      gid: 1000,
    }),
    /must not be a symbolic link/,
  );
  assert.equal(calls.some(([operation]) => (
    operation === 'readFile'
    || operation === 'writeFile'
    || operation === 'chown'
    || operation === 'chmod'
  )), false);
});

test('docker mode creates runtime home, wrapper, DB row, and container', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeRoot = path.join(tempRoot, 'runtimes');
  const sharedPythonRoot = path.join(tempRoot, 'shared-python');
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
      CLOUDCLI_DOCKER_PYTHON_SHARED_ROOT: sharedPythonRoot,
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
          codehub_email: 'attempted-lowercase-override@example.com',
          CODEHUB_EMAIL: 'attempted-uppercase-override@example.com',
          'BAD-NAME': 'do-not-forward',
        };
      },
      getGitConfig: () => ({
        git_email: 'alice@example.com',
      }),
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
  assert.ok(dockerCalls[0].join(' ').includes(`src=${path.join(sharedPythonRoot, 'image-')}`));
  assert.ok(dockerCalls[0].join(' ').includes('dst=/opt/cloudcli/python'));
  assert.ok(dockerCalls[0].join(' ').includes('PYTHONUSERBASE=/opt/cloudcli/python/user-base'));
  assert.equal((await fs.stat(sharedPythonRoot)).isDirectory(), true);
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
  assert.equal(runtime.executionEnv.codehub_email, 'alice@example.com');
  assert.equal(runtime.executionEnv.CODEHUB_EMAIL, 'alice@example.com');
  assert.equal(runtime.executionEnv.TENANT_ID, '3');
  assert.equal(runtime.executionEnv.WORKSPACE_ID, '5');
  assert.equal(runtime.executionEnv.HTTP_PROXY, 'http://proxy.example:8080');
  assert.equal(runtime.executionEnv.HTTPS_PROXY, 'http://secure-proxy.example:8443');
  assert.equal(runtime.executionEnv.http_proxy, 'http://lower-proxy.example:8080');
  assert.equal(runtime.executionEnv.https_proxy, 'http://lower-secure-proxy.example:8443');
  assert.equal(runtime.executionEnv.MCP_DATA_SOURCE_KEY, 'host-mcp-data-source-key');
  assert.equal(Object.hasOwn(runtime.executionEnv, 'BAD-NAME'), false);
  assert.ok(dockerCalls[0].join(' ').includes(`${CLAUDE_DOCKER_ENV_POLICY_ENV_NAME}=exec-only-v1`));
  assert.equal(dockerCalls[0].join(' ').includes(`USER_KEY=${encryptedUserKey}`), false);
  assert.ok(dockerCalls[0].join(' ').includes('W3_NAME=alice'));
  assert.equal(dockerCalls[0].join(' ').includes('codehub_email=alice@example.com'), false);
  assert.equal(dockerCalls[0].join(' ').includes('CODEHUB_EMAIL=alice@example.com'), false);
  assert.equal(dockerCalls[0].join(' ').includes('TENANT_ID=3'), false);
  assert.equal(dockerCalls[0].join(' ').includes('WORKSPACE_ID=5'), false);
  assert.equal(dockerCalls[0].join(' ').includes('MCP_DATA_SOURCE_KEY=host-mcp-data-source-key'), false);
  assert.equal(dockerCalls[0].join(' ').includes('HTTP_PROXY=http://proxy.example:8080'), false);
  assert.equal(dockerCalls[0].join(' ').includes('HTTPS_PROXY=http://secure-proxy.example:8443'), false);
  assert.equal(dockerCalls[0].join(' ').includes('ANTHROPIC_API_KEY=key-1'), false);
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
  assert.match(wrapper, /-e codehub_email/);
  assert.match(wrapper, /-e CODEHUB_EMAIL/);
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
  let preparedRuntime;
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
    preparedRuntime = await manager.prepareClaudeRuntime({
      tenantId: 3,
      userId: 4,
      workspaceId: 5,
      cwd: workspacePath,
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(events, ['run:1000:1000', 'verify']);
  assert.equal(preparedRuntime.runtimeUid, 1000);
  assert.equal(preparedRuntime.runtimeGid, 1000);
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === workspaceRealPath));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === path.join(workspaceRealPath, 'root-owned.txt')));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === runtimeRow.runtime_home_path));
  assert.ok(ownershipChanges.some((entry) => entry.targetPath === path.dirname(runtimeRow.runtime_home_path)));
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

test('docker mode recreates an existing runtime container when the configured image changes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-image-change-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);

  let runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:old',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'idle',
  };
  let containerExists = true;
  let containerRunning = false;
  let containerImage = runtimeRow.image;
  let created = false;
  const events = [];
  const dockerRuns = [];
  const imageUpdates = [];
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:new',
    },
    multitenancy: {
      runtimes: {
        createRuntime: () => {
          created = true;
        },
        findByProviderSession: () => runtimeRow,
        updateImage: (input) => {
          events.push(`persist:${input.image}`);
          imageUpdates.push(input);
          runtimeRow = { ...runtimeRow, image: input.image };
          return runtimeRow;
        },
        updateStatus: (input) => {
          events.push(`mark:${input.status}`);
          runtimeRow = { ...runtimeRow, status: input.status };
          return runtimeRow;
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => {
        events.push('inspect');
        return containerExists
          ? { exists: true, running: containerRunning, image: containerImage }
          : null;
      },
      startContainer: async () => {
        throw new Error('must not start a container created from the old image');
      },
      removeContainer: async (name) => {
        events.push(`remove:${name}`);
        containerExists = false;
        containerRunning = false;
      },
      runDetached: async (args) => {
        dockerRuns.push(args);
        containerImage = args.at(-3);
        containerExists = true;
        containerRunning = true;
        events.push(`run:${containerImage}`);
      },
      verifyWorkspaceCwd: async () => {
        events.push('verify');
      },
    },
  });

  const first = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });
  const second = await manager.prepareClaudeRuntime({
    tenantId: 3,
    userId: 4,
    workspaceId: 5,
    cwd: workspacePath,
    sessionId: 'claude-session-1',
  });

  assert.equal(created, false);
  assert.deepEqual(imageUpdates, [{ runtimeId: 'existing', image: 'cloudcli/test:new' }]);
  assert.equal(dockerRuns.length, 1);
  assert.equal(dockerRuns[0].at(-3), 'cloudcli/test:new');
  assert.equal(dockerRuns[0].includes('cloudcli/test:old'), false);
  assert.equal(first.runtimeId, 'existing');
  assert.equal(first.runtimeHomePath, runtimeHomePath);
  assert.equal(second.runtimeId, 'existing');
  assert.deepEqual(events, [
    'inspect',
    'remove:cloudcli-claude-existing',
    'run:cloudcli/test:new',
    'verify',
    'persist:cloudcli/test:new',
    'mark:active',
    'inspect',
    'verify',
    'mark:active',
  ]);
});

test('docker mode persists a configured image already applied to the container without rebuilding it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-image-persist-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:old',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'idle',
  };
  const imageUpdates = [];
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:new',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => runtimeRow,
        updateImage: (input) => {
          imageUpdates.push(input);
          return { ...runtimeRow, image: input.image };
        },
        updateStatus: (input) => ({ ...runtimeRow, image: 'cloudcli/test:new', status: input.status }),
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => ({
        exists: true,
        running: true,
        image: 'cloudcli/test:new',
      }),
      verifyWorkspaceCwd: async () => undefined,
      removeContainer: async () => {
        throw new Error('must not remove a container that already uses the configured image');
      },
      runDetached: async () => {
        throw new Error('must not recreate a container that already uses the configured image');
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

  assert.equal(runtime.runtimeId, 'existing');
  assert.deepEqual(imageUpdates, [{ runtimeId: 'existing', image: 'cloudcli/test:new' }]);
});

test('docker mode does not persist a configured image when the recreated container fails verification', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-runtime-image-failure-test-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  const runtimeHomePath = path.join(tempRoot, 'runtime-home');
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(runtimeHomePath, { recursive: true });
  const workspaceRealPath = await fs.realpath(workspacePath);
  const runtimeRow = {
    runtime_id: 'existing',
    tenant_id: 3,
    workspace_id: 5,
    user_id: 4,
    provider: 'claude',
    provider_session_id: 'claude-session-1',
    container_name: 'cloudcli-claude-existing',
    image: 'cloudcli/test:old',
    workspace_host_path: workspaceRealPath,
    runtime_home_path: runtimeHomePath,
    status: 'idle',
  };
  let imageUpdated = false;
  let statusUpdated = false;
  const manager = createAgentSessionRuntimeManager({
    env: {
      CLAUDE_EXECUTION_MODE: 'docker',
      CLOUDCLI_RUNTIME_ROOT: path.join(tempRoot, 'runtimes'),
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:new',
    },
    multitenancy: {
      runtimes: {
        findByProviderSession: () => runtimeRow,
        updateImage: () => {
          imageUpdated = true;
          return { ...runtimeRow, image: 'cloudcli/test:new' };
        },
        updateStatus: () => {
          statusUpdated = true;
          return runtimeRow;
        },
      },
    },
    users: emptyUserEnvDb,
    docker: {
      inspectContainer: async () => ({
        exists: true,
        running: false,
        image: 'cloudcli/test:old',
      }),
      removeContainer: async () => undefined,
      runDetached: async () => undefined,
      verifyWorkspaceCwd: async () => {
        throw new Error('new image workspace is unavailable');
      },
    },
  });

  await assert.rejects(
    manager.prepareClaudeRuntime({
      tenantId: 3,
      userId: 4,
      workspaceId: 5,
      cwd: workspacePath,
      sessionId: 'claude-session-1',
    }),
    /new image workspace is unavailable/,
  );

  assert.equal(imageUpdated, false);
  assert.equal(statusUpdated, false);
  assert.equal(runtimeRow.image, 'cloudcli/test:old');
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
      CLOUDCLI_CLAUDE_DOCKER_IMAGE: 'cloudcli/test:claude',
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
