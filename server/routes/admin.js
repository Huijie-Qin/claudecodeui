import crypto from 'crypto';

import express from 'express';
import multer from 'multer';

import { aiMrSubmissionsDb, userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { ensureDefaultRootWorkspace } from '../services/default-root-workspace.js';
import { mcpPresetService } from '../services/mcp-presets.js';
import { skillPresetService } from '../services/skill-presets.js';
import { platformAnalyticsService } from '../services/platform-analytics.js';
import { runtimeMonitorService } from '../services/runtime-monitor.js';
import { buildAdminAnalyticsSummary, buildAdminAnalyticsUsers } from '../services/admin-analytics.js';
import { buildMcpToolUsageSummary } from '../services/mcp-tool-usage.js';
import { createWorkspaceMcpToolsService } from '../services/workspace-mcp-tools.js';
import { hookConfigService } from '../services/hook-configs.js';
import { createRequestedHookExamples, listRequestedHookExamples } from '../services/hook-examples.js';
import { createHookSkillCatalogService } from '../services/hook-skill-catalog.js';
import {
  FEATURE_FLAGS,
  featureFlagsService,
  shouldShowExperimentalFeatures,
} from '../services/feature-flags.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_USER_ENV_UPDATES = 500;
const ANTHROPIC_BASE_URL_ENV_NAME = 'ANTHROPIC_BASE_URL';
const ANTHROPIC_MODEL_ENV_NAME = 'ANTHROPIC_MODEL';
const ANTHROPIC_AUTH_TOKEN_ENV_NAME = 'ANTHROPIC_AUTH_TOKEN';
const DAS_ENV_NAME = 'DAS';
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireSystemAdmin(req, res, next) {
  if (req.user?.is_system_admin !== 1 && req.user?.is_system_admin !== true) {
    return res.status(403).json({ error: 'System admin access required' });
  }
  return next();
}

function sendRouteError(res, error, fallbackMessage) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const isConstraint = error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT';
  const statusCode = error?.statusCode || (isConstraint ? 409 : 400);
  return res.status(statusCode).json({ error: message || fallbackMessage });
}

function broadcastFeatureFlags(req, features) {
  const message = JSON.stringify({
    type: 'feature-flags-updated',
    features,
    timestamp: new Date().toISOString(),
  });
  req.app?.locals?.chatClients?.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(message);
      } catch (error) {
        console.warn('Failed to broadcast feature flag update:', error?.message || error);
      }
    }
  });
}

function createInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashInvitationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createPasswordResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashPasswordResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function buildInvitationUrl(req, token) {
  const origin = req.get('origin')?.trim()?.replace(/\/$/, '');
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin}/invite/${encodeURIComponent(token)}`;
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}/invite/${encodeURIComponent(token)}`;
}

