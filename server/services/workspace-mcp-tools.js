import { multitenancyDb } from '../database/multitenancy-db.js';

import {
  MCP_CONTAINER_CONFIG_PATH,
  WORKSPACE_MCP_CONFIG_FILE,
  toWorkspacePreset,
} from './mcp-presets.js';
import {
  readMcpStatus,
  readWorkspaceMcpConfig,
  writeMcpStatus,
  writeWorkspaceMcpConfig,
} from './workspace-tools.js';

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

export function createWorkspaceMcpToolsService({ multitenancy = multitenancyDb } = {}) {
  const listWorkspaceMcpPresetCatalog = ({ tenantId, workspaceId, accessRole = 'view' }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
    const presets = multitenancy.mcpPresets.listPresets({
      tenantId: normalizedTenantId,
      status: 'published',
    });
    const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({
      workspaceId: normalizedWorkspaceId,
    });
    const installsByPresetId = new Map(installs.map((install) => [Number(install.preset_id), install]));
    const workspacePresets = presets.map((preset) => (
      toWorkspacePreset(preset, installsByPresetId.get(Number(preset.id)))
    ));

    return {
      accessRole,
      canManage: accessRole === 'owner' || accessRole === 'edit',
      summary: summarizePresets(workspacePresets),
      presets: workspacePresets,
    };
  };

  return {
    listWorkspaceMcpPresetCatalog,

    installWorkspaceMcpPreset: async ({
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
            [preset.name]: preset.config,
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
      const catalog = listWorkspaceMcpPresetCatalog({
        tenantId: normalizedTenantId,
        workspaceId: normalizedWorkspaceId,
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
    },

    removeWorkspaceMcpPreset: async ({
      tenantId,
      workspaceId,
      workspacePath,
      presetId,
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
      const catalog = listWorkspaceMcpPresetCatalog({
        tenantId: normalizedTenantId,
        workspaceId: normalizedWorkspaceId,
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
