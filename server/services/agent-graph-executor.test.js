import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentGraphExecutorService } from './agent-graph-executor.js';

function createMemoryStore() {
  const runs = new Map();
  return {
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
        findings: [`${agent.name} finding`],
        newQuestions: agent.id === 'reports' ? ['Which audience is affected?'] : [],
        confidence: 0.8,
      },
    }),
    evaluateCompletion: async ({ run }) => run.context.agentResults.length < 2
      ? { completed: false, reason: 'Audience causes are still unknown', finalAnswer: '' }
      : { completed: true, reason: 'Evidence is sufficient', finalAnswer: 'Synthesized churn report' },
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
  await scheduled();

  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'Synthesized churn report');
  assert.deepEqual(completed.context.agentResults.map((result) => result.agentId), ['reports', 'profile']);
  assert.equal(completed.context.findings.length, 2);
  assert.equal(completed.context.iteration, 2);
  assert.deepEqual(completed.context.pendingQuestions, []);
  assert.equal(completed.agentStates[0].activationCount, 1);
  assert.equal(completed.agentStates[1].activationCount, 1);
  assert.equal(seenContexts[1].agentResults[0].content, 'Report Agent result');
  const activationTrace = completed.trace.find((event) => event.type === 'activation_decision' && event.agentId === 'profile');
  assert.equal(activationTrace.input.context.iteration, 2);
  assert.equal(activationTrace.output.selectedAgentId, 'profile');
  const contextTrace = completed.trace.find((event) => event.type === 'context_updated' && event.agentId === 'reports');
  assert.deepEqual(contextTrace.output.pendingQuestions, ['Which audience is affected?']);
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
  assert.deepEqual(failed.context.agentResults, []);
  assert.equal(failed.agentStates[0].status, 'failed');
});

test('Graph Executor validates empty Graphs and activation safety limits', async () => {
  const executor = createAgentGraphExecutorService({ store: createMemoryStore() });
  await assert.rejects(
    () => executor.startRun({ workspacePath: '/tmp/workspace', graph: { ...graph(), agents: [] }, input: 'Task' }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    () => executor.startRun({ workspacePath: '/tmp/workspace', graph: graph(), input: 'Task', maxIterations: 21 }),
    (error) => error.statusCode === 400,
  );
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
        agentResult: {
          agent: agent.name,
          summary: `${agent.name} result ${executionCount}`,
          findings: [`Finding ${executionCount}`],
          newQuestions: ['Continue collaboration'],
          confidence: 0.7,
        },
      };
    },
    evaluateCompletion: async () => ({ completed: false, reason: 'More work remains', finalAnswer: '' }),
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: graph(), input: 'Analyze churn', maxIterations: 4,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });

  assert.deepEqual(completed.context.agentResults.map((result) => result.agentId), ['reports', 'reports', 'reports', 'profile']);
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
      agentResult: {
        agent: agent.name,
        summary: 'Repeated result',
        findings: ['No metric changed'],
        newQuestions: ['Is there another signal?'],
        confidence: 0.6,
      },
    }),
    evaluateCompletion: async () => ({ completed: false, reason: 'Keep exploring', finalAnswer: '' }),
  });

  const queued = await executor.startRun({
    workspacePath: '/tmp/workspace', tenantId: 1, userId: 2, workspaceId: 3,
    graph: singleAgentGraph, input: 'Analyze churn', maxIterations: 8,
  });
  await scheduled();
  const completed = await executor.getRun({ workspacePath: '/tmp/workspace', graphId: 'graph-one', runId: queued.id });

  assert.equal(completed.status, 'completed');
  assert.equal(completed.context.iteration, 4);
  assert.equal(completed.context.agentResults.length, 4);
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
      agentResult: { agent: agent.name, summary: 'Safe result', findings: ['Safe finding'], newQuestions: [], confidence: 0.9 },
    }),
    evaluateCompletion: async () => ({
      completed: true,
      reason: 'Done',
      finalAnswer: 'Safe final answer',
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
