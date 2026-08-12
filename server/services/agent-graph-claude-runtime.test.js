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
    evidenceStore: [],
    context: {
      executionId: 'execution-one',
      goal: 'Explain music-app churn with evidence.',
      status: 'running',
      iteration: 1,
      currentNeed: 'Analyze churn',
      evidenceIds: [],
      resultIds: [],
      pendingQuestions: [],
    },
  };
}

function createDependencies(messages, onOptions = () => {}) {
  return {
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
  const dependencies = {
    ...createDependencies([
      {
        type: 'result',
        session_id: 'agent-session-one',
        structured_output: {
          agent: 'Report Agent',
          summary: 'Evidence-backed report',
          type: 'report',
          findings: ['Churn is stable'],
          newQuestions: [],
          confidence: 0.9,
        },
      },
    ], (value) => { options = value; }),
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
      pendingQuestions: [],
      relevantEvidence: [],
      relevantResults: [],
      includedEvidenceIds: [],
      includedResultIds: [],
      resumedSession: true,
    },
    dependencies,
  });

  assert.equal(options.persistSession, true);
  assert.equal(options.resume, 'agent-session-one');
  assert.equal(response.sessionId, 'agent-session-one');
  assert.equal(response.agentResult.type, 'report');
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
