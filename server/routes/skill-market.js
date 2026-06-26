import express from 'express';

import { userDb } from '../database/db.js';
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
  users = userDb,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/skills', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const accountId = resolveAccountId(req, users);
      const result = await marketService.listSkillMarket({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        searchContent: req.query?.searchContent ?? req.query?.q ?? '',
        page: req.query?.page,
        pageSize: req.query?.pageSize,
        currentUsername: accountId,
        tenantCode,
        accountId,
        includePageInfo: true,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: isManageRole(accessRole),
        skills: result.skills,
        pageInfo: result.pageInfo,
        openApiRequestBody: result.openApiRequestBody,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/skills/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const accountId = resolveAccountId(req, users);
      const skill = await marketService.getSkillMarketDetail({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
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
      const accountId = resolveAccountId(req, users);
      const file = await marketService.viewMarketSkillFile({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        filePath: req.query?.filePath,
        tenantCode,
        accountId,
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
      const accountId = resolveAccountId(req, users);
      const skill = await marketService.downloadMarketSkill({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        overwrite: req.body?.overwrite === true || req.query?.overwrite === 'true',
        tenantCode,
        accountId,
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
      const accountId = resolveAccountId(req, users);
      const result = await marketService.publishMarketSkill({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
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
      const accountId = resolveAccountId(req, users);
      const result = await marketService.getMarketSkillPublishPreview({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
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

  router.get('/skills/:name/publish-state', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const tenantCode = resolveTenantCode(req, tenants);
      const accountId = resolveAccountId(req, users);
      const skill = await marketService.getMarketSkillPublishState({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
      });

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: isManageRole(accessRole),
        skill: {
          ...skill,
          canUploadAndPublish: isManageRole(accessRole) && skill.canUploadAndPublish === true,
        },
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/skills/:name/publish', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const accountId = resolveAccountId(req, users);
      const result = await marketService.publishMarketSkill({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
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

  router.post('/skills/:name/upload-publish', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const tenantCode = resolveTenantCode(req, tenants);
      const accountId = resolveAccountId(req, users);
      const result = await marketService.uploadAndPublishLocalSkill({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
        currentUsername: accountId,
        tenantCode,
        accountId,
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
      const accountId = resolveAccountId(req, users);
      const result = await marketService.removeMarketSkill({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        name: req.params.name,
      });
      const skills = await marketService.listSkillMarket({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        currentUsername: accountId,
        tenantCode,
        accountId,
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

function resolveAccountId(req, users) {
  const accountId = req.user?.username;
  if (accountId) {
    return String(accountId);
  }

  const userId = getRequestUserId(req);
  const user = users?.getUserById?.(userId);
  if (user?.username) {
    return String(user.username);
  }

  const error = new Error('User username is required');
  error.statusCode = 400;
  throw error;
}

function isManageRole(accessRole) {
  return accessRole === 'owner' || accessRole === 'edit';
}

export default createSkillMarketRouter();
