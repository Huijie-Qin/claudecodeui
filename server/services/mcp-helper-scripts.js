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
const PRIVATE_HELPER_MODES = Object.freeze({
  directory: 0o700,
  script: 0o700,
  env: 0o600,
});
const DOCKER_HELPER_MODES = Object.freeze({
  directory: 0o755,
  script: 0o755,
  env: 0o644,
});

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeHelperOwner(owner) {
  if (owner == null) return null;
  if (
    !Number.isInteger(owner.uid)
    || owner.uid < 0
    || !Number.isInteger(owner.gid)
    || owner.gid < 0
  ) {
    throw createHttpError('MCP helper owner uid and gid must be non-negative integers', 500);
  }
  return { uid: owner.uid, gid: owner.gid };
}

async function applyHelperOwnership(fsImpl, targetPaths, owner) {
  if (!owner || typeof fsImpl.chown !== 'function') return;
  for (const targetPath of targetPaths) {
    await fsImpl.chown(targetPath, owner.uid, owner.gid).catch(() => {});
  }
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

function helperContainerDirectory(presetName) {
  return path.posix.join(MCP_HELPER_CONTAINER_ROOT, String(presetName));
}

async function writeHelperScript({
  directory,
  fileName,
  content,
  modes = PRIVATE_HELPER_MODES,
  fsImpl = fs,
}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: modes.directory });
  await fsImpl.chmod(directory, modes.directory).catch(() => {});
  const scriptPath = path.join(directory, requireSafeHelperFileName(fileName));
  await fsImpl.writeFile(scriptPath, content, { mode: modes.script });
  await fsImpl.chmod(scriptPath, modes.script).catch(() => {});
  return scriptPath;
}

async function writeHelperEnvFile({
  directory,
  helperEnv,
  modes = PRIVATE_HELPER_MODES,
  fsImpl = fs,
}) {
  const env = readStringRecord(helperEnv);
  if (Object.keys(env).length === 0) {
    return null;
  }

  await fsImpl.mkdir(directory, { recursive: true, mode: modes.directory });
  await fsImpl.chmod(directory, modes.directory).catch(() => {});
  const envPath = path.join(directory, HELPER_ENV_FILE_NAME);
  const content = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n');
  await fsImpl.writeFile(envPath, `${content}\n`, { mode: modes.env });
  await fsImpl.chmod(envPath, modes.env).catch(() => {});
  return envPath;
}

