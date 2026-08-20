import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentGraphExecutorService } from './agent-graph-executor.js';

function createMemoryStore() {
  const runs = new Map();
  return {
    seed: (run) => runs.set(run.id, structuredClone(run)),
    saveAgentGraphRun: async ({ run }) => {
      runs.set(run.id, structuredClone(run));
      return structuredClone(run);
    },
    getAgentGraphRun: async ({ runId }) => {
      const run = runs.get(runId);
      if (!run) {
        const error = new Error('not found');
        error.statusCode = 404;
        throw error;
      }
      return structuredClone(run);
    },
    listAgentGraphRuns: async ({ graphId }) => [...runs.values()]
      .filter((run) => run.graphId === graphId)
      .map((run) => structuredClone(run)),
  };
}

function graph() {
  return {
    id: 'graph-one',
    name: 'Music insight team',
    goal: 'Explain music-app churn with evidence.',
    agents: [
      { id: 'reports', name: 'Report Agent', topSkill: '## Role\nReport', skills: ['reports'], tools: [], position: { x: 0, y: 0 }, workingDescription: 'Query reports', businessContext: '' },
      { id: 'profile', name: 'Profile Agent', topSkill: '## Role\nProfile', skills: ['profile'], tools: [], position: { x: 0, y: 0 }, workingDescription: 'Analyze profiles', businessContext: '' },
    ],
    relations: [{ id: 'relation-one', sourceAgent: 'reports', targetAgent: 'profile', description: 'Shares evidence' }],
  };
}

test('Graph Executor dynamically activates Agents through shared Context and completes', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  const decisions = [
    { selectedAgentId: 'reports', reason: 'Need metrics', task: 'Query churn metrics' },
    { selectedAgentId: 'profile', reason: 'Need audience causes', task: 'Analyze the affected audience' },
  ];
  const seenContexts = [];
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `id-${++id}`,
    now: () => 1_700_000_000_000 + id,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async ({ run }) => {
      seenContexts.push(structuredClone(run.context));
      return decisions.shift();
    },
    executeAgent: async ({ agent }) => ({
      text: `${agent.name} result`,
      sessionId: `session-${agent.id}`,
      agentResult: {
        agent: agent.name,
        summary: `${agent.name} result`,
        type: 'analysis',
        findings: [`${agent.name} finding`],
        newQuestions: agent.id === 'reports' ? ['Which audience is affected?'] : [],
        confidence: 0.8,
      },
    }),
    evaluateCompletion: async ({ run }) => run.resultStore.length < 2
      ? { completed: false, reason: 'Audience causes are still unknown', finalAgentResultId: '' }
      : { completed: true, reason: 'Evidence is sufficient', finalAgentResultId: run.resultStore.at(-1).resultId },
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 2,
    workspaceId: 3,
    graph: graph(),
    input: 'Analyze churn',
    maxIterations: 5,
  });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.workspacePath, undefined);
  assert.equal(executor.getActiveRunCount(), 1);
  await scheduled();
  assert.equal(executor.getActiveRunCount(), 0);

  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'Profile Agent result');
  assert.deepEqual(completed.resultStore.map((result) => result.agentId), ['reports', 'profile']);
  assert.equal(completed.findingStore.length, 2);
  assert.equal(completed.artifactRegistry.length, 0);
  assert.equal(completed.context.resultIds.length, 2);
  assert.equal(completed.context.findingIds.length, 2);
  assert.equal(completed.context.iteration, 2);
  assert.deepEqual(completed.context.questions, []);
  assert.equal(completed.agentStates[0].activationCount, 1);
  assert.equal(completed.agentStates[1].activationCount, 1);
  assert.equal(seenContexts[1].resultIds.length, 1);
  assert.equal(seenContexts[1].agentResults, undefined);
  assert.equal(seenContexts[1].findings, undefined);
  assert.deepEqual(completed.agentSessions.map((session) => session.providerSessionId), ['session-reports', 'session-profile']);
  assert.ok(completed.agentSessions.every((session) => session.status === 'ended'));
  const activationTrace = completed.trace.find((event) => event.type === 'activation_decision' && event.agentId === 'profile');
  assert.equal(activationTrace.input.context.iteration, 2);
  assert.equal(activationTrace.output.selectedAgentId, 'profile');
  const contextTrace = completed.trace.find((event) => event.type === 'context_updated' && event.agentId === 'reports');
  assert.deepEqual(contextTrace.output.context.questions, ['Which audience is affected?']);
  assert.ok(completed.trace.some((event) => event.type === 'completion_decision' && event.complete === true));
});

test('Graph Executor persists failures without fabricating Agent results', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `fail-${++id}`,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async () => ({ selectedAgentId: 'reports', reason: 'Need metrics', task: 'Query metrics' }),
    executeAgent: async () => { throw new Error('Claude authentication is required'); },
  });
  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3, graph: graph(), input: 'Analyze churn',
  });
  await scheduled();
  const failed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /authentication is required/);
  assert.deepEqual(failed.context.resultIds, []);
  assert.deepEqual(failed.resultStore, []);
  assert.equal(failed.agentStates[0].status, 'failed');
});

