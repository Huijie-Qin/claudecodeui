import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { multitenancyDb } from '../database/multitenancy-db.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CLAUDE_DOCKER_IMAGE = 'docker.io/cloudcliai/sandbox:claude-code';
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), '.cloudcli', 'runtimes');
const DEFAULT_DOCKER_MEMORY = '2g';
const DEFAULT_DOCKER_CPUS = '2';
const CLAUDE_CONTAINER_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
];
const WRAPPER_HOST_ENV_ALLOWLIST = [
  ...CLAUDE_CONTAINER_ENV_ALLOWLIST,
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'XDG_RUNTIME_DIR',
];

function requireValue(value, name) {
  if (value == null || String(value).trim() === '') {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function expandHome(inputPath) {
  const value = requireValue(inputPath, 'path');
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function sanitizeSegment(value, fallback = 'x') {
  const sanitized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 1000;
}

function currentGid() {
  return typeof process.getgid === 'function' ? process.getgid() : 1000;
}

function buildRuntimeId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

export function resolveClaudeExecutionMode(env = process.env) {
  const mode = String(env.CLAUDE_EXECUTION_MODE || 'local').trim().toLowerCase();
  if (mode === 'local' || mode === 'docker') {
    return mode;
  }
  throw new Error('CLAUDE_EXECUTION_MODE must be local or docker');
}

export function buildRuntimePaths({
  runtimeRoot,
  provider,
  tenantId,
  userId,
  workspaceId,
  runtimeId,
}) {
  const resolvedRoot = path.resolve(expandHome(runtimeRoot || DEFAULT_RUNTIME_ROOT));
  const providerSegment = sanitizeSegment(requireValue(provider, 'provider'));
  const runtimeSegment = sanitizeSegment(requireValue(runtimeId, 'runtimeId'));
  const runtimeDir = path.resolve(
    resolvedRoot,
    providerSegment,
    `tenant-${requirePositiveInteger(tenantId, 'tenantId')}`,
    `user-${requirePositiveInteger(userId, 'userId')}`,
    `workspace-${requirePositiveInteger(workspaceId, 'workspaceId')}`,
    `runtime-${runtimeSegment}`,
  );

  if (runtimeDir !== resolvedRoot && !runtimeDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('runtime path must stay under CLOUDCLI_RUNTIME_ROOT');
  }

  return {
    runtimeDir,
    runtimeHomePath: path.join(runtimeDir, 'home'),
    wrapperDir: path.join(runtimeDir, 'wrapper'),
  };
}

export function buildContainerName({
  provider,
  tenantId,
  userId,
  workspaceId,
  runtimeId,
}) {
  const providerSegment = sanitizeSegment(provider);
  const runtimeSegment = sanitizeSegment(runtimeId);
  const runtimeHash = crypto.createHash('sha1').update(String(runtimeId)).digest('hex').slice(0, 10);
  const prefix = `cloudcli-${providerSegment}-t${requirePositiveInteger(tenantId, 'tenantId')}-u${requirePositiveInteger(userId, 'userId')}-w${requirePositiveInteger(workspaceId, 'workspaceId')}-r`;
  const maxRuntimeLength = Math.max(8, 120 - prefix.length - runtimeHash.length - 1);
  return `${prefix}${runtimeSegment.slice(0, maxRuntimeLength)}-${runtimeHash}`.slice(0, 120);
}

export function buildDockerRunArgs({
  containerName,
  image,
  uid,
  gid,
  workspaceHostPath,
  runtimeHomePath,
  memory = DEFAULT_DOCKER_MEMORY,
  cpus = DEFAULT_DOCKER_CPUS,
}) {
  return [
    'run',
    '-d',
    '--name',
    requireValue(containerName, 'containerName'),
    '--user',
    `${requirePositiveInteger(uid, 'uid')}:${requirePositiveInteger(gid, 'gid')}`,
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    requireValue(memory, 'memory'),
    '--cpus',
    requireValue(cpus, 'cpus'),
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '--mount',
    `type=bind,src=${requireValue(workspaceHostPath, 'workspaceHostPath')},dst=/workspace`,
    '--mount',
    `type=bind,src=${requireValue(runtimeHomePath, 'runtimeHomePath')},dst=/home/cloudcli`,
    '-e',
    'HOME=/home/cloudcli',
    '-w',
    '/workspace',
    requireValue(image, 'image'),
    'sleep',
    'infinity',
  ];
}

export function buildClaudeDockerWrapperScript({
  containerName,
  envAllowlist = CLAUDE_CONTAINER_ENV_ALLOWLIST,
  executable = 'claude',
}) {
  const container = shellQuote(requireValue(containerName, 'containerName'));
  const binary = shellQuote(requireValue(executable, 'executable'));
  const envLines = envAllowlist.map((name) => {
    const envName = requireValue(name, 'envName');
    return `# allowlist: -e ${envName}\n[[ -n "\${${envName}+x}" ]] && DOCKER_ENV+=("-e" "${envName}=\${${envName}}")`;
  }).join('\n');

  return `#!/usr/bin/env bash
set -euo pipefail

DOCKER_ENV=()
${envLines}

exec docker exec -i \\
  -w /workspace \\
  -e HOME=/home/cloudcli \\
  \${DOCKER_ENV[@]+"\${DOCKER_ENV[@]}"} \\
  ${container} \\
  ${binary} "$@"
`;
}

function buildWrapperHostEnv(env = process.env) {
  const output = {};
  for (const name of WRAPPER_HOST_ENV_ALLOWLIST) {
    if (env[name] != null) {
      output[name] = String(env[name]);
    }
  }
  if (!output.PATH) output.PATH = process.env.PATH || '';
  if (!output.HOME) output.HOME = os.homedir();
  return output;
}

async function pathExists(fsImpl, targetPath) {
  try {
    await fsImpl.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function wrapperDirFromRuntimeHome(runtimeHomePath) {
  return path.join(path.dirname(runtimeHomePath), 'wrapper');
}

export class DockerCliClient {
  async inspectContainer(containerName) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '-f',
        '{{json .State}}',
        containerName,
      ]);
      const state = JSON.parse(stdout.trim());
      return {
        exists: true,
        running: state.Running === true,
        state,
        status: state.Status ?? null,
        exitCode: state.ExitCode ?? null,
        startedAt: state.StartedAt ?? null,
        finishedAt: state.FinishedAt ?? null,
      };
    } catch (error) {
      if (error?.code === 1 || error?.stderr?.includes('No such object')) {
        return null;
      }
      throw error;
    }
  }

  async startContainer(containerName) {
    await execFileAsync('docker', ['start', containerName]);
  }

  async stopContainer(containerName) {
    await execFileAsync('docker', ['stop', '-t', '1', containerName]);
  }

  async statsContainers(containerNames) {
    const names = Array.isArray(containerNames)
      ? containerNames.filter(Boolean)
      : [];
    if (names.length === 0) return new Map();

    const { stdout } = await execFileAsync('docker', [
      'stats',
      '--no-stream',
      '--format',
      'json',
      ...names,
    ]);
    const stats = new Map();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed);
      if (row.Name) {
        stats.set(row.Name, row);
      }
    }
    return stats;
  }

  async runDetached(args) {
    await execFileAsync('docker', args);
  }
}

