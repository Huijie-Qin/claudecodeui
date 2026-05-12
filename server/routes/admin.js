import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import express from 'express';
import multer from 'multer';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { mcpPresetService } from '../services/mcp-presets.js';
import { buildTenantWorkspacePath } from '../services/workspace-projects.js';
import { runtimeMonitorService } from '../services/runtime-monitor.js';
import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROOT_WORKSPACE_NAME = 'root-workspace';
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT || os.homedir();
const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const SOURCE_SKILLS_PATH = path.join(APP_ROOT, 'default_files');

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

function createInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashInvitationToken(token) {
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

function parsePositiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${name} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyDefaultSkills(workspacePath) {
  await fs.mkdir(workspacePath, { recursive: true });

  if (await pathExists(SOURCE_SKILLS_PATH)) {
    const entries = await fs.readdir(SOURCE_SKILLS_PATH, { withFileTypes: true });
    await Promise.all(entries.map((entry) => fs.cp(
      path.join(SOURCE_SKILLS_PATH, entry.name),
      path.join(workspacePath, entry.name),
      {
        recursive: true,
        force: true,
      },
    )));
  }
}

async function ensureDefaultRootWorkspace(multitenancy, { tenantId, userId }) {
  const workspacePath = buildTenantWorkspacePath({
    workspacesRoot: WORKSPACES_ROOT,
    tenantId,
    userId,
    requestedPath: ROOT_WORKSPACE_NAME,
  });

  await fs.mkdir(workspacePath, { recursive: true });

  const existingWorkspace = multitenancy.workspaces.getWorkspaceByTenantSlug({
    tenantId,
    ownerUserId: userId,
    slug: ROOT_WORKSPACE_NAME,
  });

  const workspace = existingWorkspace || multitenancy.workspaces.createWorkspace({
    tenantId,
    ownerUserId: userId,
    slug: ROOT_WORKSPACE_NAME,
    displayName: ROOT_WORKSPACE_NAME,
    path: workspacePath,
  });

  await copyDefaultSkills(workspace.path);
  return workspace;
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
) {
  const router = express.Router();
  router.use(requireSystemAdmin);

  router.get('/tenants', (req, res) => {
    res.json({ tenants: multitenancy.tenants.listTenants() });
  });

  router.post('/tenants', (req, res) => {
    try {
      const tenant = multitenancy.tenants.createTenant({
        code: req.body?.code,
        name: req.body?.name,
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

  router.get('/users', (req, res) => {
    const rows = users.listUsers ? users.listUsers() : [];
    res.json({ users: rows });
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
      const membership = multitenancy.memberships.upsertMembership({
        tenantId,
        userId,
        role: req.body?.role || 'member',
        permission: req.body?.permission || 'view',
        status: req.body?.status || 'active',
      });
      const defaultWorkspace = membership.status === 'active'
        ? await ensureDefaultRootWorkspace(multitenancy, { tenantId, userId })
        : null;
      res.json({ membership, defaultWorkspace });
    } catch (error) {
      sendRouteError(res, error, 'Failed to update tenant access');
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

  router.put('/mcp-presets/:presetId', (req, res) => {
    try {
      const tenantId = parsePositiveId(req.body?.tenantId ?? req.query?.tenantId, 'tenantId');
      const preset = mcpPresets.updatePreset({
        tenantId,
        presetId: parsePositiveId(req.params.presetId, 'presetId'),
        userId: req.user.id,
        input: req.body,
      });
      return res.json({ preset });
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
export default createAdminRouter(multitenancyDb, userDb, runtimeMonitorService, mcpPresetService);
