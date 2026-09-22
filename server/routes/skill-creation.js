import express from 'express';

import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { getRequestUserId, getRequestWorkspaceId, handleWorkspaceError } from '../services/workspace-request.js';
import { skillCreationService } from '../services/skill-creation/index.js';

export function createSkillCreationRouter({ service = skillCreationService, access = workspaceAccess, tenantMiddleware = tenantContext } = {}) {
  const router = express.Router(); router.use(tenantMiddleware);
  const route = (method, url, edit, action) => router[method](url, async (req, res) => {
    try {
      const scope = { tenantId: req.tenant?.id, userId: getRequestUserId(req), workspaceId: getRequestWorkspaceId(req) };
      const { workspace } = access.requireWorkspace({ ...scope, requireEdit: edit });
      res.set('Cache-Control', 'no-store'); await action(req, res, { ...scope, workspacePath: workspace.path });
    } catch (error) { handleWorkspaceError(res, error); }
  });
  const base = '/:workspaceId/skill-creation-jobs';
  route('post', base, true, async (req, res, scope) => res.status(202).json({ job: await service.start(scope, req.body) }));
  route('get', base, false, (req, res, scope) => res.json({ jobs: service.list(scope, String(req.query.conversationKey || '')) }));
  route('post', `${base}/bind-session`, true, (req, res, scope) => res.json({ jobs: service.bindSession(scope, req.body) }));
  route('get', `${base}/:jobId`, false, (req, res, scope) => res.json({ job: service.get(scope, req.params.jobId) }));
  route('post', `${base}/:jobId/cancel`, true, (req, res, scope) => res.json({ job: service.cancel(scope, req.params.jobId) }));
  return router;
}
export default createSkillCreationRouter();
