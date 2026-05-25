import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import * as skillMarketService from '../services/skill-market.js';
import {
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
  handleWorkspaceError,
} from '../services/workspace-request.js';

export function createSkillMarketRouter({
  access = workspaceAccess,
  marketService = skillMarketService,
  tenantMiddleware = tenantContext,
  tenants = multitenancyDb.tenants,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/skills', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const skills = await marketService.listSkillMarket({
        workspacePath: workspace.path,
        searchContent: req.query?.searchContent ?? req.query?.q ?? '',
        page: req.query?.page,
        pageSize: req.query?.pageSize,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: isManageRole(accessRole),
        skills,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/skills/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const skill = await marketService.getSkillMarketDetail({
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: isManageRole(accessRole),
        skill,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/skills/:name/files', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const file = await marketService.viewMarketSkillFile({
        workspacePath: workspace.path,
        name: req.params.name,
        filePath: req.query?.filePath,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: isManageRole(accessRole),
        ...file,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/skills/:name/download', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const skill = await marketService.downloadMarketSkill({
        workspacePath: workspace.path,
        name: req.params.name,
        overwrite: req.body?.overwrite === true || req.query?.overwrite === 'true',
        tenantCode,
      });

      return res.status(201).json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        skill,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/skills/:name/submit', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const result = await marketService.publishMarketSkill({
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/skills/:name/publish-preview', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const result = await marketService.getMarketSkillPublishPreview({
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/skills/:name/publish', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const result = await marketService.publishMarketSkill({
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/skills/:name/import', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const result = await marketService.removeMarketSkill({
        workspacePath: workspace.path,
        name: req.params.name,
      });
      const skills = await marketService.listSkillMarket({
        workspacePath: workspace.path,
        currentUsername: req.user?.username,
        tenantCode,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        ...result,
        skills,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  return router;
}

function resolveWorkspace(req, access, { requireEdit }) {
  const tenantId = req.tenant?.id ?? getRequestTenantId(req);
  const userId = getRequestUserId(req);
  const workspaceId = getRequestWorkspaceId(req);

  if (!tenantId || !workspaceId || !userId) {
    const error = new Error('tenantId and workspaceId are required');
    error.statusCode = 400;
    throw error;
  }

  return access.requireWorkspace({
    tenantId,
    userId,
    workspaceId,
    requireEdit,
  });
}

function resolveTenantCode(req, tenants) {
  const tenantCode = req.tenant?.code
    ?? req.tenant?.tenantCode
    ?? req.tenant?.membership?.tenant_code
    ?? req.tenant?.membership?.tenantCode
    ?? req.tenant?.membership?.code;

  if (tenantCode) {
    return String(tenantCode);
  }

  const tenantId = req.tenant?.id ?? getRequestTenantId(req);
  const tenant = tenants?.getTenantById?.(tenantId);
  if (tenant?.code) {
    return String(tenant.code);
  }

  const error = new Error('Tenant code is required');
  error.statusCode = 400;
  throw error;
}

function isManageRole(accessRole) {
  return accessRole === 'owner' || accessRole === 'edit';
}

export default createSkillMarketRouter();
