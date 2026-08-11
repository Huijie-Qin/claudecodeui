import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
    context: {
      goal: 'Explain music-app churn with evidence.',
      userInput: 'Analyze churn',
      findings: [],
      agentResults: [],
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
  run.context.agentResults = [{
    id: 'result-one',
    agentId: 'reports',
    agentName: 'Report Agent',
    summary: 'Evidence-backed report',
    content: 'Evidence-backed report',
    newQuestions: [],
  }];
  const decision = await evaluateCompletionWithClaude({
    run,
    dependencies: createDependencies([
      {
        type: 'result',
        structured_output: {
          completed: true,
          reason: 'Evidence is sufficient.',
          finalAnswer: 'Synthesized final report.',
        },
      },
    ]),
  });

  assert.deepEqual(decision, {
    completed: true,
    reason: 'Evidence is sufficient.',
    finalAnswer: 'Synthesized final report.',
  });
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
