import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeAgentWithClaude,
  evaluateCompletionWithClaude,
  resolveAgentTools,
  selectAgentWithClaude,
} from './agent-graph-claude-runtime.js';

function createRun() {
  return {
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 2,
    workspaceId: 3,
    graphSnapshot: {
      id: 'graph-one',
      name: 'Music insight team',
      goal: 'Explain music-app churn with evidence.',
      agents: [
        {
          id: 'reports',
          name: 'Report Agent',
          topSkill: '## Role\nReport',
          skills: ['reports'],
          tools: [],
          workingDescription: 'Query reports',
        },
      ],
      relations: [],
    },
    agentStates: [{ agentId: 'reports', activationCount: 0 }],
    resultStore: [],
    artifactRegistry: [],
    findingStore: [],
    context: {
      executionId: 'execution-one',
      goal: 'Explain music-app churn with evidence.',
      status: 'running',
      iteration: 1,
      currentNeed: 'Analyze churn',
      artifactIds: [],
      findingIds: [],
      resultIds: [],
      questions: [],
    },
  };
}

function createDependencies(messages, onOptions = () => {}) {
  return {
    skillContextRecorder: { recordSession: () => ({ changed: false }) },
    capabilityResolver: async () => ({ tools: [], mcpServers: {} }),
    artifactWorkspace: {
      createArtifactAccessMcpServer: async () => ({}),
      listArtifacts: async () => [],
    },
    runtimeManager: {
      prepareClaudeRuntime: async () => ({ cwd: '/tmp/workspace' }),
      markIdle: () => {},
      markFailed: () => {},
    },
    mapOptions: () => ({}),
    runQuery: async function* runQuery({ options }) {
      onOptions(options);
      for (const message of messages) yield message;
    },
  };
}

test('Agent Activation uses SDK structured output when available', async () => {
  const decision = {
    selectedAgentId: 'reports',
    reason: 'Metrics are needed first.',
    task: 'Query churn metrics.',
  };
  let options;

  const result = await selectAgentWithClaude({
    run: createRun(),
    dependencies: createDependencies([
      { type: 'result', structured_output: decision },
    ], (value) => { options = value; }),
  });

  assert.deepEqual(result, decision);
  assert.equal(options.outputFormat.type, 'json_schema');
  assert.equal(options.maxTurns, 3);
  assert.equal(options.persistSession, false);
  assert.equal(options.resume, undefined);
  assert.deepEqual(options.outputFormat.schema.required, [
    'selectedAgentId',
    'reason',
    'task',
  ]);
});

test('Agent Activation keeps text JSON as a compatibility fallback', async () => {
  const result = await selectAgentWithClaude({
    run: createRun(),
    dependencies: createDependencies([
      {
        type: 'result',
        result: 'Decision:\n```json\n{"selectedAgentId":"reports","reason":"Need evidence","task":"Query metrics"}\n```',
      },
    ]),
  });

  assert.deepEqual(result, {
    selectedAgentId: 'reports',
    reason: 'Need evidence',
    task: 'Query metrics',
  });
});

test('Loop completion is evaluated independently after Context updates', async () => {
  const run = createRun();
  run.resultStore = [{
    resultId: 'result-one',
    executionId: 'execution-one',
    agentId: 'reports',
    agentName: 'Report Agent',
    type: 'report',
    summary: 'Evidence-backed report',
    content: 'Evidence-backed report',
    evidenceIds: [],
    newQuestions: [],
  }];
  run.context.resultIds = ['result-one'];
  const decision = await evaluateCompletionWithClaude({
    run,
    dependencies: createDependencies([
      {
        type: 'result',
        structured_output: {
          completed: true,
          reason: 'Evidence is sufficient.',
          finalAgentResultId: 'result-one',
        },
      },
    ]),
  });

  assert.deepEqual(decision, {
    completed: true,
    reason: 'Evidence is sufficient.',
    finalAgentResultId: 'result-one',
  });
});

