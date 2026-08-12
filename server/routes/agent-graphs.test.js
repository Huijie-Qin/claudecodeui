import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createAgentGraphsRouter } from './agent-graphs.js';

async function requestJson(router, requestPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 7 };
      next();
    });
    app.use(router);
    const server = app.listen(0, async () => {
      try {
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = await response.json();
        server.close(() => resolve({ response, payload }));
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}

function createRouter({
  accessRole = 'view',
  service = {},
  jobs = {},
  executor = {},
  requireWorkspace,
  canUseAgentGraph = () => true,
} = {}) {
  return createAgentGraphsRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2 };
      next();
    },
    access: {
      requireWorkspace: requireWorkspace || (() => ({
        workspace: { id: 10, path: '/tmp/workspace' },
        accessRole,
      })),
    },
    service: {
      listAgentGraphs: async () => [],
      getAgentGraph: async ({ graphId }) => ({ id: graphId, name: 'Graph', goal: 'Goal', agents: [], relations: [] }),
      createAgentGraph: async ({ graph }) => graph,
      updateAgentGraph: async ({ graphId, graph }) => ({ ...graph, id: graphId }),
      deleteAgentGraph: async ({ graphId }) => ({ id: graphId }),
      ...service,
    },
    jobs: {
      startTopSkillJob: () => ({ id: 'job-one', operation: 'generate', status: 'queued' }),
      getTopSkillJob: () => ({ id: 'job-one', operation: 'generate', status: 'running' }),
      ...jobs,
    },
    executor: {
      getConfig: () => ({ executionModel: 'context-driven-collaboration-loop' }),
      startRun: async ({ graph }) => ({ id: 'run-one', graphId: graph.id, status: 'queued' }),
      listRuns: async () => [],
      getRun: async ({ runId, graphId }) => ({ id: runId, graphId, status: 'running' }),
      cancelRun: async ({ runId, graphId }) => ({ id: runId, graphId, status: 'cancelling' }),
      ...executor,
    },
    featureFlags: {
      isEnabled: () => true,
    },
    canUseAgentGraph,
  });
}

test('GET Agent Graphs allows view access without edit permission', async () => {
  const seen = {};
  const router = createRouter({
    requireWorkspace: (args) => {
      seen.access = args;
      return { workspace: { id: 10, path: '/tmp/view' }, accessRole: 'view' };
    },
  });
  const { response, payload } = await requestJson(router, '/10/agent-graphs?tenantId=2');

  assert.equal(response.status, 200);
  assert.equal(payload.canManage, false);
  assert.equal(payload.executorConfig.executionModel, 'context-driven-collaboration-loop');
  assert.equal(seen.access.requireEdit, false);
});

test('Top Skill generation starts a background job and returns immediately', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    requireWorkspace: (args) => {
      seen.access = args;
      return { workspace: { id: 10, path: '/tmp/edit' }, accessRole: 'edit' };
    },
    jobs: {
      startTopSkillJob: (args) => {
        seen.start = args;
        return { id: 'job-123', operation: args.operation, status: 'queued' };
      },
    },
  });
  const body = { name: 'Analyst', workingDescription: 'Analyze data', skills: [], tools: [] };
  const { response, payload } = await requestJson(router, '/10/agent-graphs/top-skill-jobs?tenantId=2', {
    method: 'POST',
    body: { operation: 'generate', input: body },
  });

  assert.equal(response.status, 202);
  assert.equal(seen.access.requireEdit, true);
  assert.equal(seen.start.workspacePath, '/tmp/edit');
  assert.equal(seen.start.tenantId, 2);
  assert.equal(seen.start.userId, 7);
  assert.equal(seen.start.workspaceId, 10);
  assert.deepEqual(seen.start.input, body);
  assert.equal(payload.job.id, 'job-123');
  assert.equal(payload.job.status, 'queued');
});

test('Top Skill job status is scoped to the requesting workspace and user', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'edit',
    jobs: {
      getTopSkillJob: (args) => {
        seen.get = args;
        return { id: args.jobId, operation: 'optimize', status: 'succeeded' };
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/agent-graphs/top-skill-jobs/job-456?tenantId=2');

  assert.equal(response.status, 200);
  assert.deepEqual(seen.get, { jobId: 'job-456', tenantId: 2, userId: 7, workspaceId: 10 });
  assert.equal(payload.job.operation, 'optimize');
});

test('Graph run creation freezes the persisted Graph and passes workspace identity to Executor', async () => {
  const seen = {};
  const graph = { id: 'graph-one', name: 'Insights', goal: 'Explain churn', agents: [{ id: 'a' }], relations: [] };
  const router = createRouter({
    accessRole: 'edit',
    service: {
      getAgentGraph: async (args) => {
        seen.graphLookup = args;
        return graph;
      },
    },
    executor: {
      startRun: async (args) => {
        seen.start = args;
        return { id: 'run-123', graphId: graph.id, status: 'queued' };
      },
    },
  });

  const { response, payload } = await requestJson(router, '/10/agent-graphs/graph-one/runs?tenantId=2', {
    method: 'POST',
    body: { input: 'Analyze churn', maxIterations: 6 },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(seen.graphLookup, { workspacePath: '/tmp/workspace', graphId: 'graph-one' });
  assert.equal(seen.start.tenantId, 2);
  assert.equal(seen.start.userId, 7);
  assert.equal(seen.start.workspaceId, 10);
  assert.equal(seen.start.input, 'Analyze churn');
  assert.equal(seen.start.maxIterations, 6);
  assert.equal(payload.run.status, 'queued');
});

test('Graph run reads allow view access while cancellation requires edit access', async () => {
  const seen = {};
  const router = createRouter({
    accessRole: 'view',
    requireWorkspace: (args) => {
      seen.requireEdit = args.requireEdit;
      if (args.requireEdit) {
        const error = new Error('Workspace edit access is required');
        error.statusCode = 403;
        throw error;
      }
      return { workspace: { id: 10, path: '/tmp/view' }, accessRole: 'view' };
    },
    executor: {
      getRun: async ({ runId, graphId }) => ({ id: runId, graphId, status: 'completed' }),
    },
  });

  const read = await requestJson(router, '/10/agent-graphs/graph-one/runs/run-one?tenantId=2');
  assert.equal(read.response.status, 200);
  assert.equal(read.payload.run.status, 'completed');
  assert.equal(seen.requireEdit, false);

  const cancel = await requestJson(router, '/10/agent-graphs/graph-one/runs/run-one/cancel?tenantId=2', { method: 'POST' });
  assert.equal(cancel.response.status, 403);
});

test('Agent Graph endpoints are hidden while the global feature flag is disabled', async () => {
  const router = createAgentGraphsRouter({
    tenantMiddleware: (req, res, next) => {
      req.tenant = { id: 2 };
      next();
    },
    featureFlags: { isEnabled: () => false },
  });

  const { response, payload } = await requestJson(router, '/10/agent-graphs?tenantId=2');
  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Agent Graph is not enabled');
});

test('Agent Graph endpoints are hidden from users outside the environment whitelist', async () => {
  const router = createRouter({ canUseAgentGraph: () => false });

  const { response, payload } = await requestJson(router, '/10/agent-graphs?tenantId=2');
  assert.equal(response.status, 404);
  assert.equal(payload.error, 'Agent Graph is not enabled');
});