test('Graph Executor aborts every queued run during forced shutdown', async () => {
  const store = createMemoryStore();
  let scheduled;
  const executor = createAgentGraphExecutorService({
    store,
    schedule: (callback) => { scheduled = callback; },
  });
  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: graph(), input: 'Analyze churn',
  });

  assert.equal(executor.abortAllActiveRuns(), 1);
  assert.equal(executor.getActiveRunCount(), 1);
  await scheduled();
  assert.equal(executor.getActiveRunCount(), 0);
  const cancelled = await executor.getRun({
    workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('Graph Executor forwards forced shutdown aborts to a running Claude turn', async () => {
  const store = createMemoryStore();
  let scheduled;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const executor = createAgentGraphExecutorService({
    store,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async ({ abortController }) => new Promise((resolve, reject) => {
      markStarted();
      abortController.signal.addEventListener('abort', () => reject(new Error('selector aborted')), { once: true });
    }),
  });
  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: graph(), input: 'Analyze churn',
  });

  const running = scheduled();
  await started;
  assert.equal(executor.getActiveRunCount(), 1);
  assert.equal(executor.abortAllActiveRuns(), 1);
  await running;
  assert.equal(executor.getActiveRunCount(), 0);
  const cancelled = await executor.getRun({
    workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id,
  });
  assert.equal(cancelled.status, 'cancelled');
});

test('Graph Executor validates empty Graphs and activation safety limits', async () => {
  const executor = createAgentGraphExecutorService({ store: createMemoryStore() });
  const config = executor.getConfig();
  assert.equal(config.completionPolicy.controllerMaySynthesizeBusinessAnswer, false);
  assert.equal(config.completionPolicy.finalResultSource, 'existing-agent-result');
  assert.equal(config.sessionPolicy.agentSessionScope, 'executionId+agentId');
  assert.equal(config.contextPolicy.executionContextStoresFullAgentOutput, false);
  await assert.rejects(
    () => executor.startRun({ workspacePath: '/tmp/workspace', graph: { ...graph(), agents: [] }, input: 'Task' }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    () => executor.startRun({ workspacePath: '/tmp/workspace', graph: graph(), input: 'Task', maxIterations: 21 }),
    (error) => error.statusCode === 400,
  );
});

test('Graph Executor exposes legacy runs through the lightweight Context and separate stores', async () => {
  const store = createMemoryStore();
  store.seed({
    version: 2,
    id: 'legacy-run',
    graphId: 'graph-one',
    graphName: 'Music insight team',
    graphSnapshot: graph(),
    status: 'completed',
    input: 'Analyze churn',
    maxIterations: 8,
    context: {
      executionId: 'legacy-run',
      goal: 'Explain music-app churn with evidence.',
      status: 'completed',
      iteration: 1,
      pendingQuestions: [],
      findings: [{ id: 'legacy-evidence', agentId: 'reports', agentName: 'Report Agent', content: 'Stable churn', createdAt: '2026-01-01T00:00:00.000Z' }],
      agentResults: [{
        id: 'legacy-result',
        agentId: 'reports',
        agentName: 'Report Agent',
        activation: 1,
        summary: 'Legacy report',
        content: 'Legacy full report',
        newQuestions: [],
        confidence: 0.8,
        providerSessionId: 'legacy-session',
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    },
    agentStates: [],
    trace: [],
    result: 'Legacy full report',
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  });
  const executor = createAgentGraphExecutorService({ store });

  const migrated = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: 'legacy-run' });

  assert.equal(migrated.context.agentResults, undefined);
  assert.equal(migrated.context.findings, undefined);
  assert.deepEqual(migrated.context.resultIds, ['legacy-result']);
  assert.deepEqual(migrated.context.findingIds, ['legacy-evidence']);
  assert.equal(migrated.resultStore[0].message, 'Legacy report');
  assert.equal(migrated.findingStore[0].content, 'Stable churn');
  assert.equal(migrated.agentSessions[0].providerSessionId, 'legacy-session');
});

test('Graph Executor reuses one Claude Session per execution and Agent', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  let activation = 0;
  const observedSessions = [];
  const observedContexts = [];
  const singleAgentGraph = { ...graph(), agents: [graph().agents[0]], relations: [] };
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `session-reuse-${++id}`,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async () => ({ selectedAgentId: 'reports', reason: 'Continue analysis', task: 'Investigate the next signal' }),
    executeAgent: async ({ agent, agentSession, agentContext }) => {
      activation += 1;
      observedSessions.push(agentSession.providerSessionId);
      observedContexts.push(structuredClone(agentContext));
      return {
        text: `Result ${activation}`,
        sessionId: 'one-agent-session',
        agentResult: {
          agent: agent.name,
          summary: `Result ${activation}`,
          type: 'analysis',
          findings: [`Evidence ${activation}`],
          newQuestions: activation === 1 ? ['Continue'] : [],
          confidence: 0.8,
        },
      };
    },
    evaluateCompletion: async ({ run }) => run.resultStore.length === 2
      ? { completed: true, reason: 'Done', finalAgentResultId: run.resultStore.at(-1).resultId }
      : { completed: false, reason: 'Continue', finalAgentResultId: '' },
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: singleAgentGraph, input: 'Analyze churn', maxIterations: 3,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });

  assert.deepEqual(observedSessions, [null, 'one-agent-session']);
  assert.equal(observedContexts[0].resumedSession, false);
  assert.equal(observedContexts[1].resumedSession, true);
  assert.deepEqual(observedContexts[1].includedFindingIds, []);
  assert.equal(completed.agentSessions.length, 1);
  assert.equal(completed.agentSessions[0].providerSessionId, 'one-agent-session');
  assert.equal(completed.agentSessions[0].activationCount, 2);
  assert.equal(completed.resultStore[0].providerSessionId, undefined);
  assert.ok(completed.trace.some((event) => event.type === 'agent_session_created'));
  assert.ok(completed.trace.some((event) => event.type === 'agent_session_resumed'));
});

