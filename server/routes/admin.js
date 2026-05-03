import express from 'express';

import { userDb } from '../database/db.js';
import { multitenancyDb } from '../database/multitenancy-db.js';
import { runtimeMonitorService } from '../services/runtime-monitor.js';

function requireSystemAdmin(req, res, next) {
  if (req.user?.is_system_admin !== 1 && req.user?.is_system_admin !== true) {
    return res.status(403).json({ error: 'System admin access required' });
  }
  return next();
}

function sendRouteError(res, error, fallbackMessage) {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const isConstraint = error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT';
  const statusCode = isConstraint ? 409 : 400;
  return res.status(statusCode).json({ error: message || fallbackMessage });
}

function buildRuntimeFilters(query = {}) {
  const filters = {
    tenantId: query.tenantId == null ? undefined : Number(query.tenantId),
    userId: query.userId == null ? undefined : Number(query.userId),
    workspaceId: query.workspaceId == null ? undefined : Number(query.workspaceId),
    provider: query.provider == null ? undefined : String(query.provider),
    status: query.status == null ? undefined : String(query.status),
    dockerState: query.dockerState == null ? undefined : String(query.dockerState),
    q: query.q == null ? undefined : String(query.q),
    limit: query.limit == null ? undefined : Number(query.limit),
    offset: query.offset == null ? undefined : Number(query.offset),
  };

  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  );
}

function isDockerError(error) {
  return error?.code === 'DOCKER_UNAVAILABLE'
    || error?.code === 'DOCKER_ERROR'
    || /\bdocker\b/i.test(error?.message || '');
}

export function createAdminRouter(
  multitenancy = multitenancyDb,
  users = userDb,
  runtimeMonitor = runtimeMonitorService,
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

  router.put('/tenants/:tenantId/users/:userId', (req, res) => {
    try {
      const membership = multitenancy.memberships.upsertMembership({
        tenantId: Number(req.params.tenantId),
        userId: Number(req.params.userId),
        role: req.body?.role || 'member',
        permission: req.body?.permission || 'view',
        status: req.body?.status || 'active',
      });
      res.json({ membership });
    } catch (error) {
      sendRouteError(res, error, 'Failed to update tenant access');
    }
  });

  router.get('/runtimes', async (req, res) => {
    try {
      const result = await runtimeMonitor.listRuntimes(buildRuntimeFilters(req.query));
      res.json(result);
    } catch (error) {
      sendRouteError(res, error, 'Failed to list runtimes');
    }
  });

  router.get('/runtimes/summary', async (req, res) => {
    try {
      const summary = await runtimeMonitor.getSummary(buildRuntimeFilters(req.query));
      res.json({ summary });
    } catch (error) {
      sendRouteError(res, error, 'Failed to load runtime summary');
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
export default createAdminRouter(multitenancyDb, userDb, runtimeMonitorService);
