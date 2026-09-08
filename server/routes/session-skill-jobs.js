import express from 'express';

import { multitenancyDb } from '../database/multitenancy-db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { getRequestUserId, handleWorkspaceError } from '../services/workspace-request.js';
import { createSessionMessageHistoryService } from '../services/session-message-history.js';
import { createSessionSkillLearningService } from '../services/session-skill-learning-service.js';

export function createSessionSkillJobsRouter({
  access = workspaceAccess,
  multitenancy = multitenancyDb,
  tenantMiddleware = tenantContext,
  providerSessions = null,
  historyService = createSessionMessageHistoryService({ multitenancy, providerSessions }),
  jobsService = createSessionSkillLearningService({
    getMarketImports: (workspaceId) => multitenancy.skillMarketImports?.listForWorkspace({ workspaceId }) || [],
  }),
  isSessionActive = () => false,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);

  function resolveRequest(req) {
    const tenantId = req.tenant?.id;
    const userId = getRequestUserId(req);
    // The path controls this scope; a body/query workspaceId cannot override it.
    const workspaceId = Number(req.params.workspaceId);
    if (!tenantId || !userId || !Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
      throw Object.assign(new Error('tenantId, userId, and workspaceId are required'), { statusCode: 400 });
    }
    const { workspace } = access.requireWorkspace({ tenantId, userId, workspaceId, requireEdit: true });
    return { tenantId, userId, workspaceId, workspace };
  }

  router.post('/:workspaceId/session-skill-jobs', async (req, res) => {
    try {
      const { workspace, ...scope } = resolveRequest(req);
      const { provider, sessionId, operation, skillName, maxIterations } = req.body || {};
      if (!['claude', 'codex', 'cursor', 'gemini'].includes(provider)
        || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512) {
        return res.status(400).json({ error: 'A supported provider and persisted sessionId are required' });
      }
      const ownedSession = multitenancy.sessions.findOwnedSession({ ...scope, provider, providerSessionId: sessionId });
      if (!ownedSession || ownedSession.status === 'deleted') return res.status(404).json({ error: 'Session not found' });
      if (await isSessionActive(provider, sessionId)) {
        return res.status(409).json({ error: 'Wait for the session response to finish before learning a skill' });
      }
      const history = await historyService.fetchHistory({
        tenantId: scope.tenantId, userId: scope.userId, provider, providerSessionId: sessionId,
        ownedSession, limit: null, offset: 0,
      });
      if (!Array.isArray(history?.messages) || history.hasMore === true) {
        return res.status(422).json({ error: 'Complete persisted session history is required' });
      }
      const job = await jobsService.startJob({
        ...scope, workspacePath: workspace.path, provider, sessionId, operation, skillName, maxIterations,
        messages: history.messages,
      });
      return res.status(202).json({ job });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/:workspaceId/session-skill-jobs/:jobId', async (req, res) => {
    try {
      const { workspace, ...scope } = resolveRequest(req);
      const job = jobsService.getJob({ ...scope, jobId: req.params.jobId });
      return res.json({ job });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  return router;
}
