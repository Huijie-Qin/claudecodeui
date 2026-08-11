import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentGraph,
  buildSkillCreatorFallback,
  buildSkillCreatorOptimizationFallback,
  deleteAgentGraph,
  generateTopSkill,
  listAgentGraphs,
  normalizeAgentGraph,
  optimizeTopSkill,
  updateAgentGraph,
} from './agent-graphs.js';

function graph(overrides = {}) {
  return {
    id: 'graph-one',
    name: 'Retention team',
    goal: 'Explain user churn with evidence.',
    agents: [],
    relations: [],
    ...overrides,
  };
}

test('Agent Graph store persists workspace-scoped JSON and supports CRUD', async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-graphs-'));
  const created = await createAgentGraph({ workspacePath, graph: graph() });

  assert.equal(created.id, 'graph-one');
  assert.deepEqual(await listAgentGraphs(workspacePath), [created]);

  const updated = await updateAgentGraph({
    workspacePath,
    graphId: created.id,
    graph: { ...created, goal: 'Updated goal' },
  });
  assert.equal(updated.goal, 'Updated goal');
  assert.equal((await listAgentGraphs(workspacePath))[0].goal, 'Updated goal');

  await deleteAgentGraph({ workspacePath, graphId: created.id });
  assert.deepEqual(await listAgentGraphs(workspacePath), []);

  const stored = JSON.parse(await fs.readFile(path.join(workspacePath, '.ccui', 'agent-graphs.json'), 'utf8'));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.graphs, []);
});

test('normalizeAgentGraph rejects Relations that reference missing Agents', () => {
  assert.throws(() => normalizeAgentGraph(graph({
    relations: [{ id: 'rel-one', sourceAgent: 'missing-a', targetAgent: 'missing-b', description: 'Shares data' }],
  })), /references an Agent/);
});

test('generateTopSkill runs expanded skill-creator instructions without persisting a provider session', async () => {
  const seen = {};
  const runtimeManager = {
    prepareClaudeRuntime: async (options) => {
      seen.runtimeOptions = options;
      return { runtimeId: 'runtime-one', cwd: options.cwd, projectPath: options.projectPath };
    },
    markIdle: (runtimeId) => { seen.idleRuntimeId = runtimeId; },
    markFailed: (runtimeId) => { seen.failedRuntimeId = runtimeId; },
  };
  async function* runQuery(input) {
    seen.query = input;
    yield {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: [
            '## Role',
            'Analyze retention.',
            '## Responsibility',
            '- Find evidence.',
            '## Working Method',
            '1. Inspect data.',
            '## Skill Usage Guidance',
            '- Use SQL when metrics are needed.',
            '## Tool Usage Guidance',
            '- Use Hive MCP for warehouse data.',
            '## Input Understanding',
            '- Confirm scope.',
            '## Output Requirement',
            '- Provide evidence and recommendations.',
          ].join('\n\n'),
        }],
      },
    };
  }

  const result = await generateTopSkill({
    workspacePath: '/tmp/workspace',
    tenantId: 2,
    userId: 7,
    workspaceId: 10,
    input: {
      name: 'Retention Analyst',
      workingDescription: 'Analyze churn and recommend improvements.',
      businessContext: 'Consumer app',
      skills: ['SQL'],
      tools: ['Hive MCP'],
    },
    runtimeManager,
    runQuery,
    mapOptions: (options) => ({ ...options }),
    expand: async ({ prompt }) => ({ prompt: `expanded skill-creator\n${prompt}`, expanded: true, namespace: 'project-skill' }),
  });

  assert.equal(result.generator, 'skill-creator');
  assert.equal(result.source, 'project-skill');
  assert.match(result.topSkill, /^---\nname: retention-analyst/m);
  assert.match(result.topSkill, /^## Output Requirement$/m);
  assert.equal(seen.query.options.persistSession, false);
  assert.equal(seen.query.options.maxTurns, 1);
  assert.deepEqual(seen.query.options.tools, []);
  assert.equal(seen.idleRuntimeId, 'runtime-one');
  assert.equal(seen.failedRuntimeId, undefined);
});

