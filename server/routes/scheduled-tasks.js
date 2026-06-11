import express from 'express';

import { resolveTenantIdFromRequest } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';

const router = express.Router();

function getTenantId(req) {
  const tenantId = Number(req.tenant?.id ?? resolveTenantIdFromRequest(req));
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    const error = new Error('tenantId is required');
    error.statusCode = 400;
    throw error;
  }
  return tenantId;
}

function getUserId(req) {
  const userId = Number(req.user?.id ?? req.user?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    const error = new Error('userId is required');
    error.statusCode = 400;
    throw error;
  }
  return userId;
}

function getService(req) {
  const service = req.app?.locals?.scheduledSessionTasks;
  if (!service) {
    const error = new Error('Scheduled task service is not available');
    error.statusCode = 503;
    throw error;
  }
  return service;
}

function handleError(res, error, fallbackMessage) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error(fallbackMessage, error);
  }
  return res.status(statusCode).json({
    success: false,
    error: error?.message || fallbackMessage,
  });
}

function requireWorkspaceEdit({ tenantId, userId, workspaceId }) {
  return workspaceAccess.requireWorkspace({
    tenantId,
    userId,
    workspaceId,
    requireEdit: true,
  });
}

router.get('/', (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const workspaceId = req.query.workspaceId ? Number(req.query.workspaceId) : null;
    if (workspaceId) {
      requireWorkspaceEdit({ tenantId, userId, workspaceId });
    }
    const tasks = getService(req).list({ tenantId, userId, workspaceId });
    res.json({ success: true, tasks });
  } catch (error) {
    return handleError(res, error, 'Failed to list scheduled tasks');
  }
});

router.post('/', (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const workspaceId = Number(req.body?.workspaceId);
    requireWorkspaceEdit({ tenantId, userId, workspaceId });

    const task = getService(req).create({
      tenantId,
      userId,
      workspaceId,
      provider: req.body?.provider,
      name: req.body?.name,
      prompt: req.body?.prompt,
      scheduleType: req.body?.scheduleType,
      scheduleCron: req.body?.scheduleCron,
      intervalMinutes: req.body?.intervalMinutes,
      nextRunAt: req.body?.nextRunAt,
      startAfterAt: req.body?.startAfterAt,
      enabled: req.body?.enabled,
      model: req.body?.model,
      permissionMode: req.body?.permissionMode,
      toolsSettings: req.body?.toolsSettings,
      sessionId: req.body?.sessionId,
    });

    res.status(201).json({ success: true, task });
  } catch (error) {
    return handleError(res, error, 'Failed to create scheduled task');
  }
});

router.put('/:taskId', (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const service = getService(req);
    const existing = service.getOwned({ tenantId, userId, taskId: req.params.taskId });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Scheduled task not found' });
    }

    requireWorkspaceEdit({ tenantId, userId, workspaceId: existing.workspaceId });
    const task = service.update({
      tenantId,
      userId,
      taskId: req.params.taskId,
      patch: req.body || {},
    });
    res.json({ success: true, task });
  } catch (error) {
    return handleError(res, error, 'Failed to update scheduled task');
  }
});

router.delete('/:taskId', (req, res) => {
  try {
    const tenantId = getTenantId(req);
    const userId = getUserId(req);
    const service = getService(req);
    const existing = service.getOwned({ tenantId, userId, taskId: req.params.taskId });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Scheduled task not found' });
    }

    requireWorkspaceEdit({ tenantId, userId, workspaceId: existing.workspaceId });
    service.remove({ tenantId, userId, taskId: req.params.taskId });
    res.json({ success: true });
  } catch (error) {
    return handleError(res, error, 'Failed to delete scheduled task');
  }
});

export default router;