function buildPasswordResetUrl(req, token) {
  const origin = req.get('origin')?.trim()?.replace(/\/$/, '');
  if (origin && /^https?:\/\//i.test(origin)) {
    return `${origin}/reset-password/${encodeURIComponent(token)}`;
  }

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}/reset-password/${encodeURIComponent(token)}`;
}

function createInvitationPayload(req, users, { userId, username }) {
  const invitationToken = createInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();

  const result = userId != null
    ? users.createInvitationForUser({
      userId,
      tokenHash: hashInvitationToken(invitationToken),
      createdByUserId: req.user.id,
      expiresAt,
    })
    : users.createInvitedUser({
      username,
      tokenHash: hashInvitationToken(invitationToken),
      createdByUserId: req.user.id,
      expiresAt,
    });

  if (!result) {
    return null;
  }

  return {
    user: result.user,
    invitation: {
      url: buildInvitationUrl(req, invitationToken),
      expires_at: result.invitation?.expires_at || expiresAt,
    },
  };
}

class RuntimeFilterValidationError extends Error {
  constructor() {
    super('Invalid runtime monitor filters');
    this.name = 'RuntimeFilterValidationError';
  }
}

const VALID_RUNTIME_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);
const VALID_RUNTIME_STATUSES = new Set(['pending', 'active', 'idle', 'failed', 'deleted']);
const VALID_DOCKER_STATES = new Set(['running', 'exited', 'missing', 'unknown']);
const helperScriptUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 64 * 1024,
    files: 1,
  },
});
const hookSkillUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
  },
});

function parseRuntimeFilterInteger(value, { min }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new RuntimeFilterValidationError();
  }
  return parsed;
}

function parseRuntimeFilterEnum(value, validValues) {
  const parsed = String(value);
  if (!validValues.has(parsed)) {
    throw new RuntimeFilterValidationError();
  }
  return parsed;
}

function buildRuntimeFilters(query = {}) {
  const filters = {
    tenantId: query.tenantId == null ? undefined : parseRuntimeFilterInteger(query.tenantId, { min: 1 }),
    userId: query.userId == null ? undefined : parseRuntimeFilterInteger(query.userId, { min: 1 }),
    workspaceId: query.workspaceId == null ? undefined : parseRuntimeFilterInteger(query.workspaceId, { min: 1 }),
    provider: query.provider == null ? undefined : parseRuntimeFilterEnum(query.provider, VALID_RUNTIME_PROVIDERS),
    status: query.status == null ? undefined : parseRuntimeFilterEnum(query.status, VALID_RUNTIME_STATUSES),
    dockerState: query.dockerState == null ? undefined : parseRuntimeFilterEnum(query.dockerState, VALID_DOCKER_STATES),
    q: query.q == null ? undefined : String(query.q),
    limit: query.limit == null ? undefined : parseRuntimeFilterInteger(query.limit, { min: 1 }),
    offset: query.offset == null ? undefined : parseRuntimeFilterInteger(query.offset, { min: 0 }),
  };

  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  );
}

function parseAnalyticsDays(value) {
  if (value == null || value === '') return 30;
  const parsed = Number(value);
  if (![7, 30, 90].includes(parsed)) {
    const error = new Error('days must be one of: 7, 30, 90');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseAnalyticsTenantIds(value) {
  if (value == null || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => Number(item))
    .filter((item, index, values) => (
      Number.isInteger(item) &&
      item > 0 &&
      values.indexOf(item) === index
    ));
}

function parsePositiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${name} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseOptionalPositiveId(value, name) {
  if (value == null || value === '') return undefined;
  return parsePositiveId(value, name);
}

function parsePositiveIntegerWithFallback(value, fallback, name) {
  if (value == null || value === '') return fallback;
  return parsePositiveId(value, name);
}

function resolveAdminTenantCode(multitenancy, tenantId) {
  const tenant = multitenancy.tenants?.getTenantById?.(tenantId);
  if (!tenant?.code) {
    const error = new Error('Tenant code is required');
    error.statusCode = 400;
    throw error;
  }
  return String(tenant.code);
}

function resolveAdminAccountId(req, users) {
  if (req.user?.username) {
    return String(req.user.username);
  }

  const user = typeof users?.getUserById === 'function'
    ? users.getUserById(req.user?.id)
    : null;
  if (user?.username) {
    return String(user.username);
  }

  const error = new Error('User username is required');
  error.statusCode = 400;
  throw error;
}

function parseBoundedInteger(value, { name, min, max, fallback }) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} must be an integer between ${min} and ${max}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function buildAiCodeStatsFilters(query = {}) {
  return {
    tenantId: parseOptionalPositiveId(query.tenantId, 'tenantId'),
    userId: parseOptionalPositiveId(query.userId, 'userId'),
    from: query.from == null || query.from === '' ? undefined : String(query.from),
    to: query.to == null || query.to === '' ? undefined : String(query.to),
  };
}

function parsePositiveIdList(value, name) {
  if (!Array.isArray(value)) {
    const error = new Error(`${name} must be an array`);
    error.statusCode = 400;
    throw error;
  }

  const seen = new Set();
  return value.map((item) => parsePositiveId(item, name)).filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function buildLegacyClaudeEnvPatch(body = {}) {
  const env = {};
  if (body.anthropicBaseUrl != null) env[ANTHROPIC_BASE_URL_ENV_NAME] = body.anthropicBaseUrl;
  if (body.anthropicModel != null) env[ANTHROPIC_MODEL_ENV_NAME] = body.anthropicModel;
  if (body.anthropicAuthToken != null) env[ANTHROPIC_AUTH_TOKEN_ENV_NAME] = body.anthropicAuthToken;
  if (body.das != null) env[DAS_ENV_NAME] = body.das;
  return env;
}

function parseClaudeEnvPatch(body = {}) {
  const rawEnv = body.env && typeof body.env === 'object' && !Array.isArray(body.env)
    ? body.env
    : buildLegacyClaudeEnvPatch(body);
  const env = {};

  for (const [rawName, rawValue] of Object.entries(rawEnv)) {
    const name = String(rawName || '').trim();
    if (!name) {
      const error = new Error('Claude environment field names are required');
      error.statusCode = 400;
      throw error;
    }
    if (!ENV_NAME_PATTERN.test(name)) {
      const error = new Error('Claude environment field names must use shell-safe syntax');
      error.statusCode = 400;
      throw error;
    }
    env[name] = rawValue == null ? '' : String(rawValue);
  }

  if (Object.keys(env).length === 0) {
    const error = new Error('At least one Claude environment field name is required');
    error.statusCode = 400;
    throw error;
  }

  return env;
}

function parseClaudeEnvVisibility(body = {}, env = {}) {
  const rawVisibility = body.visibility && typeof body.visibility === 'object' && !Array.isArray(body.visibility)
    ? body.visibility
    : {};

  return Object.fromEntries(
    Object.keys(env).map((name) => [name, rawVisibility[name] === true]),
  );
}

function parseClaudeEnvEncrypted(body = {}, env = {}) {
  const rawEncrypted = body.encrypted && typeof body.encrypted === 'object' && !Array.isArray(body.encrypted)
    ? body.encrypted
    : {};

  return Object.fromEntries(
    Object.keys(env).map((name) => [name, rawEncrypted[name] === true]),
  );
}

function summarizeBatchResults(results) {
  return {
    total: results.length,
    succeeded: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
  };
}

function createPasswordResetPayload(req, users, { userId }) {
  const resetToken = createPasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

  const result = users.createPasswordResetForUser({
    userId,
    tokenHash: hashPasswordResetToken(resetToken),
    createdByUserId: req.user.id,
    expiresAt,
  });

  if (!result) {
    return null;
  }

  return {
    user: result.user,
    passwordReset: {
      url: buildPasswordResetUrl(req, resetToken),
      expires_at: result.passwordReset?.expires_at || expiresAt,
    },
  };
}

function isDockerError(error) {
  return error?.code === 'DOCKER_UNAVAILABLE'
    || error?.code === 'DOCKER_ERROR'
    || /\bdocker\b/i.test(error?.message || '');
}

function sendRuntimeMonitorError(res, error, fallbackMessage) {
  if (error instanceof RuntimeFilterValidationError) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: fallbackMessage });
}

export function createAdminRouter(
  multitenancy = multitenancyDb,
  users = userDb,
  runtimeMonitor = runtimeMonitorService,
  mcpPresets = mcpPresetService,
  workspaceMcpTools = createWorkspaceMcpToolsService({ multitenancy }),
  platformAnalytics = platformAnalyticsService,
  aiSubmissions = aiMrSubmissionsDb,
  skillPresets = skillPresetService,
  hookConfigs = hookConfigService,
  featureFlags = featureFlagsService,
  showExperimentalFeatures = shouldShowExperimentalFeatures,
  hookSkillCatalog = createHookSkillCatalogService(),
) {
  const router = express.Router();
  router.use(requireSystemAdmin);

  router.get('/feature-flags', (req, res) => {
    res.json({
      features: featureFlags.getAll(),
      showExperimentalFeatures: showExperimentalFeatures(),
    });
  });

  router.put('/feature-flags/agent-graph', (req, res) => {
    if (!showExperimentalFeatures()) {
      return res.status(404).json({ error: 'Experimental feature settings are disabled' });
    }
    try {
      const features = featureFlags.setEnabled(FEATURE_FLAGS.AGENT_GRAPH, req.body?.enabled);
      broadcastFeatureFlags(req, features);
      res.json({ features });
    } catch (error) {
      sendRouteError(res, error, 'Failed to update Agent Graph feature flag');
    }
  });

  const upsertTenantUserAccess = async ({ tenantId, userId, body }) => {
    const membership = multitenancy.memberships.upsertMembership({
      tenantId,
      userId,
      role: body?.role || 'member',
      permission: body?.permission || 'view',
      status: body?.status || 'active',
    });
    const defaultWorkspace = membership.status === 'active'
      ? await ensureDefaultRootWorkspace({
        multitenancy,
        users,
        workspaceMcpTools,
        tenantId,
        userId,
      })
      : null;

    return { membership, defaultWorkspace };
  };

  router.get('/tenants', (req, res) => {
    res.json({ tenants: multitenancy.tenants.listTenants() });
  });

  router.get('/hooks', (req, res) => {
    try {
      return res.json({ hooks: hookConfigs.listHooks() });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to list Hooks');
    }
  });

  router.post('/hooks', (req, res) => {
    try {
      const hook = hookConfigs.createHook({ input: req.body, userId: req.user.id });
      return res.status(201).json({ hook });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create Hook');
    }
  });

  router.get('/hooks/examples', (req, res) => {
    try {
      return res.json({ examples: listRequestedHookExamples({ hookConfigs }) });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to list Hook examples');
    }
  });

  router.post('/hooks/examples', (req, res) => {
    try {
      const result = createRequestedHookExamples({
        hookConfigs,
        userId: req.user.id,
        exampleIds: req.body?.exampleIds,
      });
      return res.status(result.createdCount > 0 ? 201 : 200).json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create Hook examples');
    }
  });

  router.get('/hooks/settings', (req, res) => {
    try {
      return res.json(hookConfigs.getSettings());
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook settings');
    }
  });

  router.put('/hooks/settings', (req, res) => {
    try {
      return res.json(hookConfigs.updateSettings(req.body));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update Hook settings');
    }
  });

  router.get('/hooks/resources', async (req, res) => {
    let resources;
    try {
      resources = hookConfigs.getResources();
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook resources');
    }
    try {
      const catalog = await hookSkillCatalog.listConfigurationSkills();
      return res.json({
        ...resources,
        skills: catalog.skills,
        skillSource: catalog.source,
      });
    } catch (error) {
      return res.json({
        ...resources,
        skills: [],
        skillSource: {
          ...(typeof hookSkillCatalog.getSource === 'function' ? hookSkillCatalog.getSource() : {}),
          available: false,
          error: error instanceof Error ? error.message : 'Failed to load built-in Hook Skills',
        },
      });
    }
  });

  router.post('/hooks/skills', (req, res) => {
    hookSkillUpload.single('file')(req, res, async (uploadError) => {
      try {
        if (uploadError) {
          const error = new Error(uploadError.message);
          error.statusCode = 400;
          throw error;
        }
        if (!req.file?.buffer) {
          const error = new Error('Skill file is required');
          error.statusCode = 400;
          throw error;
        }
        const skill = await hookSkillCatalog.uploadBuiltinSkill({
          fileName: req.file.originalname,
          fileBuffer: req.file.buffer,
          userId: req.user.id,
        });
        const catalog = await hookSkillCatalog.listConfigurationSkills();
        return res.status(201).json({
          skill,
          skills: catalog.skills,
          skillSource: catalog.source,
        });
      } catch (error) {
        return sendRouteError(res, error, 'Failed to upload built-in Hook Skill');
      }
    });
  });

  router.get('/hooks/:hookId', (req, res) => {
    try {
      const hook = hookConfigs.getHook(req.params.hookId);
      if (!hook) return res.status(404).json({ error: 'Hook not found' });
      return res.json({ hook });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook');
    }
  });

  router.put('/hooks/:hookId', (req, res) => {
    try {
      const hook = hookConfigs.updateHook({
        hookId: req.params.hookId,
        input: req.body,
        userId: req.user.id,
      });
      return res.json({ hook });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update Hook');
    }
  });

  router.post('/hooks/:hookId/publish', async (req, res) => {
    try {
      const draft = hookConfigs.getHook(req.params.hookId);
      if (!draft) return res.status(404).json({ error: 'Hook not found' });
      const hasSkillAction = draft.postActions.some((action) => action.type === 'invoke_skill');
      const validatedSkills = hasSkillAction
        ? await hookSkillCatalog.validateHookSkills({ hook: draft })
        : [];
      const hook = hookConfigs.publishHook({
        hookId: req.params.hookId,
        userId: req.user.id,
        validatedSkills,
      });
      return res.json({ hook });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to publish Hook');
    }
  });

  router.get('/hooks/:hookId/bindings', (req, res) => {
    try {
      return res.json(hookConfigs.listHookBindings(req.params.hookId));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook user bindings');
    }
  });

  router.put('/hooks/:hookId/bindings', (req, res) => {
    try {
      return res.json(hookConfigs.replaceHookBindings({
        hookId: req.params.hookId,
        scope: req.body?.scope,
        userIds: req.body?.userIds,
        tenantIds: req.body?.tenantIds,
        boundBy: req.user.id,
      }));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update Hook user bindings');
    }
  });

  router.get('/hooks/:hookId/executions', (req, res) => {
    try {
      return res.json({
        executions: hookConfigs.listExecutions(req.params.hookId, { limit: req.query.limit }),
      });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook executions');
    }
  });

  router.get('/hooks/:hookId/data-records', (req, res) => {
    try {
      return res.json({
        records: hookConfigs.listDataRecords(req.params.hookId, { limit: req.query.limit }),
      });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Hook data records');
    }
  });

  router.delete('/hooks/:hookId', (req, res) => {
    try {
      return res.json({ deleted: hookConfigs.deleteHook(req.params.hookId) });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete Hook');
    }
  });

  router.post('/tenants', (req, res) => {
    try {
      const tenant = multitenancy.tenants.createTenant({
        code: req.body?.code,
        name: req.body?.name,
        prodCode: req.body?.prodCode ?? req.body?.prod_code ?? null,
        status: req.body?.status || 'active',
      });

      multitenancy.memberships?.upsertMembership?.({
        tenantId: tenant.id,
        userId: req.user.id,
        role: 'system_admin',
        permission: 'edit',
        status: 'active',
      });

      res.status(201).json({ tenant });
    } catch (error) {
      sendRouteError(res, error, 'Failed to create tenant');
    }
  });

  router.put('/tenants/:tenantId', (req, res) => {
    try {
      if (typeof multitenancy.tenants?.updateTenantCodes !== 'function') {
        return res.status(501).json({ error: 'Tenant code updates are not available' });
      }

      const tenant = multitenancy.tenants.updateTenantCodes({
        id: Number(req.params.tenantId),
        code: req.body?.code,
        prodCode: req.body?.prodCode ?? req.body?.prod_code ?? null,
      });

      return res.json({ tenant });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update tenant codes');
    }
  });

  router.get('/users', (req, res) => {
    const rows = users.listUsers ? users.listUsers() : [];
    res.json({ users: rows });
  });

  router.get('/users/claude-env', (req, res) => {
    try {
      if (typeof users.listClaudeEnvForUsers !== 'function') {
        return res.status(501).json({ error: 'Claude environment list is not available' });
      }

      return res.json({ users: users.listClaudeEnvForUsers() });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load Claude environment');
    }
  });

  router.get('/memberships', (req, res) => {
    try {
      const filters = {};
      if (req.query?.tenantId != null) filters.tenantId = Number(req.query.tenantId);
      if (req.query?.userId != null) filters.userId = Number(req.query.userId);

      const memberships = multitenancy.memberships?.listMemberships
        ? multitenancy.memberships.listMemberships(filters)
        : [];
      res.json({ memberships });
    } catch (error) {
      sendRouteError(res, error, 'Failed to list tenant access');
    }
  });

  router.get('/analytics', (req, res) => {
    try {
      const analytics = platformAnalytics.getOverview({
        days: parseAnalyticsDays(req.query?.days),
        tenantIds: parseAnalyticsTenantIds(req.query?.tenantIds),
      });
      res.json({ analytics });
    } catch (error) {
      sendRouteError(res, error, 'Failed to load platform analytics');
    }
  });

  router.get('/analytics/summary', (req, res) => {
    try {
      const summary = buildAdminAnalyticsSummary({ rangeDays: req.query?.rangeDays });
      res.json(summary);
    } catch (error) {
      sendRouteError(res, error, 'Failed to load analytics summary');
    }
  });

  router.get('/analytics/users', (req, res) => {
    try {
      const usersSummary = buildAdminAnalyticsUsers({
        page: req.query?.page,
        pageSize: req.query?.pageSize,
        search: req.query?.search,
      });
      res.json(usersSummary);
    } catch (error) {
      sendRouteError(res, error, 'Failed to load analytics users');
    }
  });

  router.get('/mcp/tool-usage', (req, res) => {
    try {
      const summary = buildMcpToolUsageSummary({
        rangeDays: req.query?.rangeDays,
        provider: req.query?.provider,
      });
      res.json(summary);
    } catch (error) {
      sendRouteError(res, error, 'Failed to load MCP tool usage');
    }
  });

  router.get('/ai-code-stats', (req, res) => {
    try {
      const stats = aiSubmissions.getAdminStats(buildAiCodeStatsFilters(req.query));
      res.json({ stats });
    } catch (error) {
      sendRouteError(res, error, 'Failed to load AI code statistics');
    }
  });

  router.get('/ai-code-mrs', (req, res) => {
    try {
      const filters = buildAiCodeStatsFilters(req.query);
      const submissions = aiSubmissions.listAdminMrs({
        ...filters,
        status: req.query?.status == null || req.query.status === '' ? undefined : String(req.query.status),
        limit: parseBoundedInteger(req.query?.limit, {
          name: 'limit',
          min: 1,
          max: 500,
          fallback: 100,
        }),
        offset: parseBoundedInteger(req.query?.offset, {
          name: 'offset',
          min: 0,
          max: 1000000,
          fallback: 0,
        }),
      });
      res.json({ submissions });
    } catch (error) {
      sendRouteError(res, error, 'Failed to list AI code merge requests');
    }
  });

  router.post('/users', (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      if (username.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }

      if (typeof users.createInvitedUser !== 'function') {
        return res.status(501).json({ error: 'Invited user creation is not available' });
      }

      const payload = createInvitationPayload(req, users, { username });
      if (!payload) {
        return res.status(400).json({ error: 'Failed to create user invitation' });
      }

      return res.status(201).json(payload);
    } catch (error) {
      sendRouteError(res, error, 'Failed to create user invitation');
    }
  });

  router.post('/users/batch', (req, res) => {
    try {
      if (typeof users.createInvitedUser !== 'function') {
        return res.status(501).json({ error: 'Invited user creation is not available' });
      }

      const usernames = Array.isArray(req.body?.usernames)
        ? req.body.usernames.map((username) => String(username || '').trim()).filter(Boolean)
        : [];
      const seenUsernames = new Set();
      const dedupedUsernames = usernames.filter((username) => {
        const key = username.toLowerCase();
        if (seenUsernames.has(key)) return false;
        seenUsernames.add(key);
        return true;
      });

      if (dedupedUsernames.length === 0) {
        return res.status(400).json({ error: 'At least one username is required' });
      }

      const results = dedupedUsernames.map((username) => {
        try {
          if (username.length < 3) {
            throw new Error('Username must be at least 3 characters');
          }

          const payload = createInvitationPayload(req, users, { username });
          if (!payload) {
            throw new Error('Failed to create user invitation');
          }

          return { username, success: true, ...payload };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to create user invitation';
          return { username, success: false, error: message };
        }
      });

      return res.status(201).json({
        results,
        summary: summarizeBatchResults(results),
      });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create user invitations');
    }
  });

  router.post('/users/claude-env/batch', (req, res) => {
    try {
      if (typeof users.updateClaudeEnvForUsers !== 'function') {
        return res.status(501).json({ error: 'Claude environment updates are not available' });
      }

      const userIds = parsePositiveIdList(req.body?.userIds, 'userIds');
      if (userIds.length === 0) {
        return res.status(400).json({ error: 'At least one user is required' });
      }
      if (userIds.length > MAX_BATCH_USER_ENV_UPDATES) {
        return res.status(400).json({ error: `Batch Claude environment updates are limited to ${MAX_BATCH_USER_ENV_UPDATES} users` });
      }

      const env = parseClaudeEnvPatch(req.body);
      const visibility = parseClaudeEnvVisibility(req.body, env);
      const encrypted = parseClaudeEnvEncrypted(req.body, env);
      const results = users.updateClaudeEnvForUsers({ userIds, env, visibility, encrypted });

      return res.json({
        results,
        summary: summarizeBatchResults(results),
      });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update Claude environment');
    }
  });

  router.post('/users/:userId/invitation', (req, res) => {
    try {
      if (typeof users.createInvitationForUser !== 'function') {
        return res.status(501).json({ error: 'Invitation link creation is not available' });
      }

      const payload = createInvitationPayload(req, users, { userId: Number(req.params.userId) });
      if (!payload) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(201).json(payload);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create activation link');
    }
  });

  router.post('/users/:userId/password-reset', (req, res) => {
    try {
      if (typeof users.createPasswordResetForUser !== 'function') {
        return res.status(501).json({ error: 'Password reset link creation is not available' });
      }

      const payload = createPasswordResetPayload(req, users, { userId: Number(req.params.userId) });
      if (!payload) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.status(201).json(payload);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create password reset link');
    }
  });

  router.delete('/users/:userId', (req, res) => {
    try {
      const userId = Number(req.params.userId);
      if (userId === Number(req.user.id)) {
        return res.status(400).json({ error: 'You cannot delete your own user account' });
      }

      if (typeof users.deleteUser !== 'function') {
        return res.status(501).json({ error: 'User deletion is not available' });
      }

      const deleted = users.deleteUser(userId);
      if (!deleted) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({ success: true });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete user');
    }
  });

  router.put('/tenants/:tenantId/users/:userId', async (req, res) => {
    try {
      const tenantId = Number(req.params.tenantId);
      const userId = Number(req.params.userId);
      const { membership, defaultWorkspace } = await upsertTenantUserAccess({ tenantId, userId, body: req.body });
      res.json({ membership, defaultWorkspace });
    } catch (error) {
      sendRouteError(res, error, 'Failed to update tenant access');
    }
  });

  router.put('/tenant-users/batch', async (req, res) => {
    try {
      const tenantIds = parsePositiveIdList(req.body?.tenantIds, 'tenantIds');
      const userIds = parsePositiveIdList(req.body?.userIds, 'userIds');

      if (tenantIds.length === 0 || userIds.length === 0) {
        return res.status(400).json({ error: 'At least one tenant and one user are required' });
      }

      const operations = tenantIds.flatMap((tenantId) => userIds.map((userId) => ({ tenantId, userId })));
      if (operations.length > 500) {
        return res.status(400).json({ error: 'Batch tenant access updates are limited to 500 operations' });
      }

      const results = [];
      for (const operation of operations) {
        try {
          const { membership, defaultWorkspace } = await upsertTenantUserAccess({
            tenantId: operation.tenantId,
            userId: operation.userId,
            body: req.body,
          });
          results.push({ ...operation, success: true, membership, defaultWorkspace });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to update tenant access';
          results.push({ ...operation, success: false, error: message });
        }
      }

      return res.json({
        results,
        summary: summarizeBatchResults(results),
      });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update tenant access');
    }
  });

  router.delete('/tenants/:tenantId/users/:userId', (req, res) => {
    try {
      if (typeof multitenancy.memberships?.deleteMembership !== 'function') {
        return res.status(501).json({ error: 'Tenant access deletion is not available' });
      }

      const deleted = multitenancy.memberships.deleteMembership({
        tenantId: Number(req.params.tenantId),
        userId: Number(req.params.userId),
      });

      if (!deleted) {
        return res.status(404).json({ error: 'Tenant access not found' });
      }

      return res.json({ success: true });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete tenant access');
    }
  });

  router.get('/tenants/:tenantId/sql-check', (req, res) => {
    try {
      if (typeof multitenancy.sqlCheck?.getTenantConfig !== 'function') {
        return res.status(501).json({ error: 'SQL check configuration is not available' });
      }

      const tenantId = parsePositiveId(req.params.tenantId, 'tenantId');
      return res.json(multitenancy.sqlCheck.getTenantConfig(tenantId));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to load SQL check configuration');
    }
  });

  router.put('/tenants/:tenantId/sql-check', (req, res) => {
    try {
      if (typeof multitenancy.sqlCheck?.replaceTenantConfig !== 'function') {
        return res.status(501).json({ error: 'SQL check configuration is not available' });
      }

      const tenantId = parsePositiveId(req.params.tenantId, 'tenantId');
      const ruleIds = req.body?.ruleIds ?? req.body?.rule_ids;
      return res.json(multitenancy.sqlCheck.replaceTenantConfig({ tenantId, ruleIds }));
    } catch (error) {
      return sendRouteError(res, error, 'Failed to save SQL check configuration');
    }
  });

  router.get('/skill-presets/market', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.query?.tenantId, 'tenantId');
      const result = await skillPresets.searchMarketSkills({
        searchContent: req.query?.searchContent ?? req.query?.q ?? '',
        page: parsePositiveIntegerWithFallback(req.query?.page, 1, 'page'),
        pageSize: parsePositiveIntegerWithFallback(req.query?.pageSize, 20, 'pageSize'),
        tenantCode: resolveAdminTenantCode(multitenancy, tenantId),
        accountId: resolveAdminAccountId(req, users),
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to search Skill Market');
    }
  });

  router.get('/skill-presets', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.query?.tenantId, 'tenantId');
      const presets = skillPresets.listAdminPresets({ tenantId });
      return res.json({ presets });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to list Skill presets');
    }
  });

  router.post('/skill-presets', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId, 'tenantId');
      const preset = await skillPresets.createPreset({
        tenantId,
        userId: req.user.id,
        input: req.body,
        tenantCode: resolveAdminTenantCode(multitenancy, tenantId),
        accountId: resolveAdminAccountId(req, users),
      });
      return res.status(201).json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create Skill preset');
    }
  });

  router.put('/skill-presets/:presetId', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = await skillPresets.updatePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        input: req.body,
        tenantCode: resolveAdminTenantCode(multitenancy, tenantId),
        accountId: resolveAdminAccountId(req, users),
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update Skill preset');
    }
  });

  router.post('/skill-presets/:presetId/validate', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const result = await skillPresets.validatePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        tenantCode: resolveAdminTenantCode(multitenancy, tenantId),
        accountId: resolveAdminAccountId(req, users),
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to validate Skill preset');
    }
  });

  router.post('/skill-presets/:presetId/publish', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = skillPresets.publishPreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to publish Skill preset');
    }
  });

  router.post('/skill-presets/:presetId/copy', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const result = skillPresets.copyPresetToTenants({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        targetTenantIds: req.body?.targetTenantIds ?? req.body?.target_tenant_ids,
        userId: req.user.id,
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to copy Skill preset');
    }
  });

  router.post('/skill-presets/:presetId/apply', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const result = await skillPresets.applyPresetToExistingWorkspaces({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        tenantCode: resolveAdminTenantCode(multitenancy, tenantId),
        overwrite: req.body?.overwrite === true,
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to apply Skill preset');
    }
  });

  router.post('/skill-presets/:presetId/disable', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = skillPresets.disablePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to disable Skill preset');
    }
  });

  router.delete('/skill-presets/:presetId', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const deleted = skillPresets.deletePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
      });
      return res.json({ deleted });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete Skill preset');
    }
  });

  router.get('/mcp-presets', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.query?.tenantId, 'tenantId');
      const presets = mcpPresets.listAdminPresets({ tenantId });
      return res.json({ presets });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to list MCP presets');
    }
  });

  router.post('/mcp-presets', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId, 'tenantId');
      const preset = mcpPresets.createPreset({
        tenantId,
        userId: req.user.id,
        input: req.body,
      });
      return res.status(201).json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to create MCP preset');
    }
  });

  router.put('/mcp-presets/:presetId', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const { preset, sync } = await mcpPresets.updatePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        input: req.body,
      });
      return res.json({ preset, sync });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to update MCP preset');
    }
  });

  router.post('/mcp-presets/:presetId/test', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = await mcpPresets.testPreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        input: req.body?.url || req.body?.config ? req.body : null,
      });
      return res.json({ preset, probe: preset.probe, transient: preset.transient === true });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to test MCP preset');
    }
  });

  router.post('/mcp-presets/:presetId/publish', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = mcpPresets.publishPreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to publish MCP preset');
    }
  });

  router.post('/mcp-presets/:presetId/copy', async (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const targetTenantIds = req.body?.targetTenantIds ?? req.body?.target_tenant_ids;
      const result = await mcpPresets.copyPresetToTenants({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        targetTenantIds,
        userId: req.user.id,
      });
      return res.json(result);
    } catch (error) {
      return sendRouteError(res, error, 'Failed to copy MCP preset');
    }
  });

  router.post('/mcp-presets/:presetId/helper-script', (req, res) => {
    helperScriptUpload.single('script')(req, res, (uploadError) => {
      try {
        if (uploadError) {
          const error = new Error(uploadError.code === 'LIMIT_FILE_SIZE'
            ? 'Helper script must be 64KB or smaller'
            : uploadError.message);
          error.statusCode = 400;
          throw error;
        }
        if (!req.file?.buffer) {
          const error = new Error('Helper script file is required');
          error.statusCode = 400;
          throw error;
        }

        const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
        const preset = mcpPresets.uploadHelperScript({
          tenantId,
          presetId: parsePositiveId(req.params.presetId, 'presetId'),
          userId: req.user.id,
          originalName: req.file.originalname,
          content: req.file.buffer.toString('utf8'),
        });
        return res.status(201).json({ preset });
      } catch (error) {
        return sendRouteError(res, error, 'Failed to upload helper script');
      }
    });
  });

  router.delete('/mcp-presets/:presetId/helper-script', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = mcpPresets.deleteHelperScript({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete helper script');
    }
  });

  router.post('/mcp-presets/:presetId/disable', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = mcpPresets.disablePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
      });
      return res.json({ preset });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to disable MCP preset');
    }
  });

  router.delete('/mcp-presets/:presetId', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const deleted = mcpPresets.deletePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
      });
      return res.json({ deleted });
    } catch (error) {
      return sendRouteError(res, error, 'Failed to delete MCP preset');
    }
  });

  router.get('/runtimes', async (req, res) => {
    try {
      const result = await runtimeMonitor.listRuntimes(buildRuntimeFilters(req.query));
      res.json(result);
    } catch (error) {
      sendRuntimeMonitorError(res, error, 'Failed to list runtimes');
    }
  });

  router.get('/runtimes/summary', async (req, res) => {
    try {
      const summary = await runtimeMonitor.getSummary(buildRuntimeFilters(req.query));
      res.json({ summary });
    } catch (error) {
      sendRuntimeMonitorError(res, error, 'Failed to load runtime summary');
    }
  });

  router.post('/runtimes/:runtimeId/stop', async (req, res) => {
    try {
      const runtime = await runtimeMonitor.stopRuntime({
        runtimeId: req.params.runtimeId,
        adminUserId: req.user.id,
      });
      if (!runtime) {
        return res.status(404).json({ error: 'Runtime not found' });
      }
      return res.json({ runtime });
    } catch (error) {
      if (isDockerError(error)) {
        const message = error instanceof Error ? error.message : 'Docker runtime unavailable';
        return res.status(503).json({ error: message });
      }
      return sendRouteError(res, error, 'Failed to stop runtime');
    }
  });

  return router;
}

export { requireSystemAdmin };
export default createAdminRouter();
