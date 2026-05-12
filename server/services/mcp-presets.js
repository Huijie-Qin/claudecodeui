import { multitenancyDb } from '../database/multitenancy-db.js';
import { USER_KEY_ENV_NAME } from '../database/user-env.js';

import {
  buildMcpHelperScriptMetadata,
  getPresetHelperScript,
  resolvePresetProbeConfig,
  savePresetHelperScript,
} from './mcp-helper-scripts.js';
import { probeHttpMcpServer } from './workspace-tools.js';

export const WORKSPACE_MCP_CONFIG_FILE = '.mcp.json';
export const MCP_CONTAINER_CONFIG_PATH = '/workspace/.mcp.json';

const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const W3_NAME_ENV_NAME = 'W3_NAME';

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

function normalizeHeadersHelper(headersHelper) {
  if (headersHelper == null || headersHelper === '') return undefined;
  if (typeof headersHelper !== 'string') {
    throw createHttpError('headersHelper must be a string', 400);
  }
  return headersHelper.trim() || undefined;
}

function normalizeHelperEnv(helperEnv) {
  if (helperEnv == null || helperEnv === '') return undefined;
  if (typeof helperEnv !== 'object' || Array.isArray(helperEnv)) {
    throw createHttpError('helperEnv must be an object', 400);
  }

  const normalized = {};
  for (const [key, value] of Object.entries(helperEnv)) {
    const envName = requireNonEmptyString(key, 'helper environment variable name');
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(envName)) {
      throw createHttpError('helperEnv names must use shell-safe environment variable syntax', 400);
    }
    if (value == null || value === '') continue;
    normalized[envName] = String(value);
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

function normalizeEditableStatus(status, fallback = 'draft') {
  const value = normalizeStatus(status, fallback);
  return value === 'published' ? 'draft' : value;
}

function isWorkspaceVisiblePreset(row) {
  return row?.status === 'published'
    && row.last_test_status === 'healthy'
    && Number(row.tool_count || 0) > 0;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

async function getPresetTestUserStore(users) {
  if (users) {
    return users;
  }

  const { userDb } = await import('../database/db.js');
  return userDb;
}

async function getPresetTestUserContext(users, userId) {
  const userStore = await getPresetTestUserStore(users);
  const user = typeof userStore?.getUserById === 'function'
    ? userStore.getUserById(userId)
    : null;
  const username = user?.username;

  if (typeof username !== 'string' || username.trim() === '') {
    throw createHttpError('User not found', 404);
  }

  return {
    username: username.trim(),
    userEnv: typeof userStore?.getEnvForUser === 'function'
      ? userStore.getEnvForUser(userId)
      : {},
  };
}

async function buildPresetTestHostEnv(users, userId) {
  const normalizedUserId = requirePositiveInteger(userId, 'userId');
  const { username, userEnv } = await getPresetTestUserContext(users, normalizedUserId);
  const env = {
    [W3_NAME_ENV_NAME]: username,
  };

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
      headersHelper: normalizeHeadersHelper(config.headersHelper),
      helperEnv: normalizeHelperEnv(config.helperEnv),
    }),
  };
}

export function toWorkspaceMcpServerConfig(config = {}) {
  const { helperEnv, ...safeConfig } = config || {};
  return safeConfig;
}

