import crypto from 'node:crypto';
import { execFile, spawn as spawnChildProcess } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { userDb as defaultUserDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { USER_KEY_ENV_NAME } from '../database/user-env.js';

import { codeHubService } from './codehub.js';
import { sanitizePathSegment } from './workspace-projects.js';
import { mapWorkspacePathForContainer } from './workspace-path-mapping.js';

const execFileAsync = promisify(execFile);

const W3_NAME_ENV_NAME = 'W3_NAME';
const TENANT_ID_ENV_NAME = 'TENANT_ID';
const WORKSPACE_ID_ENV_NAME = 'WORKSPACE_ID';
const ANTHROPIC_BASE_URL_ENV_NAME = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_MODEL_ENV_NAME = 'ANTHROPIC_MODEL';
const ANTHROPIC_AUTH_TOKEN_ENV_NAME = 'ANTHROPIC_AUTH_TOKEN';
const DAS_ENV_NAME = 'DAS';
const MCP_DATA_SOURCE_KEY_ENV_NAME = 'MCP_DATA_SOURCE_KEY';
const CLAUDE_WRAPPER_DEFAULT_ENV_NAMES = [
  ANTHROPIC_BASE_URL_ENV_NAME,
  ANTHROPIC_MODEL_ENV_NAME,
  DAS_ENV_NAME,
];
const DEFAULT_CLAUDE_DOCKER_IMAGE = 'docker.io/cloudcliai/sandbox:claude-code';
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), '.cloudcli', 'runtimes');
const DEFAULT_DOCKER_MEMORY = '2g';
const DEFAULT_DOCKER_CPUS = '2';
const DOCKER_WORKSPACE_CHECK_TIMEOUT_MS = 10_000;
const DOCKER_PYTHON_PACKAGES_ENV_NAME = 'CLOUDCLI_DOCKER_PYTHON_PACKAGES';
const CLAUDE_CLEANUP_PERIOD_DAYS = 36_500;
const DOCKER_SHARED_PYTHON_ENABLED_ENV_NAME = 'CLOUDCLI_DOCKER_SHARED_PYTHON';
const DOCKER_SHARED_PYTHON_ROOT_ENV_NAME = 'CLOUDCLI_DOCKER_PYTHON_SHARED_ROOT';
const DOCKER_SHARED_PYTHON_CONTAINER_PATH = '/opt/cloudcli/python';
const DOCKER_SHARED_PYTHON_USER_BASE = `${DOCKER_SHARED_PYTHON_CONTAINER_PATH}/user-base`;
const DOCKER_SHARED_PIP_CACHE = `${DOCKER_SHARED_PYTHON_CONTAINER_PATH}/pip-cache`;
const DOCKER_SHARED_UV_CACHE = `${DOCKER_SHARED_PYTHON_CONTAINER_PATH}/uv-cache`;
const DOCKER_SHARED_PIPX_HOME = `${DOCKER_SHARED_PYTHON_CONTAINER_PATH}/pipx`;
const DEFAULT_DOCKER_CONTAINER_PATH = [
  '/home/agent/.local/bin',
  '/usr/local/share/npm-global/bin',
  '/usr/local/sbin',
  '/usr/local/bin',
  '/usr/sbin',
  '/usr/bin',
  '/sbin',
  '/bin',
].join(':');
const DOCKER_SHARED_PYTHON_PATH = `${DOCKER_SHARED_PYTHON_USER_BASE}/bin:${DEFAULT_DOCKER_CONTAINER_PATH}`;
const PRIVATE_TOKEN_ENV_NAME = 'PRIVATE_TOKEN';
const DOCKER_RUNTIME_MANAGED_ENV_NAMES = new Set([
  'HOME',
  'PATH',
  'PYTHONUSERBASE',
  'PYTHONNOUSERSITE',
  'PIP_CACHE_DIR',
  'PIP_DISABLE_PIP_VERSION_CHECK',
  'PIP_BREAK_SYSTEM_PACKAGES',
  'PIP_USER',
  'PIP_PREFIX',
  'PIP_TARGET',
  'PIP_REQUIRE_VIRTUALENV',
  'VIRTUAL_ENV',
  'UV_CACHE_DIR',
  'PIPX_HOME',
  'PIPX_BIN_DIR',
]);
const DOCKER_RUN_ENV_DENYLIST = new Set([
  PRIVATE_TOKEN_ENV_NAME,
  ...DOCKER_RUNTIME_MANAGED_ENV_NAMES,
]);
const NPM_PROXY_ENV_NAMES = [
  'npm_config_proxy',
  'npm_config_https_proxy',
  'npm_config_noproxy',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY',
];
const RUNTIME_PROCESS_ENV_ALLOWLIST = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  ...NPM_PROXY_ENV_NAMES,
  MCP_DATA_SOURCE_KEY_ENV_NAME,
];
const CLAUDE_CONTAINER_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  ANTHROPIC_BASE_URL_ENV_NAME,
  ANTHROPIC_MODEL_ENV_NAME,
  DAS_ENV_NAME,
  ANTHROPIC_AUTH_TOKEN_ENV_NAME,
  MCP_DATA_SOURCE_KEY_ENV_NAME,
  PRIVATE_TOKEN_ENV_NAME,
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  USER_KEY_ENV_NAME,
  W3_NAME_ENV_NAME,
  TENANT_ID_ENV_NAME,
  WORKSPACE_ID_ENV_NAME,
];
const WRAPPER_HOST_ENV_ALLOWLIST = [
  ...CLAUDE_CONTAINER_ENV_ALLOWLIST,
  ...NPM_PROXY_ENV_NAMES,
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'XDG_RUNTIME_DIR',
];
const CONTAINER_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOOPBACK_PROXY_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

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