test('generateTopSkill falls back to the built-in skill-creator template when Claude is not logged in', async () => {
  const seen = {};
  const runtimeManager = {
    prepareClaudeRuntime: async (options) => ({ runtimeId: 'runtime-auth', cwd: options.cwd }),
    markIdle: (runtimeId) => { seen.idleRuntimeId = runtimeId; },
    markFailed: (runtimeId) => { seen.failedRuntimeId = runtimeId; },
  };
  async function* runQuery() {
    throw new Error('Claude Code returned an error result: Not logged in · Please run /login');
  }

  const input = {
    name: '音乐洞察分析师',
    workingDescription: '查询音乐报表并分析用户画像。',
    businessContext: 'Agent Graph 验证',
    skills: ['query-music-app-reports', 'analyze-music-audiences'],
    tools: ['标签服务 MCP'],
  };
  const result = await generateTopSkill({
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 1,
    workspaceId: 1,
    input,
    runtimeManager,
    runQuery,
    mapOptions: (options) => ({ ...options }),
    expand: async ({ prompt }) => ({ prompt, expanded: false }),
  });

  assert.equal(result.generator, 'skill-creator');
  assert.equal(result.source, 'built-in:auth-fallback');
  assert.match(result.topSkill, /^## Role$/m);
  assert.match(result.topSkill, /^## Output Requirement$/m);
  assert.match(result.topSkill, /query-music-app-reports/);
  assert.match(result.topSkill, /标签服务 MCP/);
  assert.equal(seen.idleRuntimeId, 'runtime-auth');
  assert.equal(seen.failedRuntimeId, undefined);
});

test('built-in Top Skill fallback is a complete SKILL.md and does not hide non-authentication failures', async () => {
  const fallback = buildSkillCreatorFallback({
    name: 'Evidence Agent',
    workingDescription: 'Analyze evidence.',
    businessContext: '',
    skills: [],
    tools: [],
  });
  assert.match(fallback, /^---\nname: evidence-agent/m);
  assert.match(fallback, /^## Skill Usage Guidance$/m);
  assert.match(fallback, /不得声称已调用外部系统/);

  const seen = {};
  const runtimeManager = {
    prepareClaudeRuntime: async (options) => ({ runtimeId: 'runtime-network', cwd: options.cwd }),
    markIdle: (runtimeId) => { seen.idleRuntimeId = runtimeId; },
    markFailed: (runtimeId) => { seen.failedRuntimeId = runtimeId; },
  };
  async function* runQuery() {
    throw new Error('upstream service unavailable');
  }
  await assert.rejects(() => generateTopSkill({
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 1,
    workspaceId: 1,
    input: {
      name: 'Evidence Agent',
      workingDescription: 'Analyze evidence.',
      skills: [],
      tools: [],
    },
    runtimeManager,
    runQuery,
    mapOptions: (options) => ({ ...options }),
    expand: async ({ prompt }) => ({ prompt, expanded: false }),
  }), /upstream service unavailable/);
  assert.equal(seen.failedRuntimeId, 'runtime-network');
  assert.equal(seen.idleRuntimeId, undefined);
});

test('optimizeTopSkill sends the current skill and user prompt through skill-creator', async () => {
  const seen = {};
  const currentTopSkill = buildSkillCreatorFallback({
    name: 'Evidence Agent',
    workingDescription: 'Analyze evidence.',
    businessContext: '',
    skills: ['report-query'],
    tools: [],
  });
  const optimizedSkill = currentTopSkill.replace(
    '- 先给核心结论，再给关键证据与分析过程。',
    '- 先给三条以内的核心结论，再给关键证据与分析过程。',
  );
  const runtimeManager = {
    prepareClaudeRuntime: async (options) => ({ runtimeId: 'runtime-optimize', cwd: options.cwd }),
    markIdle: (runtimeId) => { seen.idleRuntimeId = runtimeId; },
    markFailed: (runtimeId) => { seen.failedRuntimeId = runtimeId; },
  };
  async function* runQuery(input) {
    seen.query = input;
    yield { type: 'result', result: optimizedSkill };
  }

  const result = await optimizeTopSkill({
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 1,
    workspaceId: 1,
    input: {
      name: 'Evidence Agent',
      workingDescription: 'Analyze evidence.',
      businessContext: '',
      skills: ['report-query'],
      tools: [],
      currentTopSkill,
      optimizationPrompt: '核心结论最多三条。',
    },
    runtimeManager,
    runQuery,
    mapOptions: (options) => ({ ...options }),
    expand: async ({ prompt }) => {
      seen.invocation = prompt;
      return { prompt: `expanded\n${prompt}`, expanded: true, namespace: 'project-skill' };
    },
  });

  assert.match(seen.invocation, /^\/skill-creator /);
  assert.match(seen.invocation, /核心结论最多三条/);
  assert.match(seen.invocation, /Existing Top Skill:/);
  assert.equal(result.source, 'project-skill');
  assert.match(result.topSkill, /三条以内/);
  assert.equal(seen.idleRuntimeId, 'runtime-optimize');
  assert.equal(seen.failedRuntimeId, undefined);
});

test('optimization auth fallback preserves the skill and appends actionable guidance', async () => {
  const currentTopSkill = buildSkillCreatorFallback({
    name: 'Evidence Agent',
    workingDescription: 'Analyze evidence.',
    businessContext: '',
    skills: [],
    tools: [],
  });
  const fallback = buildSkillCreatorOptimizationFallback({
    currentTopSkill,
    optimizationPrompt: '输出中增加数据质量风险。',
  });
  assert.match(fallback, /^## Optimization Guidance$/m);
  assert.match(fallback, /输出中增加数据质量风险/);
  assert.match(fallback, /^## Output Requirement$/m);

  async function* runQuery() {
    throw new Error('Not logged in · Please run /login');
  }
  const runtimeManager = {
    prepareClaudeRuntime: async (options) => ({ runtimeId: 'runtime-optimize-fallback', cwd: options.cwd }),
    markIdle: () => {},
    markFailed: () => {},
  };
  const result = await optimizeTopSkill({
    workspacePath: '/tmp/workspace',
    tenantId: 1,
    userId: 1,
    workspaceId: 1,
    input: {
      name: 'Evidence Agent',
      workingDescription: 'Analyze evidence.',
      businessContext: '',
      skills: [],
      tools: [],
      currentTopSkill,
      optimizationPrompt: '输出中增加数据质量风险。',
    },
    runtimeManager,
    runQuery,
    mapOptions: (options) => ({ ...options }),
    expand: async ({ prompt }) => ({ prompt, expanded: false }),
  });
  assert.equal(result.source, 'built-in:auth-fallback');
  assert.match(result.topSkill, /^## Optimization Guidance$/m);
});
