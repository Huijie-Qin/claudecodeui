import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { multitenancyDb } from '../database/multitenancy-db.js';

export const MCP_HELPER_CONTAINER_ROOT = '/home/cloudcli/.cloudcli/mcp-helpers';
export const DEFAULT_MCP_HELPER_HOST_ROOT = path.join(os.homedir(), '.cloudcli', 'mcp-helper-scripts');
const HELPER_ENV_FILE_NAME = '.headers-helper.env.sh';

const HELPER_FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HELPER_SCRIPT_MAX_BYTES = 64 * 1024;
const HELPER_ENV_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function requireSafeHelperFileName(fileName) {
  const baseName = path.basename(String(fileName || '').trim());
  if (!HELPER_FILE_NAME_PATTERN.test(baseName)) {
    throw createHttpError('Helper script filename must use letters, numbers, dots, underscores, or hyphens', 400);
  }
  return baseName;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readStringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => HELPER_ENV_NAME_PATTERN.test(String(key)) && entry != null && String(entry) !== '')
      .map(([key, entry]) => [String(key), String(entry)]),
  );
}

function helperDirectoryForPreset(root, { tenantId, presetId }) {
  return path.join(
    root,
    `tenant-${requirePositiveInteger(tenantId, 'tenantId')}`,
    `preset-${requirePositiveInteger(presetId, 'presetId')}`,
  );
}

function helperDirectoryForRuntime(runtimeHomePath, presetName) {
  return path.join(runtimeHomePath, '.cloudcli', 'mcp-helpers', String(presetName));
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 1000;
}

function currentGid() {
  return typeof process.getgid === 'function' ? process.getgid() : 1000;
}