test('Graph Executor reconsiders a fourth consecutive activation when another Agent is available', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  let executionCount = 0;
  const reconsiderations = [];
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `repeat-${++id}`,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async ({ excludedAgentIds = [] }) => {
      reconsiderations.push(excludedAgentIds);
      return excludedAgentIds.includes('reports')
        ? { selectedAgentId: 'profile', reason: 'Switch expertise', task: 'Review the evidence' }
        : { selectedAgentId: 'reports', reason: 'Need more metrics', task: 'Continue metrics' };
    },
    executeAgent: async ({ agent }) => {
      executionCount += 1;
      return {
        text: `${agent.name} result ${executionCount}`,
        sessionId: `session-${agent.id}`,
        agentResult: {
          agent: agent.name,
          summary: `${agent.name} result ${executionCount}`,
          type: 'analysis',
          findings: [`Finding ${executionCount}`],
          newQuestions: ['Continue collaboration'],
          confidence: 0.7,
        },
      };
    },
    evaluateCompletion: async () => ({ completed: false, reason: 'More work remains', finalAgentResultId: '' }),
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: graph(), input: 'Analyze churn', maxIterations: 4,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });

  assert.deepEqual(completed.resultStore.map((result) => result.agentId), ['reports', 'reports', 'reports', 'profile']);
  assert.ok(reconsiderations.some((excluded) => excluded.includes('reports')));
  assert.ok(completed.trace.some((event) => event.type === 'activation_reconsidered'));
});

test('Graph Executor stops after three consecutive iterations without a new finding', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  const singleAgentGraph = { ...graph(), agents: [graph().agents[0]], relations: [] };
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `stale-${++id}`,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async () => ({ selectedAgentId: 'reports', reason: 'Check again', task: 'Check the same evidence' }),
    executeAgent: async ({ agent }) => ({
      text: 'Repeated result',
      sessionId: `session-${agent.id}`,
      agentResult: {
        agent: agent.name,
        summary: 'Repeated result',
        type: 'analysis',
        findings: ['No metric changed'],
        newQuestions: ['Is there another signal?'],
        confidence: 0.6,
      },
    }),
    evaluateCompletion: async () => ({ completed: false, reason: 'Keep exploring', finalAgentResultId: '' }),
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: singleAgentGraph, input: 'Analyze churn', maxIterations: 8,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.context.iteration, 4);
  assert.equal(completed.resultStore.length, 4);
  assert.equal(completed.agentSessions.length, 1);
  assert.equal(completed.agentSessions[0].activationCount, 4);
  assert.ok(completed.trace.some((event) => event.type === 'loop_stopped_no_new_info'));
});

test('Execution Trace redacts credentials from displayed step inputs and outputs', async () => {
  const store = createMemoryStore();
  let scheduled;
  let id = 0;
  const sensitiveGraph = graph();
  sensitiveGraph.agents[0].topSkill = 'Use ANTHROPIC_API_KEY=do-not-display for queries.';
  const executor = createAgentGraphExecutorService({
    store,
    idFactory: () => `redact-${++id}`,
    schedule: (callback) => { scheduled = callback; },
    selectAgent: async () => ({ selectedAgentId: 'reports', reason: 'Need metrics', task: 'Query metrics' }),
    executeAgent: async ({ agent }) => ({
      text: 'Safe result',
      sessionId: `session-${agent.id}`,
      agentResult: { agent: agent.name, summary: 'Safe result', type: 'analysis', findings: ['Safe finding'], newQuestions: [], confidence: 0.9 },
    }),
    evaluateCompletion: async ({ run }) => ({
      completed: true,
      reason: 'Done',
      finalAgentResultId: run.resultStore.at(-1).resultId,
    }),
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: sensitiveGraph, input: 'Analyze churn', maxIterations: 2,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });
  const serializedTrace = JSON.stringify(completed.trace);

  assert.doesNotMatch(serializedTrace, /do-not-display/);
  assert.match(serializedTrace, /\[REDACTED\]/);
});