function rewriteDockerProxyValue(value) {
  const input = String(value || '').trim();
  if (!input) return input;
  try {
    const parsed = new URL(input);
    if (!LOOPBACK_PROXY_HOSTS.has(parsed.hostname.toLowerCase())) {
      return input;
    }
    parsed.hostname = 'host.docker.internal';
    return parsed.toString();
  } catch {
    return input;
  }
}

export function rewriteDockerProxyEnv(value) {
  const normalized = normalizeContainerEnvRecord(value);
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    ...NPM_PROXY_ENV_NAMES,
  ]) {
    if (normalized[name]) {
      normalized[name] = rewriteDockerProxyValue(normalized[name]);
    }
  }
  return normalized;
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

export function parseDockerPythonPackages(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function buildDockerPythonInstallArgs(containerName, packages = []) {
  const requestedPackages = Array.isArray(packages)
    ? packages.map((entry) => String(entry).trim()).filter(Boolean)
    : parseDockerPythonPackages(packages);
  if (requestedPackages.length === 0) return [];

  return [
    'exec',
    '-e',
    'HOME=/home/cloudcli',
    requireValue(containerName, 'containerName'),
    'python3',
    '-m',
    'pip',
    'install',
    '--user',
    '--break-system-packages',
    '--disable-pip-version-check',
    ...requestedPackages,
  ];
}

function parseBoolean(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${DOCKER_SHARED_PYTHON_ENABLED_ENV_NAME} must be a boolean`);
}

export function resolveDockerSharedPythonPath(env = process.env, image = DEFAULT_CLAUDE_DOCKER_IMAGE) {
  if (!parseBoolean(env[DOCKER_SHARED_PYTHON_ENABLED_ENV_NAME], true)) {
    return null;
  }

  const runtimeRoot = path.resolve(expandHome(env.CLOUDCLI_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT));
  const sharedRoot = path.resolve(expandHome(
    env[DOCKER_SHARED_PYTHON_ROOT_ENV_NAME]
      || path.join(runtimeRoot, '.shared', 'python'),
  ));
  const imageScope = crypto
    .createHash('sha256')
    .update(requireValue(image, 'image'))
    .digest('hex')
    .slice(0, 20);

  // Keep incompatible images out of the same Python user base. Python itself
  // adds another layer by placing packages under lib/pythonX.Y/site-packages.
  return path.join(sharedRoot, `image-${imageScope}`);
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

function createRuntimeLogDetails(runtime, extra = {}) {
  if (!runtime) return extra;
  return {
    runtimeId: runtime.runtime_id || null,
    containerName: runtime.container_name || null,
    image: runtime.image || null,
    tenantId: runtime.tenant_id ?? null,
    userId: runtime.user_id ?? null,
    workspaceId: runtime.workspace_id ?? null,
    workspaceHostPath: runtime.workspace_host_path || null,
    status: runtime.status || null,
    ...extra,
  };
}

function logRuntimeEvent(event, details = {}) {
  console.log('[agent-runtime]', JSON.stringify({
    event,
    provider: 'claude',
    mode: 'docker',
    ...details,
  }));
}

function formatRuntimeError(error) {
  const message = [
    error?.message,
    error?.stderr,
    error?.stdout,
  ].filter(Boolean).join('\n').trim();
  return message ? message.slice(0, 1000) : String(error || 'unknown error');
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
  sharedPythonHostPath = null,
  containerEnv = {},
  memory = DEFAULT_DOCKER_MEMORY,
  cpus = DEFAULT_DOCKER_CPUS,
}) {
  const containerEnvArgs = Object.entries(rewriteDockerProxyEnv(containerEnv))
    .filter(([key]) => !DOCKER_RUN_ENV_DENYLIST.has(key))
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const sharedPythonArgs = sharedPythonHostPath
    ? [
        '--mount',
        `type=bind,src=${requireValue(sharedPythonHostPath, 'sharedPythonHostPath')},dst=${DOCKER_SHARED_PYTHON_CONTAINER_PATH}`,
        '-e',
        `PYTHONUSERBASE=${DOCKER_SHARED_PYTHON_USER_BASE}`,
        '-e',
        `PIP_CACHE_DIR=${DOCKER_SHARED_PIP_CACHE}`,
        '-e',
        'PIP_DISABLE_PIP_VERSION_CHECK=1',
        '-e',
        'PIP_BREAK_SYSTEM_PACKAGES=1',
        '-e',
        'PIP_USER=1',
        '-e',
        `UV_CACHE_DIR=${DOCKER_SHARED_UV_CACHE}`,
        '-e',
        `PIPX_HOME=${DOCKER_SHARED_PIPX_HOME}`,
        '-e',
        `PIPX_BIN_DIR=${DOCKER_SHARED_PYTHON_USER_BASE}/bin`,
        '-e',
        `PATH=${DOCKER_SHARED_PYTHON_PATH}`,
      ]
    : [];

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
    '--add-host',
    'host.docker.internal:host-gateway',
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '--mount',
    `type=bind,src=${requireValue(workspaceHostPath, 'workspaceHostPath')},dst=/workspace`,
    '--mount',
    `type=bind,src=${requireValue(runtimeHomePath, 'runtimeHomePath')},dst=/home/cloudcli`,
    ...sharedPythonArgs,
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
  const defaultEnvNameSet = new Set(CLAUDE_WRAPPER_DEFAULT_ENV_NAMES);
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

export function buildClaudeDockerExecArgs({
  containerName,
  args = [],
  env = {},
  envAllowlist = CLAUDE_CONTAINER_ENV_ALLOWLIST,
  executable = 'claude',
}) {
  const normalizedEnv = normalizeContainerEnvRecord(env);
  const dockerEnvArgs = envAllowlist.flatMap((name) => (
    Object.prototype.hasOwnProperty.call(normalizedEnv, name)
      ? ['-e', `${name}=${normalizedEnv[name]}`]
      : []
  ));

  return [
    'exec',
    '-i',
    '-w',
    '/workspace',
    '-e',
    'HOME=/home/cloudcli',
    ...dockerEnvArgs,
    requireValue(containerName, 'containerName'),
    requireValue(executable, 'executable'),
    ...(Array.isArray(args) ? args : []),
  ];
}

export function createClaudeDockerSpawn({
  containerName,
  envAllowlist = CLAUDE_CONTAINER_ENV_ALLOWLIST,
  spawnImpl = spawnChildProcess,
} = {}) {
  return (options = {}) => spawnImpl(
    'docker',
    buildClaudeDockerExecArgs({
      containerName,
      args: options.args,
      env: options.env,
      envAllowlist,
    }),
    {
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
}

export async function ensureRuntimeHomeWritable(fsImpl, runtimeHomePath, { uid, gid } = {}) {
  await fsImpl.mkdir(runtimeHomePath, { recursive: true });

  const runtimeDirectoryPath = path.dirname(runtimeHomePath);
  const permissionTargets = [...new Set([runtimeDirectoryPath, runtimeHomePath])];
  for (const targetPath of permissionTargets) {
    let chownSucceeded = false;
    if (
      typeof fsImpl.chown === 'function'
      && isNonNegativeInteger(uid)
      && isNonNegativeInteger(gid)
    ) {
      try {
        await fsImpl.chown(targetPath, uid, gid);
        chownSucceeded = true;
      } catch {
        // Some deployments run without permission to chown bind mounts. In
        // that case, fall back to writable permissions for both the
        // workspace-specific runtime directory and its home directory.
      }
    }

    if (typeof fsImpl.chmod === 'function') {
      await fsImpl.chmod(targetPath, chownSucceeded ? 0o700 : 0o777);
    }
  }
}

export async function migratePathOwnership(fsImpl, targetPath, { uid, gid } = {}) {
  if (!isNonNegativeInteger(uid) || !isNonNegativeInteger(gid)) {
    throw new Error('uid and gid must be non-negative integers');
  }

  const stats = await fsImpl.lstat(targetPath);
  if (stats.isSymbolicLink()) {
    if (typeof fsImpl.lchown === 'function') {
      await fsImpl.lchown(targetPath, uid, gid);
      return 1;
    }
    return 0;
  }

  let migratedEntries = 0;
  if (stats.isDirectory()) {
    const entries = await fsImpl.readdir(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      migratedEntries += await migratePathOwnership(
        fsImpl,
        path.join(targetPath, entry.name),
        { uid, gid },
      );
    }
  }

  await fsImpl.chown(targetPath, uid, gid);
  return migratedEntries + 1;
}

export async function ensureClaudeCleanupPeriod(fsImpl, runtimeHomePath) {
  const claudeDir = path.join(runtimeHomePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};

  try {
    const content = await fsImpl.readFile(settingsPath, 'utf8');
    settings = JSON.parse(content);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('Claude settings must be a JSON object');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  if (settings.cleanupPeriodDays === CLAUDE_CLEANUP_PERIOD_DAYS) {
    return false;
  }

  await fsImpl.mkdir(claudeDir, { recursive: true });
  await fsImpl.writeFile(settingsPath, `${JSON.stringify({
    ...settings,
    cleanupPeriodDays: CLAUDE_CLEANUP_PERIOD_DAYS,
  }, null, 2)}\n`, 'utf8');
  return true;
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
  Object.assign(output, Object.fromEntries(
    Object.entries(normalizeContainerEnvRecord(containerEnv))
      .filter(([name]) => !DOCKER_RUNTIME_MANAGED_ENV_NAMES.has(name)),
  ));
  if (!output.PATH) output.PATH = process.env.PATH || '';
  if (!output.HOME) output.HOME = os.homedir();
  return rewriteDockerProxyEnv(output);
}

function buildRuntimeProcessEnv(env = process.env) {
  const output = {};
  for (const name of RUNTIME_PROCESS_ENV_ALLOWLIST) {
    if (env[name] != null) {
      output[name] = String(env[name]);
    }
  }
  return rewriteDockerProxyEnv(output);
}

function buildContainerEnvAllowlist(containerEnv = {}) {
  return Array.from(new Set([
    ...CLAUDE_CONTAINER_ENV_ALLOWLIST,
    ...NPM_PROXY_ENV_NAMES,
    ...Object.keys(normalizeContainerEnvRecord(containerEnv)),
  ])).filter((name) => !DOCKER_RUNTIME_MANAGED_ENV_NAMES.has(name));
}

function readEnvValue(record, name) {
  const value = record?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function inspectedContainerUsesSharedPython(inspected, sharedPythonHostPath) {
  // Lightweight test doubles and third-party Docker clients may only expose
  // state. In that case preserve the previous reuse behavior.
  if (!Array.isArray(inspected?.mounts) || !Array.isArray(inspected?.env)) {
    return true;
  }

  const sharedMount = inspected.mounts.find(
    (mount) => mount?.Destination === DOCKER_SHARED_PYTHON_CONTAINER_PATH,
  );
  if (!sharedPythonHostPath) {
    return !sharedMount;
  }

  const envSet = new Set(inspected.env);
  return path.resolve(String(sharedMount?.Source || '')) === path.resolve(sharedPythonHostPath)
    && envSet.has(`PYTHONUSERBASE=${DOCKER_SHARED_PYTHON_USER_BASE}`)
    && envSet.has(`PIP_CACHE_DIR=${DOCKER_SHARED_PIP_CACHE}`)
    && envSet.has('PIP_BREAK_SYSTEM_PACKAGES=1')
    && envSet.has('PIP_USER=1')
    && envSet.has(`PATH=${DOCKER_SHARED_PYTHON_PATH}`);
}

function hasNonEmptyBaseEnvValue(baseEnv, name) {
  return readEnvValue(baseEnv, name) !== null;
}

function buildClaudeWrapperDefaultEnv(env = process.env, containerEnv = {}) {
  const defaults = {};
  const normalizedContainerEnv = normalizeContainerEnvRecord(containerEnv);
  for (const name of CLAUDE_WRAPPER_DEFAULT_ENV_NAMES) {
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

function readUserContainerEnv(users, userId, baseEnv = process.env) {
  const normalizedBaseEnv = normalizeContainerEnvRecord(baseEnv);
  const username = readUsernameForEnv(users, userId);
  if (!username) {
    throw new Error('username is required for W3_NAME');
  }

  const output = {
    [W3_NAME_ENV_NAME]: username,
  };

  if (typeof users?.getGitTokenForUser === 'function') {
    const gitToken = readEnvValue({ [PRIVATE_TOKEN_ENV_NAME]: users.getGitTokenForUser(userId) }, PRIVATE_TOKEN_ENV_NAME);
    if (gitToken) {
      output[PRIVATE_TOKEN_ENV_NAME] = gitToken;
    }
  }

  if (typeof users?.getEnvForUser !== 'function') {
    return output;
  }
  const env = normalizeContainerEnvRecord(users.getEnvForUser(userId));
  if (env[USER_KEY_ENV_NAME]) {
    output[USER_KEY_ENV_NAME] = env[USER_KEY_ENV_NAME];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name === USER_KEY_ENV_NAME || name === W3_NAME_ENV_NAME || name === PRIVATE_TOKEN_ENV_NAME) {
      continue;
    }
    if (value === '' && hasNonEmptyBaseEnvValue(normalizedBaseEnv, name)) {
      continue;
    }
    output[name] = value;
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

function resolveRuntimeDirectoryForCleanup(runtimeHomePath, runtimeRoot) {
  const resolvedRoot = path.resolve(expandHome(runtimeRoot || DEFAULT_RUNTIME_ROOT));
  const runtimeDir = path.resolve(path.dirname(expandHome(requireValue(runtimeHomePath, 'runtimeHomePath'))));

  if (runtimeDir === resolvedRoot || !runtimeDir.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('runtime cleanup path must stay under CLOUDCLI_RUNTIME_ROOT');
  }

  return runtimeDir;
}

export class DockerCliClient {
  async inspectContainer(containerName) {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '-f',
        '{{json .}}',
        containerName,
      ]);
      const inspected = JSON.parse(stdout.trim());
      const state = inspected.State || {};
      return {
        exists: true,
        running: state.Running === true,
        user: inspected.Config?.User ?? null,
        state,
        env: Array.isArray(inspected.Config?.Env) ? inspected.Config.Env : [],
        mounts: Array.isArray(inspected.Mounts) ? inspected.Mounts : [],
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

  async removeContainer(containerName) {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName]);
    } catch (error) {
      if (error?.code === 1 || error?.stderr?.includes('No such object')) {
        return;
      }
      throw error;
    }
  }

  async verifyWorkspaceCwd(containerName) {
    await execFileAsync('docker', [
      'exec',
      '-w',
      '/workspace',
      '-e',
      'HOME=/home/cloudcli',
      requireValue(containerName, 'containerName'),
      'pwd',
    ], {
      timeout: DOCKER_WORKSPACE_CHECK_TIMEOUT_MS,
    });
  }

  async installPythonPackages(containerName, packages = []) {
    const args = buildDockerPythonInstallArgs(containerName, packages);
    if (args.length === 0) return;
    await execFileAsync('docker', args);
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

  async function assertWorkspaceDirectory(workspacePath) {
    const stats = await fs.stat(workspacePath);
    if (!stats.isDirectory()) {
      throw new Error('workspace path must be a directory');
    }
  }

  async function resolveWorkspaceHostPath(workspacePath) {
    const requestedPath = requireValue(workspacePath, 'cwd');
    try {
      const resolved = await fs.realpath(requestedPath);
      await assertWorkspaceDirectory(resolved);
      return resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }

      const containerWorkspacePath = mapWorkspacePathForContainer(requestedPath, env);
      if (!containerWorkspacePath || containerWorkspacePath === requestedPath) {
        throw error;
      }

      const resolvedContainerPath = await fs.realpath(containerWorkspacePath);
      await assertWorkspaceDirectory(resolvedContainerPath);
    }

    return requestedPath;
  }

  async function resolveWorkspaceOwnershipPath(workspaceHostPath) {
    const requestedPath = requireValue(workspaceHostPath, 'workspaceHostPath');
    try {
      await fs.lstat(requestedPath);
      return requestedPath;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }
    }

    const mappedPath = mapWorkspacePathForContainer(requestedPath, env);
    if (!mappedPath || mappedPath === requestedPath) {
      throw new Error(`workspace ownership path is not accessible: ${requestedPath}`);
    }
    await fs.lstat(mappedPath);
    return mappedPath;
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

  async function ensureContainer(runtime, containerEnv = {}, logContext = {}) {
    const requestId = logContext.requestId || null;
    const containerUser = resolveContainerUser(env);
    const expectedContainerUser = `${containerUser.uid}:${containerUser.gid}`;
    const sharedPythonHostPath = resolveDockerSharedPythonPath(env, runtime.image);
    const createContainer = async () => {
      const memory = env.CLOUDCLI_DOCKER_MEMORY || DEFAULT_DOCKER_MEMORY;
      const cpus = env.CLOUDCLI_DOCKER_CPUS || DEFAULT_DOCKER_CPUS;
      if (sharedPythonHostPath) {
        await ensureRuntimeHomeWritable(fs, sharedPythonHostPath, containerUser);
      }
      const args = buildDockerRunArgs({
        containerName: runtime.container_name,
        image: runtime.image,
        uid: containerUser.uid,
        gid: containerUser.gid,
        workspaceHostPath: runtime.workspace_host_path,
        runtimeHomePath: runtime.runtime_home_path,
        sharedPythonHostPath,
        containerEnv,
        memory,
        cpus,
      });
      logRuntimeEvent('container_create_start', createRuntimeLogDetails(runtime, {
        requestId,
        memory,
        cpus,
        uid: containerUser.uid,
        gid: containerUser.gid,
        sharedPythonHostPath,
      }));
      await docker.runDetached(args);
      logRuntimeEvent('container_created', createRuntimeLogDetails(runtime, {
        requestId,
        memory,
        cpus,
      }));
      await verifyContainerWorkspace(runtime, { requestId, throwOnFailure: true });
      const pythonPackages = parseDockerPythonPackages(env[DOCKER_PYTHON_PACKAGES_ENV_NAME]);
      if (pythonPackages.length > 0 && typeof docker.installPythonPackages === 'function') {
        try {
          const installPromise = docker.installPythonPackages(runtime.container_name, pythonPackages);
          if (installPromise && typeof installPromise.catch === 'function') {
            installPromise.catch((error) => {
              console.warn(
                `[agent-session-runtime] Docker Python package install failed for ${runtime.container_name}:`,
                error,
              );
            });
          }
        } catch (error) {
          console.warn(
            `[agent-session-runtime] Docker Python package install failed for ${runtime.container_name}:`,
            error,
          );
        }
      }
    };

    const recreateContainer = async (reason, error = null) => {
      if (typeof docker.removeContainer !== 'function') {
        throw error || new Error('Docker runtime container is unhealthy and cannot be removed');
      }
      logRuntimeEvent('container_recreate_start', createRuntimeLogDetails(runtime, {
        requestId,
        reason,
        error: error ? formatRuntimeError(error) : undefined,
      }));
      await docker.removeContainer(runtime.container_name);
      logRuntimeEvent('container_removed_for_recreate', createRuntimeLogDetails(runtime, {
        requestId,
        reason,
      }));
      await createContainer();
    };

    const migrateContainerUser = async (inspected) => {
      if (typeof docker.removeContainer !== 'function') {
        throw new Error('Docker runtime container user changed and the existing container cannot be removed');
      }

      logRuntimeEvent('container_user_migration_start', createRuntimeLogDetails(runtime, {
        requestId,
        previousUser: inspected.user,
        targetUser: expectedContainerUser,
      }));

      if (inspected.running) {
        await docker.stopContainer(runtime.container_name);
      }

      const workspaceOwnershipPath = await resolveWorkspaceOwnershipPath(runtime.workspace_host_path);
      const workspaceEntries = await migratePathOwnership(fs, workspaceOwnershipPath, containerUser);
      const runtimeHomeEntries = await migratePathOwnership(fs, runtime.runtime_home_path, containerUser);

      await docker.removeContainer(runtime.container_name);
      await createContainer();

      logRuntimeEvent('container_user_migration_completed', createRuntimeLogDetails(runtime, {
        requestId,
        previousUser: inspected.user,
        targetUser: expectedContainerUser,
        workspaceEntries,
        runtimeHomeEntries,
      }));
    };

    const prepareNewContainerOwnership = async () => {
      logRuntimeEvent('container_ownership_prepare_start', createRuntimeLogDetails(runtime, {
        requestId,
        targetUser: expectedContainerUser,
      }));

      const workspaceOwnershipPath = await resolveWorkspaceOwnershipPath(runtime.workspace_host_path);
      const workspaceEntries = await migratePathOwnership(fs, workspaceOwnershipPath, containerUser);
      const runtimeHomeEntries = await migratePathOwnership(fs, runtime.runtime_home_path, containerUser);

      logRuntimeEvent('container_ownership_prepare_completed', createRuntimeLogDetails(runtime, {
        requestId,
        targetUser: expectedContainerUser,
        workspaceEntries,
        runtimeHomeEntries,
      }));
    };

    const inspected = await docker.inspectContainer(runtime.container_name);
    if (
      inspected?.exists
      && typeof inspected.user === 'string'
      && inspected.user.trim() !== ''
      && inspected.user.trim() !== expectedContainerUser
    ) {
      await migrateContainerUser(inspected);
      return;
    }
    if (inspected?.exists && !inspectedContainerUsesSharedPython(inspected, sharedPythonHostPath)) {
      await recreateContainer('shared_python_config_changed');
      return;
    }
    if (inspected?.running) {
      const healthy = await verifyContainerWorkspace(runtime, { requestId });
      if (healthy) {
        logRuntimeEvent('container_reuse_running', createRuntimeLogDetails(runtime, {
          requestId,
          containerStatus: inspected.status || 'running',
        }));
        return;
      }
      await recreateContainer('workspace_cwd_unhealthy');
      return;
    }
    if (inspected?.exists) {
      logRuntimeEvent('container_start_existing', createRuntimeLogDetails(runtime, {
        requestId,
        containerStatus: inspected.status || null,
        exitCode: inspected.exitCode ?? null,
      }));
      try {
        await docker.startContainer(runtime.container_name);
      } catch (error) {
        await recreateContainer('start_failed', error);
        return;
      }
      const healthy = await verifyContainerWorkspace(runtime, { requestId });
      if (healthy) {
        logRuntimeEvent('container_started_existing', createRuntimeLogDetails(runtime, {
          requestId,
        }));
        return;
      }
      await recreateContainer('workspace_cwd_unhealthy');
      return;
    }

    await prepareNewContainerOwnership();
    await createContainer();
  }

  async function verifyContainerWorkspace(runtime, { requestId = null, throwOnFailure = false } = {}) {
    if (typeof docker.verifyWorkspaceCwd !== 'function') {
      return true;
    }
    try {
      await docker.verifyWorkspaceCwd(runtime.container_name);
      return true;
    } catch (error) {
      logRuntimeEvent('container_workspace_check_failed', createRuntimeLogDetails(runtime, {
        requestId,
        error: formatRuntimeError(error),
      }));
      if (throwOnFailure) {
        throw error;
      }
      return false;
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
    logRequestId = null,
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
    logRuntimeEvent('runtime_created', createRuntimeLogDetails(runtime, {
      requestId: logRequestId,
    }));

    return {
      runtime,
      wrapperDir: runtimePaths.wrapperDir,
    };
  }

  async function createNewLocalRuntime({
    tenantId,
    userId,
    workspaceId,
    workspaceHostPath,
    pathSegments,
    logRequestId = null,
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
      provider: 'claude-local',
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
      image: 'local',
      workspaceHostPath,
      runtimeHomePath: runtimePaths.runtimeHomePath,
      status: 'pending',
    });
    logRuntimeEvent('local_runtime_created', createRuntimeLogDetails(runtime, {
      mode: 'local',
      requestId: logRequestId,
    }));

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
    const containerEnv = {
      ...buildRuntimeProcessEnv(env),
      ...userEnv,
    };
    await ensureRuntimeHomeWritable(fs, runtimeContext.runtime.runtime_home_path, resolveContainerUser(env));
    await ensureClaudeCleanupPeriod(fs, runtimeContext.runtime.runtime_home_path);
    await ensureContainer(runtimeContext.runtime, containerEnv, {
      requestId: runtimeContext.logRequestId || null,
    });
    const wrapperPath = await writeWrapper({
      ...runtimeContext,
      runtime: {
        ...runtimeContext.runtime,
        userEnv,
      },
    });
    const updatedRuntime = multitenancy.runtimes.updateStatus({
      runtimeId: runtimeContext.runtime.runtime_id,
      status: 'active',
    });
    const runtime = {
      ...runtimeContext.runtime,
      ...(updatedRuntime || {}),
    };
    beginRuntimeUse(runtime.runtime_id);
    logRuntimeEvent('runtime_ready', createRuntimeLogDetails(runtime, {
      requestId: runtimeContext.logRequestId || null,
      containerCwd: '/workspace',
    }));

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
      spawnClaudeCodeProcess: createClaudeDockerSpawn({
        containerName: runtime.container_name,
        envAllowlist: buildContainerEnvAllowlist(userEnv),
      }),
      executionEnv: buildWrapperHostEnv(env, userEnv),
      settingSources: ['project'],
      disableHostMcpConfig: true,
    };
  }

  async function activateLocalRuntimeContext({ runtimeContext, workspaceHostPath, userEnv, logRequestId = null }) {
    await ensureRuntimeHomeWritable(fs, runtimeContext.runtime.runtime_home_path, resolveContainerUser(env));
    const updatedRuntime = multitenancy.runtimes.updateStatus({
      runtimeId: runtimeContext.runtime.runtime_id,
      status: 'active',
    });
    const runtime = {
      ...runtimeContext.runtime,
      ...(updatedRuntime || {}),
    };
    beginRuntimeUse(runtime.runtime_id);
    logRuntimeEvent('local_runtime_ready', createRuntimeLogDetails(runtime, {
      mode: 'local',
      requestId: logRequestId,
      cwd: workspaceHostPath,
    }));

    return {
      mode: 'local',
      runtimeId: runtime.runtime_id,
      runtimeHomePath: runtime.runtime_home_path,
      cwd: workspaceHostPath,
      projectPath: workspaceHostPath,
      hostWorkspacePath: workspaceHostPath,
      pathToClaudeCodeExecutable: env.CLAUDE_CLI_PATH || 'claude',
      settingSources: ['project', 'user', 'local'],
      executionEnv: { ...env, ...userEnv },
    };
  }

  return {
    async prepareClaudeRuntime(options = {}) {
      const mode = resolveClaudeExecutionMode(env);
      if (mode === 'local') {
        if (options.tenantId != null && options.userId != null && options.workspaceId != null) {
          const tenantId = requirePositiveInteger(options.tenantId, 'tenantId');
          const userId = requirePositiveInteger(options.userId, 'userId');
          const workspaceId = requirePositiveInteger(options.workspaceId, 'workspaceId');
          const workspaceHostPath = await resolveWorkspaceHostPath(options.cwd || options.projectPath);
          const userEnv = {
            ...readUserContainerEnv(users, userId, env),
            ...await readCodeHubContainerEnv({ userId, workspaceHostPath }),
            [TENANT_ID_ENV_NAME]: String(tenantId),
            [WORKSPACE_ID_ENV_NAME]: String(workspaceId),
          };
          const pathSegments = readRuntimePathSegments({
            tenantId,
            userId,
            workspaceId,
            workspaceHostPath,
          });
          const scopeLockKey = buildRuntimeScopeLockKey({
            provider: 'claude-local',
            tenantId,
            userId,
            workspaceId,
          });

          return withRuntimeLock(scopeLockKey, async () => {
            logRuntimeEvent('local_runtime_prepare', {
              mode: 'local',
              requestId: options.logRequestId || null,
              tenantId,
              userId,
              workspaceId,
              sessionId: options.sessionId || null,
              workspaceHostPath,
            });
            const existingRuntimeContext = await resolveRuntimeForSession({
              tenantId,
              userId,
              workspaceId,
              workspaceHostPath,
              sessionId: options.sessionId,
            });
            const runtimeContext = existingRuntimeContext || await createNewLocalRuntime({
              tenantId,
              userId,
              workspaceId,
              workspaceHostPath,
              pathSegments,
              logRequestId: options.logRequestId || null,
            });
            logRuntimeEvent(
              existingRuntimeContext ? 'local_runtime_selected_existing' : 'local_runtime_selected_new',
              createRuntimeLogDetails(runtimeContext.runtime, {
                mode: 'local',
                requestId: options.logRequestId || null,
                sessionId: options.sessionId || null,
              }),
            );

            return withRuntimeLock(runtimeContext.runtime.runtime_id, () => activateLocalRuntimeContext({
              runtimeContext,
              workspaceHostPath,
              userEnv,
              logRequestId: options.logRequestId || null,
            }));
          });
        }

        const userEnv = options.userId == null
          ? {}
          : readUserContainerEnv(users, requirePositiveInteger(options.userId, 'userId'), env);
        return {
          mode: 'local',
          cwd: options.cwd,
          projectPath: options.projectPath || options.cwd,
          hostWorkspacePath: options.cwd || options.projectPath,
          pathToClaudeCodeExecutable: env.CLAUDE_CLI_PATH || 'claude',
          settingSources: ['project', 'user', 'local'],
          ...(Object.keys(userEnv).length > 0 ? { executionEnv: { ...env, ...userEnv } } : {}),
        };
      }

      const tenantId = requirePositiveInteger(options.tenantId, 'tenantId');
      const userId = requirePositiveInteger(options.userId, 'userId');
      const workspaceId = requirePositiveInteger(options.workspaceId, 'workspaceId');
      const workspaceHostPath = await resolveWorkspaceHostPath(options.cwd || options.projectPath);
      const userEnv = {
        ...readUserContainerEnv(users, userId, env),
        ...await readCodeHubContainerEnv({ userId, workspaceHostPath }),
        [TENANT_ID_ENV_NAME]: String(tenantId),
        [WORKSPACE_ID_ENV_NAME]: String(workspaceId),
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
        logRuntimeEvent('runtime_prepare', {
          requestId: options.logRequestId || null,
          tenantId,
          userId,
          workspaceId,
          sessionId: options.sessionId || null,
          workspaceHostPath,
        });
        const existingRuntimeContext = await resolveRuntimeForSession({
          tenantId,
          userId,
          workspaceId,
          workspaceHostPath,
          sessionId: options.sessionId,
        });
        const runtimeContext = existingRuntimeContext || await createNewRuntime({
          tenantId,
          userId,
          workspaceId,
          workspaceHostPath,
          pathSegments,
          logRequestId: options.logRequestId || null,
        });
        logRuntimeEvent(
          existingRuntimeContext ? 'runtime_selected_existing' : 'runtime_selected_new',
          createRuntimeLogDetails(runtimeContext.runtime, {
            requestId: options.logRequestId || null,
            sessionId: options.sessionId || null,
          }),
        );
        runtimeContext.userEnv = userEnv;
        runtimeContext.logRequestId = options.logRequestId || null;

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

    async cleanupWorkspaceRuntimes({ tenantId, workspaceId } = {}) {
      if (!tenantId || !workspaceId || typeof multitenancy.runtimes?.listForWorkspace !== 'function') {
        return { cleaned: 0, runtimes: [] };
      }

      const runtimes = multitenancy.runtimes.listForWorkspace({ tenantId, workspaceId, includeDeleted: true });
      const cleaned = [];
      for (const runtime of runtimes) {
        await withRuntimeLock(runtime.runtime_id, async () => {
          if (typeof docker.removeContainer === 'function') {
            await docker.removeContainer(runtime.container_name);
          } else {
            const inspected = await docker.inspectContainer(runtime.container_name);
            if (inspected?.running && typeof docker.stopContainer === 'function') {
              await docker.stopContainer(runtime.container_name);
            }
          }

          const runtimeDir = resolveRuntimeDirectoryForCleanup(
            runtime.runtime_home_path,
            env.CLOUDCLI_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT,
          );
          await fs.rm(runtimeDir, { recursive: true, force: true });
          activeRuntimeUses.delete(runtime.runtime_id);
          multitenancy.runtimes.updateStatus?.({
            runtimeId: runtime.runtime_id,
            status: 'deleted',
          });
          cleaned.push({
            runtimeId: runtime.runtime_id,
            containerName: runtime.container_name,
            runtimeDir,
          });
        });
      }

      return { cleaned: cleaned.length, runtimes: cleaned };
    },
  };
}

export const agentSessionRuntimeManager = createAgentSessionRuntimeManager({ codeHub: codeHubService });