export function toAdminPreset(row, helperScript = null) {
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
    helperScript: buildMcpHelperScriptMetadata(helperScript),
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
  users = null,
  probeHttpMcpServer: probe = probeHttpMcpServer,
  resolveHelperConfig = resolvePresetProbeConfig,
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
      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      return multitenancy.mcpPresets.listPresets({
        tenantId: normalizedTenantId,
        includeDisabled,
        status,
      }).map((preset) => toAdminPreset(
        preset,
        getPresetHelperScript(multitenancy, { tenantId: normalizedTenantId, presetId: preset.id }),
      ));
    },

    createPreset: ({ tenantId, userId, input }) => {
      const normalized = normalizePresetInput(input);
      const preset = multitenancy.mcpPresets.createPreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        name: normalized.name,
        displayName: normalized.displayName,
        description: normalized.description,
        config: normalized.config,
        status: normalizeEditableStatus(input?.status, 'draft'),
        createdByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(preset, getPresetHelperScript(multitenancy, { tenantId, presetId: preset.id }));
    },

    updatePreset: ({ tenantId, presetId, userId, input }) => {
      const existing = getExistingPreset({ tenantId, presetId });
      const normalized = normalizePresetInput(input);
      const preset = multitenancy.mcpPresets.updatePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        name: normalized.name,
        displayName: normalized.displayName,
        description: normalized.description,
        config: normalized.config,
        status: normalizeEditableStatus(input?.status, existing.status === 'disabled' ? 'disabled' : 'draft'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(preset, getPresetHelperScript(multitenancy, { tenantId, presetId: preset.id }));
    },

    testPreset: async ({ tenantId, presetId, userId, input = null }) => {
      const normalizedUserId = requirePositiveInteger(userId, 'userId');
      const preset = getExistingPreset({ tenantId, presetId });
      const normalizedInput = input ? normalizePresetInput(input) : null;
      const baseProbeConfig = normalizedInput
        ? { ...normalizedInput.config, name: normalizedInput.name }
        : { ...preset.config, name: preset.name };
      const probeEnv = await buildPresetTestHostEnv(users, normalizedUserId);
      const probeResult = await withTemporaryProcessEnv(probeEnv, async () => {
        const probeConfig = await resolveHelperConfig({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          presetName: normalizedInput?.name || preset.name,
          config: baseProbeConfig,
          multitenancy,
        });
        return probe(probeConfig);
      });
      if (normalizedInput) {
        multitenancy.mcpPresets.updatePreset({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          name: normalizedInput.name,
          displayName: normalizedInput.displayName,
          description: normalizedInput.description,
          config: normalizedInput.config,
          status: normalizeEditableStatus(input?.status, preset.status === 'disabled' ? 'disabled' : 'draft'),
          updatedByUserId: normalizedUserId,
        });
      }

      const tested = multitenancy.mcpPresets.recordPresetTest({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        status: probeResult.status,
        error: probeResult.error || null,
        toolCount: Number(probeResult.toolCount || 0),
        tools: Array.isArray(probeResult.tools) ? probeResult.tools : [],
        dockerCompatible: probeResult.status === 'healthy',
        updatedByUserId: normalizedUserId,
      });
      return {
        ...toAdminPreset(tested, getPresetHelperScript(multitenancy, { tenantId, presetId })),
        probe: probeResult,
      };
    },

    publishPreset: ({ tenantId, presetId, userId }) => {
      const preset = getExistingPreset({ tenantId, presetId });
      if (preset.last_test_status !== 'healthy') {
        throw createHttpError('MCP preset requires a successful test before publish', 400);
      }
      if (Number(preset.tool_count || 0) <= 0) {
        throw createHttpError('MCP preset must expose at least one tool before publish', 400);
      }
      const published = multitenancy.mcpPresets.publishPreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(published, getPresetHelperScript(multitenancy, { tenantId, presetId }));
    },

    disablePreset: ({ tenantId, presetId, userId }) => {
      getExistingPreset({ tenantId, presetId });
      const disabled = multitenancy.mcpPresets.disablePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(disabled, getPresetHelperScript(multitenancy, { tenantId, presetId }));
    },

    deletePreset: ({ tenantId, presetId }) => {
      getExistingPreset({ tenantId, presetId });
      return multitenancy.mcpPresets.deletePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
      });
    },

    uploadHelperScript: ({ tenantId, presetId, userId, originalName, content }) => {
      getExistingPreset({ tenantId, presetId });
      savePresetHelperScript({
        tenantId,
        presetId,
        userId,
        originalName,
        content,
        multitenancy,
      });
      const preset = getExistingPreset({ tenantId, presetId });
      return toAdminPreset(preset, getPresetHelperScript(multitenancy, { tenantId, presetId }));
    },

    listWorkspacePresets: ({ tenantId, workspaceId }) => {
      const presets = multitenancy.mcpPresets.listPresets({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        status: 'published',
      }).filter(isWorkspaceVisiblePreset);
      const installs = multitenancy.mcpInstalls.listInstallsForWorkspace({
        workspaceId: requirePositiveInteger(workspaceId, 'workspaceId'),
      });
      const installsByPresetId = new Map(installs.map((row) => [Number(row.preset_id), row]));
      return presets.map((preset) => toWorkspacePreset(preset, installsByPresetId.get(Number(preset.id))));
    },
  };
}

export const mcpPresetService = createMcpPresetService();
