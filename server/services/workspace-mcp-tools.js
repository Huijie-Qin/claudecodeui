import { multitenancyDb } from '../database/multitenancy-db.js';
import { USER_KEY_ENV_NAME } from '../database/user-env.js';

import {
  MCP_CONTAINER_CONFIG_PATH,
  WORKSPACE_MCP_CONFIG_FILE,
  toWorkspaceMcpServerConfig,
  toWorkspacePreset,
} from './mcp-presets.js';
import { resolvePresetProbeConfig } from './mcp-helper-scripts.js';
import {
  readMcpStatus,
  readWorkspaceMcpConfig,
  normalizeMcpServerConfigForProbeRuntime,
  probeHttpMcpServer,
  writeMcpStatus,
  writeWorkspaceMcpConfig,
} from './workspace-tools.js';

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const W3_NAME_ENV_NAME = 'W3_NAME';
const TENANT_ID_ENV_NAME = 'TENANT_ID';

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function getPublishedPreset(multitenancy, { tenantId, presetId }) {
  const preset = multitenancy.mcpPresets.getPresetById({
    tenantId: requirePositiveInteger(tenantId, 'tenantId'),
    presetId: requirePositiveInteger(presetId, 'presetId'),
  });
  if (!preset || preset.status !== 'published') {
    throw createHttpError('MCP preset not found', 404);
  }
  return preset;
}

function summarizePresets(presets) {
  return {
    available: presets.filter((preset) => !preset.installed).length,
    installed: presets.filter((preset) => preset.installed).length,
  };
}

function isWorkspaceVisiblePreset(row) {
  return row?.status === 'published'
    && row.last_test_status === 'healthy'
    && Number(row.tool_count || 0) > 0;
}

function getToolNames(tools) {
  return Array.from(new Set((Array.isArray(tools) ? tools : [])
    .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
    .filter(Boolean)));
}

function withUserToolPreference(preset, preference) {
  const availableToolNames = getToolNames(preset?.tools);
  const configuredAllowedToolNames = Array.isArray(preference?.allowedToolNames)
    ? preference.allowedToolNames
    : null;
  const allowedSet = new Set(configuredAllowedToolNames || availableToolNames);
  return {
    ...preset,
    toolSelectionConfigured: configuredAllowedToolNames !== null,
    allowedToolNames: availableToolNames.filter((toolName) => allowedSet.has(toolName)),
  };
}

function buildStatusEntry(preset, now = new Date()) {
  return {
    name: preset.name,
    status: preset.last_test_status === 'healthy' ? 'healthy' : 'unverified',
    phase: preset.last_test_status === 'healthy' ? 'tools_list' : 'admin_preset',
    error: preset.last_test_error || '',
    checkedAt: now.toISOString(),
    latencyMs: undefined,
    toolCount: Number(preset.tool_count || 0),
    tools: Array.isArray(preset.tools) ? preset.tools : [],
  };
}

async function getUserStore(users) {
  if (users) {
    return users;
  }

  const { userDb } = await import('../database/db.js');
  return userDb;
}

async function buildProbeHostEnv(users, userId, tenantId) {
  if (!userId) {
    return {};
  }
  const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');

  let userStore;
  let user;
  try {
    userStore = await getUserStore(users);
    user = typeof userStore?.getUserById === 'function'
      ? userStore.getUserById(userId)
      : null;
  } catch {
    return {};
  }
  const username = typeof user?.username === 'string' ? user.username.trim() : '';
  if (!username) {
    return {};
  }

  const env = {
    [W3_NAME_ENV_NAME]: username,
    [TENANT_ID_ENV_NAME]: String(normalizedTenantId),
  };
  let userEnv = {};
  try {
    userEnv = typeof userStore?.getEnvForUser === 'function'
      ? userStore.getEnvForUser(userId)
      : {};
  } catch {
    userEnv = {};
  }
  const userKey = userEnv?.[USER_KEY_ENV_NAME];
  if (typeof userKey === 'string' && userKey.trim() !== '') {
    env[USER_KEY_ENV_NAME] = userKey;
  }
  return env;
}

