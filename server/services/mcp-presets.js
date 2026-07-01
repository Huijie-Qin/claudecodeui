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
const MCP_PREINSTALL_SCOPES = new Set(['none', 'all_workspaces']);
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

function normalizePreinstallScope(input = {}) {
  const value = input.preinstallScope ?? (input.preinstall === true ? 'all_workspaces' : 'none');
  if (!MCP_PREINSTALL_SCOPES.has(value)) {
    throw createHttpError('preinstallScope must be one of: none, all_workspaces', 400);
  }
  return value;
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

function normalizeTargetTenantIds(targetTenantIds) {
  if (!Array.isArray(targetTenantIds)) {
    throw createHttpError('targetTenantIds must be an array', 400);
  }

  const ids = [];
  const seen = new Set();
  for (const targetTenantId of targetTenantIds) {
    const normalized = requirePositiveInteger(targetTenantId, 'targetTenantId');
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }

  if (ids.length === 0) {
    throw createHttpError('Select at least one target tenant', 400);
  }

  return ids;
}

function copyPresetTestState(multitenancy, { sourcePreset, targetPreset, targetTenantId, userId }) {
  if (!sourcePreset.last_test_status) {
    return targetPreset;
  }

  return multitenancy.mcpPresets.recordPresetTest({
    tenantId: targetTenantId,
    presetId: targetPreset.id,
    status: sourcePreset.last_test_status,
    error: sourcePreset.last_test_error || null,
    toolCount: Number(sourcePreset.tool_count || 0),
    tools: Array.isArray(sourcePreset.tools) ? sourcePreset.tools : [],
    dockerCompatible: sourcePreset.docker_compatible === 1 || sourcePreset.docker_compatible === true,
    updatedByUserId: userId,
  });
}

function logPresetTest(event, details = {}) {
  console.log(`[MCP Preset Test] ${event}`, details);
}

function summarizePresetTestConfig(config = {}) {
  return {
    name: config.name || null,
    url: config.url || null,
    hasHeadersHelper: typeof config.headersHelper === 'string' && config.headersHelper.trim() !== '',
    staticHeaderKeys: config.headers && typeof config.headers === 'object'
      ? Object.keys(config.headers)
      : [],
    helperEnvKeys: config.helperEnv && typeof config.helperEnv === 'object'
      ? Object.keys(config.helperEnv)
      : [],
  };
}

function summarizePresetTestEnv(env = {}) {
  const userKey = env[USER_KEY_ENV_NAME];
  return {
    W3_NAME: env[W3_NAME_ENV_NAME] || null,
    USER_KEY: userKey
      ? {
          present: true,
          length: String(userKey).length,
          isHex64: /^[0-9a-f]{64}$/i.test(String(userKey)),
          startsWithSecurity: String(userKey).startsWith('security:'),
        }
      : { present: false },
  };
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
    preinstallScope: normalizePreinstallScope(input),
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
    preinstallScope: row.preinstall_scope || 'none',
    preinstall: row.preinstall_scope === 'all_workspaces',
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

export function toWorkspacePreset(row, installRow = null, probe = null) {
  if (!row) return null;
  const installed = installRow?.status === 'installed';
  const probeStatus = probe?.status || installRow?.last_probe_status || null;
  const connectionStatus = !installed
    ? 'available'
    : probeStatus === 'healthy'
      ? 'connected'
      : probeStatus === 'probe_failed'
        ? 'probe_failed'
        : 'unverified';
  const liveTools = Array.isArray(probe?.tools) ? probe.tools : null;
  const installedTools = Array.isArray(installRow?.tools) ? installRow.tools : null;
  const publishedTools = Array.isArray(row.tools) ? row.tools : [];
  const tools = probeStatus === 'healthy'
    ? liveTools || installedTools || publishedTools
    : publishedTools;
  const toolCount = probeStatus === 'healthy'
    ? Number(probe?.toolCount ?? installRow?.tool_count ?? row.tool_count ?? 0)
    : Number(row.tool_count || 0);

  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    description: row.description || '',
    transport: row.transport || 'http',
    status: installed ? connectionStatus : 'available',
    dockerCompatible: row.docker_compatible === 1,
    toolCount,
    tools,
    installed,
    connectionStatus,
    probeStatus,
    probePhase: probe?.phase || null,
    probeError: probe?.error || installRow?.last_probe_error || null,
    probeLatencyMs: typeof probe?.latencyMs === 'number' ? probe.latencyMs : null,
    lastProbedAt: probe?.checkedAt || null,
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

  const findPresetByName = ({ tenantId, name }) => {
    const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
    return multitenancy.mcpPresets.listPresets({
      tenantId: normalizedTenantId,
      includeDisabled: true,
    }).find((preset) => preset.name === name) || null;
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
        preinstallScope: normalized.preinstallScope,
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
        preinstallScope: normalized.preinstallScope,
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
      logPresetTest('start', {
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        userId: normalizedUserId,
        presetName: normalizedInput?.name || preset.name,
        hasDraftInput: Boolean(normalizedInput),
        config: summarizePresetTestConfig(baseProbeConfig),
      });
      const probeEnv = await buildPresetTestHostEnv(users, normalizedUserId);
      logPresetTest('env_ready', {
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        userId: normalizedUserId,
        env: summarizePresetTestEnv(probeEnv),
      });
      const probeResult = await withTemporaryProcessEnv(probeEnv, async () => {
        const probeConfig = await resolveHelperConfig({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          presetName: normalizedInput?.name || preset.name,
          config: baseProbeConfig,
          multitenancy,
        });
        logPresetTest('probe_config_resolved', {
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          userId: normalizedUserId,
          config: summarizePresetTestConfig(probeConfig),
        });
        return probe(probeConfig);
      });
      logPresetTest('probe_result', {
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        userId: normalizedUserId,
        status: probeResult.status,
        phase: probeResult.phase,
        toolCount: Number(probeResult.toolCount || 0),
        error: probeResult.error || null,
      });
      if (normalizedInput) {
        multitenancy.mcpPresets.updatePreset({
          tenantId: requirePositiveInteger(tenantId, 'tenantId'),
          presetId: requirePositiveInteger(presetId, 'presetId'),
          name: normalizedInput.name,
          displayName: normalizedInput.displayName,
          description: normalizedInput.description,
          config: normalizedInput.config,
          preinstallScope: normalizedInput.preinstallScope,
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

    deleteHelperScript: ({ tenantId, presetId, userId }) => {
      const existing = getExistingPreset({ tenantId, presetId });
      multitenancy.mcpPresetHelperScripts.deleteScript({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
      });
      const updated = multitenancy.mcpPresets.updatePreset({
        tenantId: requirePositiveInteger(tenantId, 'tenantId'),
        presetId: requirePositiveInteger(presetId, 'presetId'),
        name: existing.name,
        displayName: existing.display_name,
        description: existing.description || '',
        config: existing.config,
        preinstallScope: existing.preinstall_scope || 'none',
        status: normalizeEditableStatus(existing.status, existing.status === 'disabled' ? 'disabled' : 'draft'),
        updatedByUserId: requirePositiveInteger(userId, 'userId'),
      });
      return toAdminPreset(updated, null);
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

    copyPresetToTenants: ({ tenantId, presetId, targetTenantIds, userId }) => {
      const sourceTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const normalizedPresetId = requirePositiveInteger(presetId, 'presetId');
      const normalizedUserId = requirePositiveInteger(userId, 'userId');
      const sourcePreset = getExistingPreset({
        tenantId: sourceTenantId,
        presetId: normalizedPresetId,
      });
      const sourceHelperScript = getPresetHelperScript(multitenancy, {
        tenantId: sourceTenantId,
        presetId: normalizedPresetId,
      });
      const targets = normalizeTargetTenantIds(targetTenantIds);
      const results = [];

      for (const targetTenantId of targets) {
        if (targetTenantId === sourceTenantId) {
          results.push({
            tenantId: targetTenantId,
            action: 'skipped',
            reason: 'source_tenant',
          });
          continue;
        }

        const targetTenant = typeof multitenancy.tenants?.getTenantById === 'function'
          ? multitenancy.tenants.getTenantById(targetTenantId)
          : { id: targetTenantId };
        if (!targetTenant) {
          results.push({
            tenantId: targetTenantId,
            action: 'skipped',
            reason: 'tenant_not_found',
          });
          continue;
        }

        try {
          const existingPreset = findPresetByName({
            tenantId: targetTenantId,
            name: sourcePreset.name,
          });
          const status = normalizeStatus(sourcePreset.status, 'draft');
          let targetPreset = existingPreset
            ? multitenancy.mcpPresets.updatePreset({
                tenantId: targetTenantId,
                presetId: existingPreset.id,
                name: sourcePreset.name,
                displayName: sourcePreset.display_name,
                description: sourcePreset.description || '',
                config: sourcePreset.config,
                preinstallScope: sourcePreset.preinstall_scope || 'none',
                status,
                updatedByUserId: normalizedUserId,
              })
            : multitenancy.mcpPresets.createPreset({
                tenantId: targetTenantId,
                name: sourcePreset.name,
                displayName: sourcePreset.display_name,
                description: sourcePreset.description || '',
                config: sourcePreset.config,
                preinstallScope: sourcePreset.preinstall_scope || 'none',
                status,
                createdByUserId: normalizedUserId,
              });
          targetPreset = copyPresetTestState(multitenancy, {
            sourcePreset,
            targetPreset,
            targetTenantId,
            userId: normalizedUserId,
          });

          if (sourceHelperScript) {
            savePresetHelperScript({
              tenantId: targetTenantId,
              presetId: targetPreset.id,
              userId: normalizedUserId,
              originalName: sourceHelperScript.file_name,
              content: sourceHelperScript.content,
              multitenancy,
            });
          } else {
            multitenancy.mcpPresetHelperScripts.deleteScript({
              tenantId: targetTenantId,
              presetId: targetPreset.id,
            });
          }

          const finalPreset = multitenancy.mcpPresets.getPresetById({
            tenantId: targetTenantId,
            presetId: targetPreset.id,
          });
          results.push({
            tenantId: targetTenantId,
            action: existingPreset ? 'updated' : 'created',
            preset: toAdminPreset(
              finalPreset,
              getPresetHelperScript(multitenancy, {
                tenantId: targetTenantId,
                presetId: targetPreset.id,
              }),
            ),
          });
        } catch (error) {
          results.push({
            tenantId: targetTenantId,
            action: 'failed',
            error: error instanceof Error ? error.message : 'Failed to copy MCP preset',
          });
        }
      }

      const summary = results.reduce((current, result) => ({
        ...current,
        [result.action]: current[result.action] + 1,
      }), {
        total: results.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
      });

      return {
        sourcePreset: toAdminPreset(sourcePreset, sourceHelperScript),
        results,
        summary,
      };
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
