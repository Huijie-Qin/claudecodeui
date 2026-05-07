import express from 'express';
import multer from 'multer';

import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import * as workspaceSkillsService from '../services/workspace-skills.js';
import {
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
  handleWorkspaceError,
} from '../services/workspace-request.js';

const skillArchiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
  },
});

export function createWorkspaceSkillsRouter({
  access = workspaceAccess,
  skillsService = workspaceSkillsService,
  tenantMiddleware = tenantContext,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  router.get('/:workspaceId/skills', async (req, res) => {
    try {
      const tenantId = req.tenant?.id ?? getRequestTenantId(req);
      const userId = getRequestUserId(req);
      const workspaceId = getRequestWorkspaceId(req);

      if (!tenantId || !workspaceId || !userId) {
        const error = new Error('tenantId and workspaceId are required');
        error.statusCode = 400;
        throw error;
      }

      const { workspace, accessRole } = access.requireWorkspace({
        tenantId,
        userId,
        workspaceId,
        requireEdit: false,
      });
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, []);

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: accessRole === 'owner' || accessRole === 'edit',
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/skills/preview', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const preview = await skillsService.previewGithubSkillInstall({
        workspacePath: workspace.path,
        url: req.body?.url,
      });

      return res.status(201).json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        preview,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/skills/upload', (req, res) => {
    skillArchiveUpload.single('archive')(req, res, async (uploadError) => {
      try {
        if (uploadError) {
          const error = new Error(uploadError.code === 'LIMIT_FILE_SIZE'
            ? 'Skill archive must be 10MB or smaller'
            : uploadError.message);
          error.statusCode = 400;
          throw error;
        }
        if (!req.file?.buffer) {
          const error = new Error('Skill archive is required');
          error.statusCode = 400;
          throw error;
        }

        const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
        const preview = await skillsService.previewLocalSkillUpload({
          workspacePath: workspace.path,
          archiveBuffer: req.file.buffer,
          originalName: req.file.originalname,
        });

        return res.status(201).json({
          workspaceId: workspace.id,
          accessRole,
          canManage: true,
          preview,
        });
      } catch (error) {
        return handleWorkspaceError(res, error);
      }
    });
  });

  router.post('/:workspaceId/skills', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.installGithubSkill({
        workspacePath: workspace.path,
        previewId: req.body?.previewId,
        enable: req.body?.enable !== false,
      });
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, []);

      return res.status(201).json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        skill,
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.patch('/:workspaceId/skills/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.setSkillEnabled({
        workspacePath: workspace.path,
        name: req.params.name,
        enabled: req.body?.enabled,
      });
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, []);

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        skill,
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/skills/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      await skillsService.uninstallManagedSkill({
        workspacePath: workspace.path,
        name: req.params.name,
      });
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, []);

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        uninstalled: req.params.name,
        ...inventory,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/skills/reconcile', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const reconcile = await skillsService.reconcileManagedSkills(workspace.path);
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, []);

      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: true,
        reconcile,
        ...inventory,
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

export default createWorkspaceSkillsRouter();