async function ensureDockerHelperDirectoryAccessible(runtimeHomePath, directory, fsImpl = fs) {
  const cloudcliDirectory = path.join(runtimeHomePath, '.cloudcli');
  const helperRoot = path.join(cloudcliDirectory, 'mcp-helpers');
  await fsImpl.mkdir(directory, { recursive: true, mode: DOCKER_HELPER_MODES.directory });

  // These paths may have been created as 0700 by an earlier release. Repair
  // every parent below the private runtime home so the container UID can
  // traverse the bind mount and execute/read the generated helper files.
  for (const helperDirectory of [cloudcliDirectory, helperRoot, directory]) {
    await fsImpl.chmod(helperDirectory, DOCKER_HELPER_MODES.directory).catch(() => {});
  }
  return [cloudcliDirectory, helperRoot, directory];
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

export async function materializeMcpHelperConfig({
  config,
  helperScript = null,
  hostDirectory,
  commandDirectory = hostDirectory,
  runtimeMode = 'local',
  runtimeOwner = null,
  fsImpl = fs,
} = {}) {
  const helperEnv = readStringRecord(config?.helperEnv);
  const normalizedScript = helperScript
    ? normalizeUploadedHelperScript({
        originalName: helperScript.fileName ?? helperScript.file_name,
        content: helperScript.content,
      })
    : null;
  if (!config?.headersHelper || (!normalizedScript && Object.keys(helperEnv).length === 0)) {
    return withoutHelperEnv(config);
  }
  if (!hostDirectory || !path.isAbsolute(hostDirectory)) {
    throw createHttpError('MCP helper host directory must be absolute', 500);
  }
  if (!commandDirectory) {
    throw createHttpError('MCP helper command directory is required', 500);
  }

  const dockerMode = runtimeMode === 'docker';
  const modes = dockerMode ? DOCKER_HELPER_MODES : PRIVATE_HELPER_MODES;
  const owner = dockerMode ? normalizeHelperOwner(runtimeOwner) : null;
  const scriptPath = normalizedScript
    ? await writeHelperScript({
        directory: hostDirectory,
        fileName: normalizedScript.fileName,
        content: normalizedScript.content,
        modes,
        fsImpl,
      })
    : null;
  const envPath = await writeHelperEnvFile({
    directory: hostDirectory,
    helperEnv,
    modes,
    fsImpl,
  });
  await applyHelperOwnership(fsImpl, [scriptPath, envPath, hostDirectory].filter(Boolean), owner);
  return withHelperWorkingDirectory(config, commandDirectory, { includeEnvFile: Boolean(envPath) });
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
  return materializeMcpHelperConfig({
    config: { ...config, name: presetName },
    helperScript: script,
    hostDirectory: helperDirectory,
    commandDirectory: helperDirectory,
    fsImpl,
  });
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
  for (const install of installs) {
    // A globally visible DataAgent template may reference an MCP owned by the
    // DataAgent tenant. The joined install row carries that source tenant.
    const sourceTenantId = requirePositiveInteger(install.tenant_id || tenantId, 'tenantId');
    const serverName = install.name;
    const currentConfig = nextServers[serverName];
    if (!currentConfig || typeof currentConfig !== 'object' || Array.isArray(currentConfig)) continue;
    const preset = multitenancy.mcpPresets?.getPresetById?.({
      tenantId: sourceTenantId,
      presetId: install.preset_id,
    });
    const presetHeadersHelper = typeof preset?.config?.headersHelper === 'string'
      ? preset.config.headersHelper.trim()
      : '';
    const effectiveConfig = !Object.prototype.hasOwnProperty.call(currentConfig, 'headersHelper') && presetHeadersHelper
      ? { ...currentConfig, headersHelper: presetHeadersHelper }
      : currentConfig;
    if (!effectiveConfig.headersHelper) continue;
    const helperEnv = readStringRecord(preset?.config?.helperEnv);

    const script = getPresetHelperScript(multitenancy, {
      tenantId: sourceTenantId,
      presetId: install.preset_id,
    });
    if (!script && Object.keys(helperEnv).length === 0) {
      nextServers[serverName] = withoutHelperEnv(effectiveConfig);
      continue;
    }

    const isDockerRuntime = runtimeMode === 'docker' && runtimeHomePath;
    const hostDirectory = isDockerRuntime
      ? helperDirectoryForRuntime(runtimeHomePath, serverName)
      : helperDirectoryForPreset(helperRoot, { tenantId: sourceTenantId, presetId: install.preset_id });
    const commandDirectory = isDockerRuntime
      ? helperContainerDirectory(serverName)
      : hostDirectory;
    const modes = isDockerRuntime ? DOCKER_HELPER_MODES : PRIVATE_HELPER_MODES;
    const owner = isDockerRuntime ? normalizeHelperOwner(runtimeOwner) : null;

    const dockerHelperDirectories = isDockerRuntime
      ? await ensureDockerHelperDirectoryAccessible(runtimeHomePath, hostDirectory, fsImpl)
      : [];

    const scriptPath = script
      ? await writeHelperScript({
        directory: hostDirectory,
        fileName: script.file_name,
        content: script.content,
        modes,
        fsImpl,
      })
      : null;
    const envPath = await writeHelperEnvFile({
      directory: hostDirectory,
      helperEnv,
      modes,
      fsImpl,
    });
    if (isDockerRuntime) {
      await applyHelperOwnership(fsImpl, [
        scriptPath,
        envPath,
        ...dockerHelperDirectories.reverse(),
      ].filter(Boolean), owner);
    }
    nextServers[serverName] = withHelperWorkingDirectory(
      effectiveConfig,
      commandDirectory,
      { includeEnvFile: Boolean(envPath) },
    );
  }
  return nextServers;
}
