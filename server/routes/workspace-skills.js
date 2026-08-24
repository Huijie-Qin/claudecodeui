import express from 'express';
import multer from 'multer';

import { multitenancyDb } from '../database/multitenancy-db.js';
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
  marketImports = multitenancyDb.skillMarketImports,
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
      const imports = listMarketImports(marketImports, workspace.id);
      const inventory = await skillsService.listWorkspaceSkills(workspace.path, [], imports);

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

  router.get('/:workspaceId/skills/:name', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const skill = await skillsService.getWorkspaceSkillDetail({
        workspacePath: workspace.path,
        name: req.params.name,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: accessRole !== 'view', skill });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/:workspaceId/skills/:name/files', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const file = await skillsService.readWorkspaceSkillFile({
        workspacePath: workspace.path,
        name: req.params.name,
        filePath: req.query?.filePath,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: accessRole !== 'view', file });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.put('/:workspaceId/skills/:name/files', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const file = await skillsService.updateWorkspaceSkillFile({
        workspacePath: workspace.path,
        name: req.params.name,
        filePath: req.body?.filePath,
        content: req.body?.content,
        revision: req.body?.revision,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: true, file });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/skills/:name/entries', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.createWorkspaceSkillEntry({
        workspacePath: workspace.path,
        name: req.params.name,
        entryPath: req.body?.path,
        entryType: req.body?.type,
        content: req.body?.content,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.status(201).json({ workspaceId: workspace.id, accessRole, canManage: true, skill });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.patch('/:workspaceId/skills/:name/entries', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.renameWorkspaceSkillEntry({
        workspacePath: workspace.path,
        name: req.params.name,
        entryPath: req.body?.path,
        nextPath: req.body?.nextPath,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: true, skill });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/skills/:name/entries', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.deleteWorkspaceSkillEntry({
        workspacePath: workspace.path,
        name: req.params.name,
        entryPath: req.body?.path,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: true, skill });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/skills/local', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const skill = await skillsService.createWorkspaceSkill({
        workspacePath: workspace.path,
        name: req.body?.name,
        displayName: req.body?.displayName,
        description: req.body?.description,
        content: req.body?.content,
      });
      return res.status(201).json({ workspaceId: workspace.id, accessRole, canManage: true, skill });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/skills/:name/local', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: true });
      const result = await skillsService.deleteLocalWorkspaceSkill({
        workspacePath: workspace.path,
        name: req.params.name,
        marketImports: listMarketImports(marketImports, workspace.id),
      });
      return res.json({ workspaceId: workspace.id, accessRole, canManage: true, ...result });
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
      const inventory = await skillsService.listWorkspaceSkills(
        workspace.path,
        [],
        listMarketImports(marketImports, workspace.id),
      );

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
      const inventory = await skillsService.listWorkspaceSkills(
        workspace.path,
        [],
        listMarketImports(marketImports, workspace.id),
      );

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
      const inventory = await skillsService.listWorkspaceSkills(
        workspace.path,
        [],
        listMarketImports(marketImports, workspace.id),
      );

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
      const inventory = await skillsService.listWorkspaceSkills(
        workspace.path,
        [],
        listMarketImports(marketImports, workspace.id),
      );

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

function listMarketImports(marketImports, workspaceId) {
  return typeof marketImports?.listForWorkspace === 'function'
    ? marketImports.listForWorkspace({ workspaceId }) || []
    : [];
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
