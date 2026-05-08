import { multitenancyDb } from '../database/multitenancy-db.js';

import { probeHttpMcpServer } from './workspace-tools.js';

export const WORKSPACE_MCP_CONFIG_FILE = '.mcp.json';
export const MCP_CONTAINER_CONFIG_PATH = '/workspace/.mcp.json';

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function createHttpError(message, statusCode = 400, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createHttpError(`${name} must be a non-empty string`, 400);
  }
  return value.trim();
}

function normalizeServerName(value) {
  const name = requireNonEmptyString(value, 'name');
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    throw createHttpError('MCP server name must use letters, numbers, dots, underscores, or hyphens', 400);
  }
  return name;
}

function normalizeHttpUrl(value) {
  const url = requireNonEmptyString(value, 'url');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw createHttpError('MCP server URL is invalid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createHttpError('MCP server URL must start with http:// or https://', 400);
  }
  return url;
}

function normalizeHeaders(headers) {
  if (headers == null || headers === '') return undefined;
  if (typeof headers !== 'object' || Array.isArray(headers)) {
    throw createHttpError('headers must be an object', 400);
  }

  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerName = requireNonEmptyString(key, 'header name');
    if (value == null || value === '') continue;
    normalized[headerName] = String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStatus(status, fallback = 'draft') {
  const value = status || fallback;
  if (!['draft', 'published', 'disabled'].includes(value)) {
    throw createHttpError('status must be one of: draft, published, disabled', 400);
  }
  return value;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

export function normalizePresetInput(input = {}) {
  const config = input.config && typeof input.config === 'object' ? input.config : input;
  const type = String(config.type || config.transport || 'http').trim().toLowerCase();
  if (type !== 'http') {
    throw createHttpError('Only HTTP MCP presets are supported', 400);
  }

  return {
    name: normalizeServerName(input.name ?? config.name),
    displayName: requireNonEmptyString(input.displayName ?? input.display_name, 'displayName'),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    config: compactObject({
      type: 'http',
      url: normalizeHttpUrl(config.url),
      headers: normalizeHeaders(config.headers),
    }),
  };
}

export function toAdminPreset(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    displayName: row.display_name,
    description: row.description || '',
    transport: row.transport || 'http',
    config: row.config || {},
    status: row.status,
    dockerCompatible: row.docker_compatible === 1,
    lastTestStatus: row.last_test_status || null,
    lastTestError: row.last_test_error || null,
    lastTestedAt: row.last_tested_at || null,
    toolCount: Number(row.tool_count || 0),
    tools: Array.isArray(row.tools) ? row.tools : [],
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toWorkspacePreset(row, installRow = null) {
  if (!row) return null;
  const installed = installRow?.status === 'installed';
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description || '',
    transport: row.transport || 'http',
    status: installed ? 'installed' : 'available',
    dockerCompatible: row.docker_compatible === 1,
    toolCount: Number(row.tool_count || 0),
    tools: Array.isArray(row.tools) ? row.tools : [],
    installed,
    userSetupRequired: false,
    source: 'admin_published',
    containerPath: MCP_CONTAINER_CONFIG_PATH,
    lastTestedAt: row.last_tested_at || null,
    installedAt: installRow?.installed_at || null,
    appliesOn: 'next_agent_turn',
  };
}

export function createMcpPresetService({
  multitenancy = multitenancyDb,
  probeHttpMcpServer: probe = probeHttpMcpServer,
} = {}) {
  const getExistingPreset = ({ tenantId, presetId }) => {
    const preset = multitenancy.mcpPresets.getPresetById({
      tenantId: requirePositiveInteger(tenantId, 'tenantId'),
      presetId: requirePositiveInteger(presetId, 'presetId'),
    });
    if (!preset) {
      throw createHttpError('MCP preset not found', 404);
    }
    return preset;
  };

  return {
    listAdminPresets: ({ tenantId, includeDisabled = true, status = null }) => {
      return multitenancy.mcpPresets.listPresets({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        includeDisabled,
        status,
      }).map(toAdminPreset);
    },

    createPreset: ({ tenantId, userId, input }) => {
      const normalized = normalizePresetInput(input);
      const preset = multitenancy.mcpPresets.createPreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        name: normalized.name,
        displayName: normalized.displayName,
        description: normalized.description,
        config: normalized.config,
        status: normalizeStatus(input?.status, 'draft'),
        createdByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(preset);
    },

    updatePreset: ({ tenantId, presetId, userId, input }) => {
      getExistingPreset({ tenantId, presetId });
      const normalized = normalizePresetInput(input);
      const preset = multitenancy.mcpPresets.updatePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        name: normalized.name,
        displayName: normalized.displayName,
        description: normalized.description,
        config: normalized.config,
        status: normalizeStatus(input?.status, 'draft'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(preset);
    },

    testPreset: async ({ tenantId, presetId, userId, input = null }) => {
      const preset = getExistingPreset({ tenantId, presetId });
      const normalizedInput = input ? normalizePresetInput(input) : null;
      const probeResult = await probe(normalizedInput?.config || preset.config);
      if (normalizedInput) {
        return {
          ...toAdminPreset(preset),
          config: normalizedInput.config,
          lastTestStatus: probeResult.status,
          lastTestError: probeResult.error || null,
          lastTestedAt: new Date().toISOString(),
          toolCount: Number(probeResult.toolCount || 0),
          tools: Array.isArray(probeResult.tools) ? probeResult.tools : [],
          dockerCompatible: probeResult.status === 'healthy',
          transient: true,
          probe: probeResult,
        };
      }

      const tested = multitenancy.mcpPresets.recordPresetTest({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        status: probeResult.status,
        error: probeResult.error || null,
        toolCount: Number(probeResult.toolCount || 0),
        tools: Array.isArray(probeResult.tools) ? probeResult.tools : [],
        dockerCompatible: probeResult.status === 'healthy',
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return {
        ...toAdminPreset(tested),
        probe: probeResult,
      };
    },

    publishPreset: ({ tenantId, presetId, userId }) => {
      const preset = getExistingPreset({ tenantId, presetId });
      if (preset.last_test_status !== 'healthy') {
        throw createHttpError('MCP preset requires a successful test before publish', 400);
      }
      const published = multitenancy.mcpPresets.publishPreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(published);
    },

    disablePreset: ({ tenantId, presetId, userId }) => {
      getExistingPreset({ tenantId, presetId });
      const disabled = multitenancy.mcpPresets.disablePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(disabled);
    },

    deletePreset: ({ tenantId, presetId }) => {
      getExistingPreset({ tenantId, presetId });
      return multitenancy.mcpPresets.deletePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
      });
    },

    listWorkspacePresets: ({ tenantId, workspaceId }) => {
      const presets = multitenancy.mcpPresets.listPresets({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        status: 'published',
      });
      const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({
        workspaceId: requirePositiveInteger(workspaceId, 'workspaceId'),
      });
      const installsByPresetId = new Map(installs.map((row) => [Number(row.preset_id), row]));
      return presets.map((preset) => toWorkspacePreset(preset, installsByPresetId.get(Number(preset.id))));
    },
  };
}

export const mcpPresetService = createMcpPresetService();