function parseContainerId(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveDockerHelperOwner(env = process.env) {
  const defaultUid = currentUid();
  const defaultGid = currentGid();
  return {
    uid: parseContainerId(env.CLOUDCLI_DOCKER_UID, defaultUid > 0 ? defaultUid : 1000),
    gid: parseContainerId(env.CLOUDCLI_DOCKER_GID, defaultGid > 0 ? defaultGid : 1000),
  };
}

function helperContainerDirectory(presetName) {
  return path.posix.join(MCP_HELPER_CONTAINER_ROOT, String(presetName));
}

async function applyPathAccess(fsImpl, targetPath, {
  owner = null,
  mode,
  fallbackMode = mode,
} = {}) {
  let chownSucceeded = false;
  if (
    owner
    && typeof fsImpl.chown === 'function'
    && Number.isInteger(owner.uid)
    && Number.isInteger(owner.gid)
  ) {
    try {
      await fsImpl.chown(targetPath, owner.uid, owner.gid);
      chownSucceeded = true;
    } catch {
      // If the deployment cannot chown bind-mounted files, keep the helper
      // readable by the sandbox user so MCP auth does not fail at runtime.
    }
  }
  if (typeof fsImpl.chmod === 'function') {
    await fsImpl.chmod(targetPath, owner && !chownSucceeded ? fallbackMode : mode).catch(() => {});
  }
}

async function prepareRuntimeHelperRoot({ runtimeHomePath, fsImpl, owner }) {
  const cloudcliDir = path.join(runtimeHomePath, '.cloudcli');
  const helperRoot = path.join(cloudcliDir, 'mcp-helpers');

  for (const directory of [cloudcliDir, helperRoot]) {
    await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
    await applyPathAccess(fsImpl, directory, {
      owner,
      mode: 0o700,
      fallbackMode: 0o755,
    });
  }

  return owner;
}

async function writeHelperScript({
  directory,
  fileName,
  content,
  fsImpl = fs,
  owner = null,
}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPathAccess(fsImpl, directory, {
    owner,
    mode: 0o700,
    fallbackMode: 0o755,
  });
  const scriptPath = path.join(directory, requireSafeHelperFileName(fileName));
  await fsImpl.writeFile(scriptPath, content, { mode: 0o700 });
  await applyPathAccess(fsImpl, scriptPath, {
    owner,
    mode: 0o700,
    fallbackMode: 0o755,
  });
  return scriptPath;
}

async function writeHelperEnvFile({
  directory,
  helperEnv,
  fsImpl = fs,
  owner = null,
}) {
  const env = readStringRecord(helperEnv);
  if (Object.keys(env).length === 0) {
    return null;
  }

  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPathAccess(fsImpl, directory, {
    owner,
    mode: 0o700,
    fallbackMode: 0o755,
  });
  const envPath = path.join(directory, HELPER_ENV_FILE_NAME);
  const content = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  await fsImpl.writeFile(envPath, `${content}\n`, { mode: 0o600 });
  await applyPathAccess(fsImpl, envPath, {
    owner,
    mode: 0o600,
    fallbackMode: 0o644,
  });
  return envPath;
}

function withoutHelperEnv(config) {
  const { helperEnv, ...safeConfig } = config || {};
  return safeConfig;
}

function withHelperWorkingDirectory(config, workingDirectory, { includeEnvFile = false } = {}) {
  const safeConfig = withoutHelperEnv(config);
  if (!config?.headersHelper || !workingDirectory) {
    return safeConfig;
  }
  const envPrefix = includeEnvFile
    ? `set -a && . ${shellQuote(`./${HELPER_ENV_FILE_NAME}`)} && set +a && `
    : '';
  return {
    ...safeConfig,
    headersHelper: `cd ${shellQuote(workingDirectory)} && ${envPrefix}${config.headersHelper}`,
  };
}

export function normalizeUploadedHelperScript({ originalName, content }) {
  const fileName = requireSafeHelperFileName(originalName);
  const scriptContent = typeof content === 'string' ? content : String(content ?? '');
  const sizeBytes = Buffer.byteLength(scriptContent, 'utf8');
  if (sizeBytes <= 0) {
    throw createHttpError('Helper script cannot be empty', 400);
  }
  if (sizeBytes > HELPER_SCRIPT_MAX_BYTES) {
    throw createHttpError('Helper script must be 64KB or smaller', 400);
  }
  return {
    fileName,
    content: scriptContent,
    sizeBytes,
  };
}

export function buildMcpHelperScriptMetadata(row) {
  if (!row) return null;
  return {
    fileName: row.file_name,
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256,
    updatedAt: row.updated_at || null,
  };
}

export function getPresetHelperScript(multitenancy, { tenantId, presetId }) {
  return multitenancy.mcpPresetHelperScripts?.getScript?.({
    tenantId: requirePositiveInteger(tenantId, 'tenantId'),
    presetId: requirePositiveInteger(presetId, 'presetId'),
  }) || null;
}

export function savePresetHelperScript({
  tenantId,
  presetId,
  userId,
  originalName,
  content,
  multitenancy = multitenancyDb,
}) {
  const normalized = normalizeUploadedHelperScript({ originalName, content });
  const script = multitenancy.mcpPresetHelperScripts.upsertScript({
    tenantId: requirePositiveInteger(tenantId, 'tenantId'),
    presetId: requirePositiveInteger(presetId, 'presetId'),
    fileName: normalized.fileName,
    content: normalized.content,
    uploadedByUserId: requirePositiveInteger(userId, 'userId'),
  });
  return buildMcpHelperScriptMetadata(script);
}

export async function resolvePresetProbeConfig({
  tenantId,
  presetId,
  presetName,
  config,
  helperRoot = process.env.CLOUDCLI_MCP_HELPER_ROOT || DEFAULT_MCP_HELPER_HOST_ROOT,
  multitenancy = multitenancyDb,
  fsImpl = fs,
}) {
  const script = getPresetHelperScript(multitenancy, { tenantId, presetId });
  const helperEnv = readStringRecord(config?.helperEnv);
  if ((!script && Object.keys(helperEnv).length === 0) || !config?.headersHelper) {
    return withoutHelperEnv(config);
  }

  const helperDirectory = helperDirectoryForPreset(helperRoot, { tenantId, presetId });
  if (script) {
    await writeHelperScript({
      directory: helperDirectory,
      fileName: script.file_name,
      content: script.content,
      fsImpl,
    });
  }
  const envPath = await writeHelperEnvFile({
    directory: helperDirectory,
    helperEnv,
    fsImpl,
  });
  return withHelperWorkingDirectory(
    { ...config, name: presetName },
    helperDirectory,
    { includeEnvFile: Boolean(envPath) },
  );
}

export async function applyWorkspaceMcpHelperScripts(mcpServers, {
  tenantId,
  workspaceId,
  runtimeMode = 'local',
  runtimeHomePath = null,
  runtimeOwner = null,
  helperRoot = process.env.CLOUDCLI_MCP_HELPER_ROOT || DEFAULT_MCP_HELPER_HOST_ROOT,
  multitenancy = multitenancyDb,
  fsImpl = fs,
} = {}) {
  if (!mcpServers || typeof mcpServers !== 'object') {
    return mcpServers;
  }

  const installs = multitenancy.mcpInstalls?.listInstallsForWorkspace?.({
    workspaceId: requirePositiveInteger(workspaceId, 'workspaceId'),
  }) || [];
  if (installs.length === 0) {
    return mcpServers;
  }

  const nextServers = { ...mcpServers };
  const runtimeHelperOwner = runtimeMode === 'docker' && runtimeHomePath
    ? runtimeOwner || resolveDockerHelperOwner()
    : null;
  if (runtimeHelperOwner) {
    await prepareRuntimeHelperRoot({ runtimeHomePath, fsImpl, owner: runtimeHelperOwner });
  }
  for (const install of installs) {
    const serverName = install.name;
    const currentConfig = nextServers[serverName];
    if (!currentConfig?.headersHelper) continue;
    const preset = multitenancy.mcpPresets?.getPresetById?.({
      tenantId: requirePositiveInteger(tenantId, 'tenantId'),
      presetId: install.preset_id,
    });
    const helperEnv = readStringRecord(preset?.config?.helperEnv);

    const script = getPresetHelperScript(multitenancy, {
      tenantId: requirePositiveInteger(tenantId, 'tenantId'),
      presetId: install.preset_id,
    });
    if (!script && Object.keys(helperEnv).length === 0) {
      nextServers[serverName] = withoutHelperEnv(currentConfig);
      continue;
    }

    const hostDirectory = runtimeMode === 'docker' && runtimeHomePath
      ? helperDirectoryForRuntime(runtimeHomePath, serverName)
      : helperDirectoryForPreset(helperRoot, { tenantId, presetId: install.preset_id });
    const commandDirectory = runtimeMode === 'docker' && runtimeHomePath
      ? helperContainerDirectory(serverName)
      : hostDirectory;

    if (script) {
      await writeHelperScript({
        directory: hostDirectory,
        fileName: script.file_name,
        content: script.content,
        fsImpl,
        owner: runtimeHelperOwner,
      });
    }
    const envPath = await writeHelperEnvFile({
      directory: hostDirectory,
      helperEnv,
      fsImpl,
      owner: runtimeHelperOwner,
    });
    nextServers[serverName] = withHelperWorkingDirectory(
      currentConfig,
      commandDirectory,
      { includeEnvFile: Boolean(envPath) },
    );
  }
  return nextServers;
}
