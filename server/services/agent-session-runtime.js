import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { userDb as defaultUserDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { USER_KEY_ENV_NAME } from '../database/user-env.js';

import { codeHubService } from './codehub.js';
import { sanitizePathSegment } from './workspace-projects.js';

const execFileAsync = promisify(execFile);

const W3_NAME_ENV_NAME = 'W3_NAME';
const ANTHROPIC_BASE_URL_ENV_NAME = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_MODEL_ENV_NAME = 'ANTHROPIC_MODEL';
const DAS_ENV_NAME = 'DAS';
const CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_ENV_NAME = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const CLAUDE_USER_CONFIG_ENV_NAMES = [
  ANTHROPIC_BASE_URL_ENV_NAME,
  ANTHROPIC_MODEL_ENV_NAME,
  DAS_ENV_NAME,
];
const DEFAULT_CLAUDE_DOCKER_IMAGE = 'docker.io/cloudcliai/sandbox:claude-code';
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), '.cloudcli', 'runtimes');
const DEFAULT_DOCKER_MEMORY = '2g';
const DEFAULT_DOCKER_CPUS = '2';
const CLAUDE_CONTAINER_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL_ENV_NAME,
  ANTHROPIC_MODEL_ENV_NAME,
  DAS_ENV_NAME,
  CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_ENV_NAME,
  'ANTHROPIC_AUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  USER_KEY_ENV_NAME,
  W3_NAME_ENV_NAME,
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
const CONTAINER_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireValue(value, name) {
  if (value == null || String(value).trim() === '') {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
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

function resolveContainerUser(env = process.env) {
  const defaultUid = currentUid();
  const defaultGid = currentGid();
  return {
    uid: Number.parseInt(env.CLOUDCLI_DOCKER_UID || String(defaultUid > 0 ? defaultUid : 1000), 10),
    gid: Number.parseInt(env.CLOUDCLI_DOCKER_GID || String(defaultGid > 0 ? defaultGid : 1000), 10),
  };
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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
  tenantCode,
  username,
  workspaceSlug,
  tenantId,
  userId,
  workspaceId,
}) {
  const resolvedRoot = path.resolve(expandHome(runtimeRoot || DEFAULT_RUNTIME_ROOT));
  const providerSegment = sanitizeSegment(requireValue(provider, 'provider'));
  const runtimeDir = path.resolve(
    resolvedRoot,
    providerSegment,
    sanitizePathSegment(tenantCode, `tenant-${requirePositiveInteger(tenantId, 'tenantId')}`),
    sanitizePathSegment(username, `user-${requirePositiveInteger(userId, 'userId')}`),
    sanitizePathSegment(workspaceSlug, `workspace-${requirePositiveInteger(workspaceId, 'workspaceId')}`),
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

function buildRuntimeScopeLockKey({
  provider,
  tenantId,
  userId,
  workspaceId,
}) {
  return [
    'scope',
    sanitizeSegment(provider),
    `t${requirePositiveInteger(tenantId, 'tenantId')}`,
    `u${requirePositiveInteger(userId, 'userId')}`,
    `w${requirePositiveInteger(workspaceId, 'workspaceId')}`,
  ].join(':');
}

export function buildDockerRunArgs({
  containerName,
  image,
  uid,
  gid,
  workspaceHostPath,
  runtimeHomePath,
  containerEnv = {},
  memory = DEFAULT_DOCKER_MEMORY,
  cpus = DEFAULT_DOCKER_CPUS,
}) {
  const containerEnvArgs = Object.entries(normalizeContainerEnvRecord(containerEnv))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);

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
    ...containerEnvArgs,
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
  defaultEnv = {},
}) {
  const container = shellQuote(requireValue(containerName, 'containerName'));
  const binary = shellQuote(requireValue(executable, 'executable'));
  const envAllowlistSet = new Set(envAllowlist);
  const defaultEnvNameSet = new Set(CLAUDE_USER_CONFIG_ENV_NAMES);
  const defaultEnvLines = Object.entries(normalizeContainerEnvRecord(defaultEnv))
    .filter(([name]) => defaultEnvNameSet.has(name) && envAllowlistSet.has(name))
    .map(([name, value]) => `[[ -z "\${${name}+x}" ]] && ${name}=${shellQuote(value)}`)
    .join('\n');
  const defaultEnvBlock = defaultEnvLines
    ? `# Claude environment defaults written from user env or .env.\n${defaultEnvLines}\n\n`
    : '';
  const envLines = envAllowlist.map((name) => {
    const envName = requireValue(name, 'envName');
    return `# allowlist: -e ${envName}\n[[ -n "\${${envName}+x}" ]] && DOCKER_ENV+=("-e" "${envName}=\${${envName}}")`;
  }).join('\n');

  return `#!/usr/bin/env bash
set -euo pipefail

${defaultEnvBlock}DOCKER_ENV=()
${envLines}

exec docker exec -i \\
  -w /workspace \\
  -e HOME=/home/cloudcli \\
  \${DOCKER_ENV[@]+"\${DOCKER_ENV[@]}"} \\
  ${container} \\
  ${binary} "$@"
`;
}

export async function ensureRuntimeHomeWritable(fsImpl, runtimeHomePath, { uid, gid } = {}) {
  await fsImpl.mkdir(runtimeHomePath, { recursive: true });

  let chownSucceeded = false;
  if (
    typeof fsImpl.chown === 'function'
    && isNonNegativeInteger(uid)
    && isNonNegativeInteger(gid)
  ) {
    try {
      await fsImpl.chown(runtimeHomePath, uid, gid);
      chownSucceeded = true;
    } catch {
      // Some deployments run without permission to chown bind mounts. In that
      // case, fall back to a writable runtime home so the sandbox user can
      // create Claude config files.
    }
  }

  if (typeof fsImpl.chmod === 'function') {
    await fsImpl.chmod(runtimeHomePath, chownSucceeded ? 0o700 : 0o777);
  }
}

function normalizeContainerEnvRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => CONTAINER_ENV_NAME_PATTERN.test(String(key)) && entry != null)
      .map(([key, entry]) => [String(key), String(entry)]),
  );
}

