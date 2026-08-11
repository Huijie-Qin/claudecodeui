import express from 'express';

import { tenantContext } from '../middleware/tenant-context.js';
import { agentGraphsService } from '../services/agent-graphs.js';
import { agentGraphExecutorService } from '../services/agent-graph-executor.js';
import { topSkillJobsService } from '../services/top-skill-jobs.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { FEATURE_FLAGS, featureFlagsService } from '../services/feature-flags.js';
import {
  getRequestTenantId,
  getRequestUserId,
  getRequestWorkspaceId,
  handleWorkspaceError,
} from '../services/workspace-request.js';

function resolveWorkspace(req, access, { requireEdit }) {
  const tenantId = req.tenant?.id ?? getRequestTenantId(req);
  const userId = getRequestUserId(req);
  const workspaceId = getRequestWorkspaceId(req);
  if (!tenantId || !workspaceId || !userId) {
    const error = new Error('tenantId and workspaceId are required');
    error.statusCode = 400;
    throw error;
  }
  return {
    tenantId,
    userId,
    workspaceId,
    ...access.requireWorkspace({ tenantId, userId, workspaceId, requireEdit }),
  };
}

export function createAgentGraphsRouter({
  access = workspaceAccess,
  tenantMiddleware = tenantContext,
  service = agentGraphsService,
  jobs = topSkillJobsService,
  executor = agentGraphExecutorService,
  featureFlags = featureFlagsService,
} = {}) {
  const router = express.Router();
  router.use(tenantMiddleware);
  router.use('/:workspaceId/agent-graphs', (req, res, next) => {
    if (!featureFlags.isEnabled(FEATURE_FLAGS.AGENT_GRAPH)) {
      return res.status(404).json({ error: 'Agent Graph is not enabled' });
    }
    return next();
  });

  router.get('/:workspaceId/agent-graphs', async (req, res) => {
    try {
      const { workspace, accessRole } = resolveWorkspace(req, access, { requireEdit: false });
      const graphs = await service.listAgentGraphs(workspace.path);
      return res.json({
        workspaceId: workspace.id,
        accessRole,
        canManage: accessRole === 'owner' || accessRole === 'edit',
        executorConfig: executor.getConfig(),
        graphs,
      });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/agent-graphs', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: true });
      const graph = await service.createAgentGraph({ workspacePath: workspace.path, graph: req.body });
      return res.status(201).json({ graph });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.put('/:workspaceId/agent-graphs/:graphId', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: true });
      const graph = await service.updateAgentGraph({
        workspacePath: workspace.path,
        graphId: req.params.graphId,
        graph: req.body,
      });
      return res.json({ graph });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.delete('/:workspaceId/agent-graphs/:graphId', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: true });
      const graph = await service.deleteAgentGraph({
        workspacePath: workspace.path,
        graphId: req.params.graphId,
      });
      return res.json({ removed: true, graph });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/agent-graphs/top-skill-jobs', async (req, res) => {
    try {
      const { workspace, tenantId, userId, workspaceId } = resolveWorkspace(req, access, { requireEdit: true });
      const job = jobs.startTopSkillJob({
        operation: req.body?.operation,
        workspacePath: workspace.path,
        tenantId,
        userId,
        workspaceId,
        input: req.body?.input,
      });
      return res.status(202).json({ job });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/:workspaceId/agent-graphs/top-skill-jobs/:jobId', async (req, res) => {
    try {
      const { tenantId, userId, workspaceId } = resolveWorkspace(req, access, { requireEdit: true });
      const job = jobs.getTopSkillJob({
        jobId: req.params.jobId,
        tenantId,
        userId,
        workspaceId,
      });
      return res.json({ job });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/agent-graphs/:graphId/runs', async (req, res) => {
    try {
      const { workspace, tenantId, userId, workspaceId } = resolveWorkspace(req, access, { requireEdit: true });
      const graph = await service.getAgentGraph({ workspacePath: workspace.path, graphId: req.params.graphId });
      const run = await executor.startRun({
        workspacePath: workspace.path,
        tenantId,
        userId,
        workspaceId,
        graph,
        input: req.body?.input,
        maxIterations: req.body?.maxIterations,
        maxActivations: req.body?.maxActivations,
      });
      return res.status(202).json({ run });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/:workspaceId/agent-graphs/:graphId/runs', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: false });
      const runs = await executor.listRuns({
        workspacePath: workspace.path,
        graphId: req.params.graphId,
        limit: req.query.limit,
      });
      return res.json({ runs });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.get('/:workspaceId/agent-graphs/:graphId/runs/:runId', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: false });
      const run = await executor.getRun({
        workspacePath: workspace.path,
        graphId: req.params.graphId,
        runId: req.params.runId,
      });
      return res.json({ run });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  router.post('/:workspaceId/agent-graphs/:graphId/runs/:runId/cancel', async (req, res) => {
    try {
      const { workspace } = resolveWorkspace(req, access, { requireEdit: true });
      const run = await executor.cancelRun({
        workspacePath: workspace.path,
        graphId: req.params.graphId,
        runId: req.params.runId,
      });
      return res.json({ run });
    } catch (error) {
      return handleWorkspaceError(res, error);
    }
  });

  return router;
}

export default createAgentGraphsRouter();