export function createAgentSessionRuntimeManager({
  env = process.env,
  multitenancy = multitenancyDb,
  docker = new DockerCliClient(),
  fs = fsPromises,
} = {}) {
  const runtimeLocks = new Map();

  async function withRuntimeLock(runtimeId, task) {
    const previous = runtimeLocks.get(runtimeId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => {}).then(() => gate);
    runtimeLocks.set(runtimeId, current);

    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (runtimeLocks.get(runtimeId) === current) {
        runtimeLocks.delete(runtimeId);
      }
    }
  }

  function normalizeExpiredIdleStopArgs({ runtimeId, olderThanMinutes } = {}) {
    try {
      return {
        runtimeId: requireValue(runtimeId, 'runtimeId'),
        olderThanMinutes: requirePositiveInteger(Number(olderThanMinutes), 'olderThanMinutes'),
      };
    } catch {
      return null;
    }
  }

  async function resolveWorkspaceHostPath(workspacePath) {
    const resolved = await fs.realpath(requireValue(workspacePath, 'cwd'));
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error('workspace path must be a directory');
    }
    return resolved;
  }

  async function ensureContainer(runtime) {
    const inspected = await docker.inspectContainer(runtime.container_name);
    if (inspected?.running) {
      return;
    }
    if (inspected?.exists) {
      await docker.startContainer(runtime.container_name);
      return;
    }

    const args = buildDockerRunArgs({
      containerName: runtime.container_name,
      image: runtime.image,
      uid: Number.parseInt(env.CLOUDCLI_DOCKER_UID || String(currentUid()), 10),
      gid: Number.parseInt(env.CLOUDCLI_DOCKER_GID || String(currentGid()), 10),
      workspaceHostPath: runtime.workspace_host_path,
      runtimeHomePath: runtime.runtime_home_path,
      memory: env.CLOUDCLI_DOCKER_MEMORY || DEFAULT_DOCKER_MEMORY,
      cpus: env.CLOUDCLI_DOCKER_CPUS || DEFAULT_DOCKER_CPUS,
    });
    await docker.runDetached(args);
  }

  async function writeWrapper({ runtime, wrapperDir }) {
    await fs.mkdir(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, 'claude-docker-wrapper');
    await fs.writeFile(
      wrapperPath,
      buildClaudeDockerWrapperScript({ containerName: runtime.container_name }),
      { mode: 0o700 },
    );
    await fs.chmod(wrapperPath, 0o700);
    return wrapperPath;
  }

  async function createNewRuntime({ tenantId, userId, workspaceId, workspaceHostPath }) {
    const runtimeId = buildRuntimeId();
    const runtimePaths = buildRuntimePaths({
      runtimeRoot: env.CLOUDCLI_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
      provider: 'claude',
      tenantId,
      userId,
      workspaceId,
      runtimeId,
    });
    const containerName = buildContainerName({
      provider: 'claude',
      tenantId,
      userId,
      workspaceId,
      runtimeId,
    });

    await fs.mkdir(runtimePaths.runtimeHomePath, { recursive: true });

    const runtime = multitenancy.runtimes.createRuntime({
      runtimeId,
      tenantId,
      userId,
      workspaceId,
      provider: 'claude',
      containerName,
      image: env.CLOUDCLI_CLAUDE_DOCKER_IMAGE || DEFAULT_CLAUDE_DOCKER_IMAGE,
      workspaceHostPath,
      runtimeHomePath: runtimePaths.runtimeHomePath,
      status: 'pending',
    });

    return {
      runtime,
      wrapperDir: runtimePaths.wrapperDir,
    };
  }

  async function resolveExistingRuntime({ tenantId, userId, workspaceId, sessionId }) {
    const runtime = multitenancy.runtimes.findByProviderSession({
      tenantId,
      userId,
      workspaceId,
      provider: 'claude',
      providerSessionId: sessionId,
    });

    if (!runtime) {
      throw new Error('Claude Docker runtime not found for this session');
    }
    if (!(await pathExists(fs, runtime.runtime_home_path))) {
      throw new Error('Claude Docker runtime home is missing for this session');
    }

    return {
      runtime,
      wrapperDir: wrapperDirFromRuntimeHome(runtime.runtime_home_path),
    };
  }

  async function activateRuntimeContext({ runtimeContext, workspaceHostPath }) {
    await fs.mkdir(runtimeContext.runtime.runtime_home_path, { recursive: true });
    await ensureContainer(runtimeContext.runtime);
    const wrapperPath = await writeWrapper(runtimeContext);
    const runtime = multitenancy.runtimes.updateStatus({
      runtimeId: runtimeContext.runtime.runtime_id,
      status: 'active',
    }) || runtimeContext.runtime;

    return {
      mode: 'docker',
      runtimeId: runtime.runtime_id,
      runtimeHomePath: runtime.runtime_home_path,
      containerName: runtime.container_name,
      cwd: workspaceHostPath,
      containerCwd: '/workspace',
      projectPath: '/workspace',
      hostWorkspacePath: workspaceHostPath,
      pathToClaudeCodeExecutable: wrapperPath,
      executionEnv: buildWrapperHostEnv(env),
      settingSources: ['project'],
      disableHostMcpConfig: true,
    };
  }

  return {
    async prepareClaudeRuntime(options = {}) {
      const mode = resolveClaudeExecutionMode(env);
      if (mode === 'local') {
        return {
          mode: 'local',
          cwd: options.cwd,
          projectPath: options.projectPath || options.cwd,
          hostWorkspacePath: options.cwd || options.projectPath,
          pathToClaudeCodeExecutable: env.CLAUDE_CLI_PATH || 'claude',
          settingSources: ['project', 'user', 'local'],
        };
      }

      const tenantId = requirePositiveInteger(options.tenantId, 'tenantId');
      const userId = requirePositiveInteger(options.userId, 'userId');
      const workspaceId = requirePositiveInteger(options.workspaceId, 'workspaceId');
      const workspaceHostPath = await resolveWorkspaceHostPath(options.cwd || options.projectPath);
      const runtimeContext = options.sessionId
        ? await resolveExistingRuntime({ tenantId, userId, workspaceId, sessionId: options.sessionId })
        : await createNewRuntime({ tenantId, userId, workspaceId, workspaceHostPath });

      if (options.sessionId) {
        return withRuntimeLock(runtimeContext.runtime.runtime_id, () => activateRuntimeContext({
          runtimeContext,
          workspaceHostPath,
        }));
      }

      return activateRuntimeContext({ runtimeContext, workspaceHostPath });
    },

    bindProviderSession({ runtimeId, providerSessionId }) {
      if (!runtimeId || !providerSessionId) return null;
      return multitenancy.runtimes.bindProviderSession({ runtimeId, providerSessionId });
    },

    markIdle(runtimeId) {
      if (!runtimeId) return null;
      return multitenancy.runtimes.updateStatus({ runtimeId, status: 'idle' });
    },

    markFailed(runtimeId) {
      if (!runtimeId) return null;
      return multitenancy.runtimes.updateStatus({ runtimeId, status: 'failed' });
    },

    async stopRuntime(runtimeId) {
      if (!runtimeId) return false;

      const runtime = multitenancy.runtimes.findByRuntimeId(runtimeId);
      if (!runtime) return false;

      return withRuntimeLock(runtime.runtime_id, async () => {
        const inspected = await docker.inspectContainer(runtime.container_name);
        if (inspected?.running) {
          await docker.stopContainer(runtime.container_name);
        }

        multitenancy.runtimes.updateStatus({ runtimeId, status: 'idle' });
        return true;
      });
    },

    async stopExpiredIdleRuntime(input = {}) {
      const normalized = normalizeExpiredIdleStopArgs(input);
      if (!normalized) return false;

      return withRuntimeLock(normalized.runtimeId, async () => {
        const runtime = multitenancy.runtimes.findExpiredIdleRuntimeById({
          runtimeId: normalized.runtimeId,
          olderThanMinutes: normalized.olderThanMinutes,
        });
        if (!runtime) return false;

        const inspected = await docker.inspectContainer(runtime.container_name);
        if (inspected?.running) {
          await docker.stopContainer(runtime.container_name);
        }

        multitenancy.runtimes.updateStatus({
          runtimeId: normalized.runtimeId,
          status: 'idle',
        });
        return true;
      });
    },
  };
}

export const agentSessionRuntimeManager = createAgentSessionRuntimeManager();