function buildWrapperHostEnv(env = process.env, containerEnv = {}) {
  const output = {};
  for (const name of WRAPPER_HOST_ENV_ALLOWLIST) {
    if (name === DAS_ENV_NAME) {
      continue;
    }
    if (env[name] != null) {
      output[name] = String(env[name]);
    }
  }
  Object.assign(output, normalizeContainerEnvRecord(containerEnv));
  if (!output.PATH) output.PATH = process.env.PATH || '';
  if (!output.HOME) output.HOME = os.homedir();
  return output;
}

function buildContainerEnvAllowlist(containerEnv = {}) {
  return Array.from(new Set([
    ...CLAUDE_CONTAINER_ENV_ALLOWLIST,
    ...Object.keys(normalizeContainerEnvRecord(containerEnv)),
  ]));
}

function readEnvValue(record, name) {
  const value = record?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function buildClaudeWrapperDefaultEnv(env = process.env, containerEnv = {}) {
  const defaults = {};
  const normalizedContainerEnv = normalizeContainerEnvRecord(containerEnv);
  for (const name of CLAUDE_USER_CONFIG_ENV_NAMES) {
    const value = readEnvValue(normalizedContainerEnv, name)
      || (name === DAS_ENV_NAME ? null : readEnvValue(env, name));
    if (value) {
      defaults[name] = value;
    }
  }
  return defaults;
}

function readUsernameForEnv(users, userId) {
  if (typeof users?.getUserById !== 'function') {
    return null;
  }

  const user = users.getUserById(userId);
  const username = user?.username;
  return typeof username === 'string' && username.trim() !== '' ? username.trim() : null;
}

function readUserContainerEnv(users, userId) {
  const username = readUsernameForEnv(users, userId);
  if (!username) {
    throw new Error('username is required for W3_NAME');
  }

  const output = {
    [W3_NAME_ENV_NAME]: username,
  };
  if (typeof users?.getEnvForUser !== 'function') {
    return output;
  }
  const env = normalizeContainerEnvRecord(users.getEnvForUser(userId));
  if (env[USER_KEY_ENV_NAME]) {
    output[USER_KEY_ENV_NAME] = env[USER_KEY_ENV_NAME];
  }
  for (const name of CLAUDE_USER_CONFIG_ENV_NAMES) {
    const value = readEnvValue(env, name);
    if (value) {
      output[name] = value;
    }
  }
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

  async installPythonRequests(containerName) {
    const execArgs = [
      'exec',
      '-e',
      'HOME=/home/cloudcli',
      requireValue(containerName, 'containerName'),
    ];
    const verifyRequests = () => execFileAsync('docker', [
      ...execArgs,
      'python3',
      '-c',
      'import requests',
    ]);

    try {
      await verifyRequests();
      return;
    } catch {
      // Install into the writable runtime home when the image does not already provide requests.
    }

    await execFileAsync('docker', [
      ...execArgs,
      'python3',
      '-m',
      'pip',
      'install',
      '--user',
      '--no-cache-dir',
      '--disable-pip-version-check',
      'requests',
    ]);
    await verifyRequests();
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
  users = defaultUserDb,
  codeHub = null,
  docker = new DockerCliClient(),
  fs = fsPromises,
} = {}) {
  const runtimeLocks = new Map();
  const activeRuntimeUses = new Map();

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
      const normalizedOlderThanMinutes = Number(olderThanMinutes);
      if (!Number.isInteger(normalizedOlderThanMinutes) || normalizedOlderThanMinutes <= 0) {
        throw new Error('olderThanMinutes must be a positive integer');
      }
      return {
        runtimeId: requireValue(runtimeId, 'runtimeId'),
        olderThanMinutes: normalizedOlderThanMinutes,
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

  function beginRuntimeUse(runtimeId) {
    if (!runtimeId) return 0;
    const next = (activeRuntimeUses.get(runtimeId) || 0) + 1;
    activeRuntimeUses.set(runtimeId, next);
    return next;
  }

  function endRuntimeUse(runtimeId) {
    if (!runtimeId) return 0;
    const current = activeRuntimeUses.get(runtimeId) || 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      activeRuntimeUses.delete(runtimeId);
    } else {
      activeRuntimeUses.set(runtimeId, next);
    }
    return next;
  }

  async function readCodeHubContainerEnv({ userId, workspaceHostPath }) {
    if (typeof codeHub?.resolvePrivateTokenEnvForWorkspace !== 'function') {
      return {};
    }

    return normalizeContainerEnvRecord(
      await codeHub.resolvePrivateTokenEnvForWorkspace({
        userId,
        workspacePath: workspaceHostPath,
      }),
    );
  }

  function readRuntimePathSegments({ tenantId, userId, workspaceId, workspaceHostPath }) {
    const tenant = typeof multitenancy.tenants?.getTenantById === 'function'
      ? multitenancy.tenants.getTenantById(tenantId)
      : null;
    const user = typeof users?.getUserById === 'function'
      ? users.getUserById(userId)
      : null;
    const workspace = typeof multitenancy.workspaces?.getWorkspaceById === 'function'
      ? multitenancy.workspaces.getWorkspaceById(workspaceId)
      : null;

    return {
      tenantCode: tenant?.code,
      username: user?.username,
      workspaceSlug: workspace?.slug || path.basename(workspaceHostPath),
    };
  }

  async function ensureContainer(runtime, containerEnv = {}) {
    const inspected = await docker.inspectContainer(runtime.container_name);
    if (inspected?.running) {
      return;
    }
    if (inspected?.exists) {
      await docker.startContainer(runtime.container_name);
      return;
    }

    const containerUser = resolveContainerUser(env);
    const args = buildDockerRunArgs({
      containerName: runtime.container_name,
      image: runtime.image,
      uid: containerUser.uid,
      gid: containerUser.gid,
      workspaceHostPath: runtime.workspace_host_path,
      runtimeHomePath: runtime.runtime_home_path,
      containerEnv,
      memory: env.CLOUDCLI_DOCKER_MEMORY || DEFAULT_DOCKER_MEMORY,
      cpus: env.CLOUDCLI_DOCKER_CPUS || DEFAULT_DOCKER_CPUS,
    });
    await docker.runDetached(args);
    if (typeof docker.installPythonRequests === 'function') {
      await docker.installPythonRequests(runtime.container_name);
    }
  }

  async function writeWrapper({ runtime, wrapperDir }) {
    await fs.mkdir(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, 'claude-docker-wrapper');
    await fs.writeFile(
      wrapperPath,
      buildClaudeDockerWrapperScript({
        containerName: runtime.container_name,
        envAllowlist: buildContainerEnvAllowlist(runtime.userEnv),
        defaultEnv: buildClaudeWrapperDefaultEnv(env, runtime.userEnv),
      }),
      { mode: 0o700 },
    );
    await fs.chmod(wrapperPath, 0o700);
    return wrapperPath;
  }

  async function createNewRuntime({
    tenantId,
    userId,
    workspaceId,
    workspaceHostPath,
    pathSegments,
  }) {
    const runtimeId = buildRuntimeId();
    const runtimePaths = buildRuntimePaths({
      runtimeRoot: env.CLOUDCLI_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
      provider: 'claude',
      ...pathSegments,
      tenantId,
      userId,
      workspaceId,
    });
    const containerName = buildContainerName({
      provider: 'claude',
      tenantId,
      userId,
      workspaceId,
      runtimeId,
    });

    await ensureRuntimeHomeWritable(fs, runtimePaths.runtimeHomePath, resolveContainerUser(env));

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

  async function toRuntimeContext(runtime, { requireHome = false } = {}) {
    if (!runtime) return null;
    if (!(await pathExists(fs, runtime.runtime_home_path))) {
      if (requireHome) {
        throw new Error('Claude Docker runtime home is missing for this session');
      }
      multitenancy.runtimes.updateStatus?.({
        runtimeId: runtime.runtime_id,
        status: 'deleted',
      });
      return null;
    }

    return {
      runtime,
      wrapperDir: wrapperDirFromRuntimeHome(runtime.runtime_home_path),
    };
  }

  async function resolveRuntimeForSession({ tenantId, userId, workspaceId, workspaceHostPath, sessionId }) {
    if (sessionId && typeof multitenancy.runtimes.findByProviderSession === 'function') {
      const sessionRuntime = await toRuntimeContext(
        multitenancy.runtimes.findByProviderSession({
          tenantId,
          userId,
          workspaceId,
          provider: 'claude',
          providerSessionId: sessionId,
        }),
        { requireHome: true },
      );
      if (sessionRuntime) {
        return sessionRuntime;
      }
    }

    if (typeof multitenancy.runtimes.findByOwner === 'function') {
      const userRuntime = await toRuntimeContext(
        multitenancy.runtimes.findByOwner({
          tenantId,
          userId,
          workspaceId,
          provider: 'claude',
          workspaceHostPath,
        }),
      );
      if (userRuntime) {
        return userRuntime;
      }
    }

    return null;
  }

  async function activateRuntimeContext({ runtimeContext, workspaceHostPath }) {
    const userEnv = normalizeContainerEnvRecord(runtimeContext.userEnv);
    await ensureRuntimeHomeWritable(fs, runtimeContext.runtime.runtime_home_path, resolveContainerUser(env));
    await ensureContainer(runtimeContext.runtime, userEnv);
    const wrapperPath = await writeWrapper({
      ...runtimeContext,
      runtime: {
        ...runtimeContext.runtime,
        userEnv,
      },
    });
    const runtime = multitenancy.runtimes.updateStatus({
      runtimeId: runtimeContext.runtime.runtime_id,
      status: 'active',
    }) || runtimeContext.runtime;
    beginRuntimeUse(runtime.runtime_id);

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
      executionEnv: buildWrapperHostEnv(env, userEnv),
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
      const userEnv = {
        ...readUserContainerEnv(users, userId),
        ...await readCodeHubContainerEnv({ userId, workspaceHostPath }),
      };
      const pathSegments = readRuntimePathSegments({
        tenantId,
        userId,
        workspaceId,
        workspaceHostPath,
      });
      const scopeLockKey = buildRuntimeScopeLockKey({
        provider: 'claude',
        tenantId,
        userId,
        workspaceId,
      });

      return withRuntimeLock(scopeLockKey, async () => {
        const runtimeContext = await resolveRuntimeForSession({
          tenantId,
          userId,
          workspaceId,
          workspaceHostPath,
          sessionId: options.sessionId,
        }) || await createNewRuntime({
          tenantId,
          userId,
          workspaceId,
          workspaceHostPath,
          pathSegments,
        });
        runtimeContext.userEnv = userEnv;

        return withRuntimeLock(runtimeContext.runtime.runtime_id, () => activateRuntimeContext({
          runtimeContext,
          workspaceHostPath,
        }));
      });
    },

    bindProviderSession({ runtimeId, providerSessionId }) {
      if (!runtimeId || !providerSessionId) return null;
      return multitenancy.runtimes.bindProviderSession({ runtimeId, providerSessionId });
    },

    markIdle(runtimeId) {
      if (!runtimeId) return null;
      if (endRuntimeUse(runtimeId) > 0) {
        return multitenancy.runtimes.updateStatus({ runtimeId, status: 'active' });
      }
      return multitenancy.runtimes.updateStatus({ runtimeId, status: 'idle' });
    },

    markFailed(runtimeId) {
      if (!runtimeId) return null;
      if (endRuntimeUse(runtimeId) > 0) {
        return multitenancy.runtimes.updateStatus({ runtimeId, status: 'active' });
      }
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

        activeRuntimeUses.delete(runtime.runtime_id);
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

        activeRuntimeUses.delete(normalized.runtimeId);
        multitenancy.runtimes.updateStatus({
          runtimeId: normalized.runtimeId,
          status: 'idle',
        });
        return true;
      });
    },
  };
}

export const agentSessionRuntimeManager = createAgentSessionRuntimeManager({ codeHub: codeHubService });