test('Agent Runtime persists and resumes the execution-scoped Agent Session', async () => {
  const run = createRun();
  const agent = run.graphSnapshot.agents[0];
  let options;
  const sessionContexts = [];
  const dependencies = {
    ...createDependencies([
      { type: 'system', session_id: 'agent-session-one' },
      {
        type: 'result',
        session_id: 'agent-session-one',
        structured_output: {
          status: 'completed',
          message: 'Evidence-backed report',
          artifacts: [],
          findings: [{ content: 'Churn is stable', sourceArtifacts: [], confidence: 0.9 }],
          questions: [],
        },
      },
    ], (value) => { options = value; }),
    skillContextRecorder: { recordSession: (input) => sessionContexts.push(input) },
    loadSkills: async () => [],
  };

  const response = await executeAgentWithClaude({
    run,
    agent,
    decision: { selectedAgentId: 'reports', reason: 'Need report', task: 'Create the report' },
    agentSession: { agentId: 'reports', providerSessionId: 'agent-session-one' },
    agentContext: {
      executionId: 'execution-one',
      goal: run.context.goal,
      iteration: 2,
      currentNeed: 'Create the report',
      questions: [],
      relevantArtifacts: [],
      relevantFindings: [],
      relevantResults: [],
      includedArtifactIds: [],
      includedFindingIds: [],
      includedResultIds: [],
      resumedSession: true,
    },
    dependencies,
  });

  assert.equal(options.persistSession, true);
  assert.equal(options.resume, 'agent-session-one');
  assert.equal(response.sessionId, 'agent-session-one');
  assert.equal(response.agentResult.status, 'completed');
  assert.equal(response.agentResult.message, 'Evidence-backed report');
  assert.deepEqual(sessionContexts, [{
    tenantId: 1, userId: 2, workspaceId: 3, provider: 'claude', sessionId: 'agent-session-one',
    contextId: 'session:agent-session-one', requestId: null, origin: 'agent_graph', skillName: null,
  }]);
});

test('Graph records observed session provenance before a failed turn and never fabricates a session id', async () => {
  const contexts = [];
  const dependencies = {
    ...createDependencies([]),
    skillContextRecorder: { recordSession: (input) => contexts.push(input) },
    runQuery: async function* () {
      yield { type: 'system', session_id: 'failed-graph-session' };
      throw new Error('fixture upstream failure');
    },
  };
  await assert.rejects(() => selectAgentWithClaude({ run: createRun(), dependencies }), /fixture upstream failure/);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].origin, 'agent_graph');
  assert.equal(contexts[0].sessionId, 'failed-graph-session');

  await selectAgentWithClaude({
    run: createRun(),
    dependencies: {
      ...createDependencies([{ type: 'result', structured_output: { selectedAgentId: 'reports', reason: 'Ready', task: 'Report' } }]),
      skillContextRecorder: { recordSession: (input) => contexts.push(input) },
    },
  });
  assert.equal(contexts.length, 1, 'Turns without an observed session id must not create provenance');
});

test('Graph provenance recorder failures do not change the model result', async () => {
  const decision = { selectedAgentId: 'reports', reason: 'Ready', task: 'Report' };
  const result = await selectAgentWithClaude({
    run: createRun(),
    dependencies: {
      ...createDependencies([{ type: 'result', session_id: 'graph-session', structured_output: decision }]),
      skillContextRecorder: { recordSession: () => { throw new Error('fixture recorder unavailable'); } },
    },
  });
  assert.deepEqual(result, decision);
});

test('Agent Tool labels resolve to the configured Demo MCP server names', () => {
  const result = resolveAgentTools({
    tools: ['Hive MCP', 'BI查询MCP', '标签查询MCP'],
  }, {
    'hive-mcp': { type: 'http', url: 'http://example.test/hive' },
    'bi-query-mcp': { type: 'http', url: 'http://example.test/bi-query' },
    'tag-query-mcp': { type: 'http', url: 'http://example.test/tag-query' },
  });

  assert.deepEqual(Object.keys(result.mcpServers), [
    'hive-mcp',
    'bi-query-mcp',
    'tag-query-mcp',
  ]);
  assert.ok(result.toolNames.includes('mcp__hive-mcp__*'));
  assert.ok(result.toolNames.includes('mcp__bi-query-mcp__*'));
  assert.ok(result.toolNames.includes('mcp__tag-query-mcp__*'));
});