async function withTemporaryProcessEnv(env, task) {
  const previousValues = new Map();

  for (const [key, value] of Object.entries(env)) {
    previousValues.set(key, {
      hadValue: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    process.env[key] = String(value);
  }

  try {
    return await task();
  } finally {
    for (const [key, previous] of previousValues) {
      if (previous.hadValue) {
        process.env[key] = previous.value;
      } else {
        delete process.env[key];
      }
    }
  }
}

function buildProbeStatusEntry(preset, probeResult, checkedAt) {
  return {
    name: preset.name,
    status: probeResult.status,
    phase: probeResult.phase,
    error: probeResult.error || '',
    checkedAt,
    latencyMs: probeResult.latencyMs,
    toolCount: Number(probeResult.toolCount || 0),
    tools: Array.isArray(probeResult.tools) ? probeResult.tools : [],
  };
}

function failedProbeResult(phase, error, startedAt) {
  return {
    status: 'probe_failed',
    phase,
    error: error instanceof Error ? error.message : String(error || 'MCP probe failed'),
    latencyMs: Date.now() - startedAt,
    toolCount: 0,
    tools: [],
  };
}

function createUnconfiguredProbe(preset, now) {
  return buildProbeStatusEntry(
    preset,
    failedProbeResult('config', `${preset.name} is installed but missing from ${WORKSPACE_MCP_CONFIG_FILE}`, Date.now()),
    now().toISOString(),
  );
}

async function probeInstalledWorkspacePresets({
  multitenancy,
  tenantId,
  workspaceId,
  workspacePath,
  presets,
  installsByPresetId,
  probe,
  resolveHelperConfig,
  users,
  env,
  now,
}) {
  const installedPresets = presets.filter((preset) => installsByPresetId.has(Number(preset.id)));
  if (!workspacePath || installedPresets.length === 0) {
    return new Map();
  }

  let config;
  let status;
  try {
    config = await readWorkspaceMcpConfig(workspacePath);
  } catch (error) {
    const probeEntries = installedPresets.map((preset) => [
      Number(preset.id),
      buildProbeStatusEntry(
        preset,
        failedProbeResult('config', error, Date.now()),
        now().toISOString(),
      ),
    ]);
    return new Map(probeEntries);
  }
  try {
    status = await readMcpStatus(workspacePath);
  } catch {
    status = { version: 1, servers: {} };
  }

  const probeEntries = [];
  for (const preset of installedPresets) {
    const startedAt = Date.now();
    const serverConfig = config.mcpServers?.[preset.name];
    if (!serverConfig) {
      probeEntries.push([Number(preset.id), createUnconfiguredProbe(preset, now)]);
      continue;
    }

    try {
      const installRow = installsByPresetId.get(Number(preset.id));
      const probeConfig = await resolveHelperConfig({
        tenantId,
        presetId: preset.id,
        presetName: preset.name,
        config: {
          ...serverConfig,
          name: preset.name,
        },
        multitenancy,
      });
      const runtimeProbeConfig = normalizeMcpServerConfigForProbeRuntime(probeConfig, { env });
      const probeEnv = await buildProbeHostEnv(users, installRow?.installed_by_user_id, tenantId);
      const probeResult = await withTemporaryProcessEnv(
        probeEnv,
        () => probe(runtimeProbeConfig),
      );
      probeEntries.push([Number(preset.id), buildProbeStatusEntry(preset, probeResult, now().toISOString())]);
    } catch (error) {
      probeEntries.push([
        Number(preset.id),
        buildProbeStatusEntry(
          preset,
          failedProbeResult('network', error, startedAt),
          now().toISOString(),
        ),
      ]);
    }
  }

  const probesByPresetId = new Map(probeEntries);
  const nextStatusServers = { ...status.servers };
  for (const preset of installedPresets) {
    const entry = probesByPresetId.get(Number(preset.id));
    if (!entry) continue;
    nextStatusServers[preset.name] = entry;
    if (typeof multitenancy.mcpInstalls?.recordProbe === 'function') {
      const updatedInstall = multitenancy.mcpInstalls.recordProbe({
        workspaceId,
        presetId: preset.id,
        probeStatus: entry.status,
        probeError: entry.error || null,
        toolCount: Number(entry.toolCount || 0),
        tools: Array.isArray(entry.tools) ? entry.tools : [],
      });
      installsByPresetId.set(Number(preset.id), updatedInstall);
    }
  }

  await writeMcpStatus(workspacePath, {
    version: 1,
    servers: nextStatusServers,
  }).catch(() => {});

  return probesByPresetId;
}

export function createWorkspaceMcpToolsService({
  multitenancy = multitenancyDb,
  probeHttpMcpServer: probe = probeHttpMcpServer,
  resolveHelperConfig = resolvePresetProbeConfig,
  users = null,
  env = process.env,
} = {}) {
  const listWorkspaceMcpPresetCatalog = async ({
    tenantId,
    workspaceId,
    userId = null,
    workspacePath,
    accessRole = 'view',
    now = () => new Date(),
  }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const presets = multitenancy.mcpPresets.listPresets({
      tenantId: normalizedTenantId,
      status: 'published',
    }).filter(isWorkspaceVisiblePreset);
    const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({
      workspaceId: normalizedWorkspaceId,
    });
    const installsByPresetId = new Map(installs.map((install) => [Number(install.preset_id), install]));
    const preferences = userId && typeof multitenancy.mcpToolPreferences?.listForUser === 'function'
      ? multitenancy.mcpToolPreferences.listForUser({
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
          userId: requirePositiveInteger(userId, 'userId'),
        })
      : [];
    const preferencesByPresetId = new Map(
      preferences.map((preference) => [Number(preference.preset_id), preference]),
    );
    const probesByPresetId = await probeInstalledWorkspacePresets({
      multitenancy,
      tenantId: normalizedTenantId,
      workspaceId: normalizedWorkspaceId,
      workspacePath,
      presets,
      installsByPresetId,
      probe,
      resolveHelperConfig,
      users,
      env,
      now,
    });
    const workspacePresets = presets.map((preset) => (
      withUserToolPreference(toWorkspacePreset(
        preset,
        installsByPresetId.get(Number(preset.id)),
        probesByPresetId.get(Number(preset.id)),
      ), preferencesByPresetId.get(Number(preset.id)))
    ));

    return {
      accessRole,
      canManage: accessRole === 'owner' || accessRole === 'edit',
      summary: summarizePresets(workspacePresets),
      presets: workspacePresets,
    };
  };

  const installWorkspaceMcpPreset = async ({
    tenantId,
    workspaceId,
    workspacePath,
    workspaceDisplayName,
    presetId,
    userId,
    now = () => new Date(),
  }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    const preset = getPublishedPreset(multitenancy, {
      tenantId: normalizedTenantId,
      presetId: normalizedPresetId,
    });
    const [config, status] = await Promise.all([
      readWorkspaceMcpConfig(workspacePath),
      readMcpStatus(workspacePath),
    ]);

    await Promise.all([
      writeWorkspaceMcpConfig(workspacePath, {
        ...config,
        mcpServers: {
          ...config.mcpServers,
          [preset.name]: toWorkspaceMcpServerConfig(preset.config),
        },
      }),
      writeMcpStatus(workspacePath, {
        version: 1,
        servers: {
          ...status.servers,
          [preset.name]: buildStatusEntry(preset, now()),
        },
      }),
    ]);

    const install = multitenancy.mcpInstalls.upsertInstall({
      workspaceId: normalizedWorkspaceId,
      presetId: normalizedPresetId,
      installedByUserId: normalizedUserId,
      probeStatus: preset.last_test_status || null,
      probeError: preset.last_test_error || null,
      toolCount: Number(preset.tool_count || 0),
      tools: Array.isArray(preset.tools) ? preset.tools : [],
    });
    const catalog = await listWorkspaceMcpPresetCatalog({
      tenantId: normalizedTenantId,
      workspaceId: normalizedWorkspaceId,
      userId: normalizedUserId,
      workspacePath,
      accessRole: 'edit',
    });

    return {
      installed: {
        presetId: normalizedPresetId,
        name: preset.name,
        status: install.status,
        writeTarget: `${workspaceDisplayName || normalizedWorkspaceId}/${WORKSPACE_MCP_CONFIG_FILE}`,
        containerPath: MCP_CONTAINER_CONFIG_PATH,
        appliesOn: 'next_agent_turn',
        toolCount: Number(preset.tool_count || 0),
      },
      summary: catalog.summary,
      presets: catalog.presets,
    };
  };

  const installPreinstalledWorkspaceMcpPresets = async ({
    tenantId,
    workspaceId,
    workspacePath,
    workspaceDisplayName,
    userId,
    preinstallScope = 'all_workspaces',
  }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const normalizedUserId = requirePositiveInteger(userId, 'userId');
    if (
      typeof multitenancy.mcpPresets?.listPresets !== 'function'
      || typeof multitenancy.mcpInstalls?.upsertInstall !== 'function'
    ) {
      return { installed: [], errors: [] };
    }

    const presets = multitenancy.mcpPresets.listPresets({
      tenantId: normalizedTenantId,
      status: 'published',
      preinstallScope,
    }).filter(isWorkspaceVisiblePreset);
    const installed = [];
    const errors = [];

    for (const preset of presets) {
      try {
        const result = await installWorkspaceMcpPreset({
          tenantId: normalizedTenantId,
          workspaceId: normalizedWorkspaceId,
          workspacePath,
          workspaceDisplayName,
          presetId: preset.id,
          userId: normalizedUserId,
        });
        installed.push(result.installed);
      } catch (error) {
        errors.push({
          presetId: preset.id,
          name: preset.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { installed, errors };
  };

  return {
    listWorkspaceMcpPresetCatalog,
    installWorkspaceMcpPreset,
    installPreinstalledWorkspaceMcpPresets,

    updateWorkspaceMcpToolPreference: ({
      tenantId,
      workspaceId,
      presetId,
      userId,
      allowedToolNames,
    }) => {
      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
      const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
      const normalizedUserId = requirePositiveInteger(userId, 'userId');
      const preset = getPublishedPreset(multitenancy, {
        tenantId: normalizedTenantId,
        presetId: normalizedPresetId,
      });
      const install = multitenancy.mcpInstalls.listInstallsForWorkspace({
        workspaceId: normalizedWorkspaceId,
      }).find((entry) => Number(entry.preset_id) === normalizedPresetId);
      if (!install) {
        throw createHttpError('MCP server is not installed in this workspace', 404);
      }
      if (!Array.isArray(allowedToolNames)) {
        throw createHttpError('allowedToolNames must be an array', 400);
      }

      const availableToolNames = getToolNames(
        install.last_probe_status === 'healthy' && Array.isArray(install.tools)
          ? install.tools
          : preset.tools,
      );
      const availableSet = new Set(availableToolNames);
      const normalizedAllowedToolNames = Array.from(new Set(allowedToolNames.map((toolName) => (
        typeof toolName === 'string' ? toolName.trim() : ''
      )).filter(Boolean)));
      const unknownToolNames = normalizedAllowedToolNames.filter((toolName) => !availableSet.has(toolName));
      if (unknownToolNames.length > 0) {
        throw createHttpError(`Unknown MCP tools: ${unknownToolNames.join(', ')}`, 400);
      }

      const saved = multitenancy.mcpToolPreferences.setForUser({
        tenantId: normalizedTenantId,
        workspaceId: normalizedWorkspaceId,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        allowedToolNames: normalizedAllowedToolNames,
      });
      return {
        presetId: normalizedPresetId,
        serverName: preset.name,
        toolSelectionConfigured: true,
        allowedToolNames: saved.allowedToolNames,
        appliesOn: 'next_agent_turn',
      };
    },

    removeWorkspaceMcpPreset: async ({
      tenantId,
      workspaceId,
      workspacePath,
      presetId,
      userId = null,
    }) => {
      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
      const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
      const preset = getPublishedPreset(multitenancy, {
        tenantId: normalizedTenantId,
        presetId: normalizedPresetId,
      });
      const [config, status] = await Promise.all([
        readWorkspaceMcpConfig(workspacePath),
        readMcpStatus(workspacePath),
      ]);
      const nextServers = { ...config.mcpServers };
      const nextStatus = { ...status.servers };
      delete nextServers[preset.name];
      delete nextStatus[preset.name];

      await Promise.all([
        writeWorkspaceMcpConfig(workspacePath, {
          ...config,
          mcpServers: nextServers,
        }),
        writeMcpStatus(workspacePath, {
          version: 1,
          servers: nextStatus,
        }),
      ]);

      const removed = multitenancy.mcpInstalls.removeInstall({
        workspaceId: normalizedWorkspaceId,
        presetId: normalizedPresetId,
      });
      const catalog = await listWorkspaceMcpPresetCatalog({
        tenantId: normalizedTenantId,
        workspaceId: normalizedWorkspaceId,
        userId,
        workspacePath,
        accessRole: 'edit',
      });

      return {
        removed: {
          presetId: normalizedPresetId,
          name: preset.name,
          status: removed?.status || 'removed',
        },
        summary: catalog.summary,
        presets: catalog.presets,
      };
    },
  };
}

export const workspaceMcpToolsService = createWorkspaceMcpToolsService();
