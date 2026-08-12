import { promises as fs } from 'node:fs';
import path from 'node:path';

import { agentSessionRuntimeManager } from './agent-session-runtime.js';
import { buildAgentSpecificContext, buildControllerContext } from './agent-graph-context-builder.js';
import { applyMcpConfigToSdkOptions, loadMcpConfig } from './claude-mcp-config.js';
import { listWorkspaceSkills, reconcileWorkspaceSkillsForAgentTurn } from './workspace-skills.js';

const MAX_SELECTOR_AGENT_PROFILE = 4_000;
const MAX_AGENT_RESULT = 120_000;
const MAX_AGENT_RUNTIME_TURNS = 24;
const MAX_AGENT_TOOL_CALLS = 8;
const MAX_CONTROL_PLANE_TURNS = 3;
export const AGENT_GRAPH_CLAUDE_RUNTIME_CONFIG = Object.freeze({
  provider: 'claude',
  activationDecisionMaxTurns: MAX_CONTROL_PLANE_TURNS,
  completionDecisionMaxTurns: MAX_CONTROL_PLANE_TURNS,
  agentMaxTurns: MAX_AGENT_RUNTIME_TURNS,
  agentMaxToolCalls: MAX_AGENT_TOOL_CALLS,
  structuredAgentResult: true,
  controllerSessionsPersisted: false,
  agentSessionsPersisted: true,
  agentSessionsReusedWithinExecution: true,
  agentSessionsReusedAcrossExecutions: false,
});
const SKILL_RUNTIME_TOOLS = ['Read', 'Glob', 'Grep', 'Bash'];
const ACTIVATION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      selectedAgentId: { type: 'string' },
      reason: { type: 'string' },
      task: { type: 'string' },
    },
    required: ['selectedAgentId', 'reason', 'task'],
    additionalProperties: false,
  },
};
const COMPLETION_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      completed: { type: 'boolean' },
      reason: { type: 'string' },
      finalAgentResultId: { type: 'string' },
    },
    required: ['completed', 'reason', 'finalAgentResultId'],
    additionalProperties: false,
  },
};
const AGENT_RESULT_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      agent: { type: 'string' },
      summary: { type: 'string' },
      type: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      newQuestions: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' },
    },
    required: ['agent', 'summary', 'type', 'findings', 'newQuestions', 'confidence'],
    additionalProperties: false,
  },
};
const BUILT_IN_TOOL_NAMES = {
  read: ['Read'],
  write: ['Write', 'Edit'],
  search: ['Glob', 'Grep'],
  terminal: ['Bash'],
};
export const AGENT_GRAPH_MCP_BINDING_ALIASES = Object.freeze({
  'Hive MCP': 'hive-mcp',
  'BI查询MCP': 'bi-query-mcp',
  '标签查询MCP': 'tag-query-mcp',
});

function createHttpError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function isClaudeAuthenticationError(error) {
  return /not logged in|please run \/login|authentication[_ ]error|invalid (?:api )?key|api key (?:is )?(?:missing|not found)/i
    .test([error?.message, error?.cause?.message].filter(Boolean).join('\n'));
}

function extractAssistantText(message) {
  if (message?.type === 'assistant' && Array.isArray(message.message?.content)) {
    return message.message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  if (message?.type === 'result' && typeof message.result === 'string') {
    return message.result;
  }
  return '';
}

async function runClaudeTurn({
  workspacePath,
  tenantId,
  userId,
  workspaceId,
  prompt,
  systemPrompt,
  tools,
  mcpServers,
  capabilityResolver = null,
  maxTurns,
  outputFormat = null,
  persistSession = false,
  resumeSessionId = null,
  abortController,
  runQuery = null,
  runtimeManager = agentSessionRuntimeManager,
  mapOptions = null,
}) {
  const query = runQuery || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const effectiveMapOptions = mapOptions
    || (await import('../claude-sdk.js')).mapCliOptionsToSDK;
  let runtimeContext = null;
  let succeeded = false;
  try {
    runtimeContext = await runtimeManager.prepareClaudeRuntime({
      tenantId,
      userId,
      workspaceId,
      cwd: workspacePath,
      projectPath: workspacePath,
    });
    const sdkOptions = effectiveMapOptions({
      cwd: runtimeContext.cwd || workspacePath,
      projectPath: runtimeContext.projectPath || workspacePath,
      pathToClaudeCodeExecutable: runtimeContext.pathToClaudeCodeExecutable,
      executableArgs: runtimeContext.executableArgs,
      spawnClaudeCodeProcess: runtimeContext.spawnClaudeCodeProcess,
      executionEnv: runtimeContext.executionEnv,
      settingSources: runtimeContext.settingSources,
      permissionMode: 'bypassPermissions',
    });
    sdkOptions.persistSession = persistSession;
    if (resumeSessionId) sdkOptions.resume = resumeSessionId;
    sdkOptions.includePartialMessages = false;
    sdkOptions.maxTurns = maxTurns;
    sdkOptions.systemPrompt = systemPrompt;
    if (outputFormat) sdkOptions.outputFormat = outputFormat;
    const capabilities = capabilityResolver
      ? await capabilityResolver(runtimeContext)
      : { tools, mcpServers };
    sdkOptions.allowedTools = capabilities.tools;
    sdkOptions.tools = capabilities.tools.filter((toolName) => !toolName.startsWith('mcp__'));
    if (abortController) sdkOptions.abortController = abortController;
    applyMcpConfigToSdkOptions(sdkOptions, capabilities.mcpServers);

    let responseText = '';
    let structuredOutput = null;
    let sessionId = null;
    for await (const message of query({ prompt, options: sdkOptions })) {
      if (abortController?.signal.aborted) {
        throw createHttpError('Agent Graph run was cancelled', 409);
      }
      if (message?.session_id) sessionId = message.session_id;
      if (message?.type === 'result' && message.structured_output !== undefined) {
        structuredOutput = message.structured_output;
      }
      const text = extractAssistantText(message);
      if (text) responseText = text;
    }
    if (!responseText.trim() && structuredOutput === null) {
      throw createHttpError('Claude returned an empty Agent Graph response', 502);
    }
    if (responseText.length > MAX_AGENT_RESULT) {
      throw createHttpError('Agent Graph response is too large', 502);
    }
    succeeded = true;
    return { text: responseText.trim(), structuredOutput, sessionId };
  } catch (error) {
    if (isClaudeAuthenticationError(error)) {
      throw createHttpError('Claude authentication is required to run an Agent Graph. Configure Claude credentials and try again.', 401);
    }
    throw error;
  } finally {
    if (runtimeContext?.runtimeId) {
      if (succeeded || abortController?.signal.aborted) runtimeManager.markIdle(runtimeContext.runtimeId);
      else runtimeManager.markFailed(runtimeContext.runtimeId);
    }
  }
}

function parseJsonObject(raw, errorMessage) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  } else {
    let content = String(raw || '').trim();
    const fenced = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) content = fenced[1].trim();
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) content = content.slice(start, end + 1);

    try {
      return JSON.parse(content);
    } catch {
      throw createHttpError(errorMessage, 502);
    }
  }
}

function parseActivationDecision(raw, agentIds, excludedAgentIds = new Set()) {
  const parsed = parseJsonObject(raw, 'Graph Executor could not parse the Agent Activation decision');
  const selectedAgentId = typeof parsed?.selectedAgentId === 'string' ? parsed.selectedAgentId.trim() : '';
  if (!agentIds.has(selectedAgentId)) {
    throw createHttpError('Graph Executor selected an Agent that is not in this Graph', 502);
  }
  if (excludedAgentIds.has(selectedAgentId)) {
    throw createHttpError('Graph Executor selected an Agent excluded by the repetition guard', 502);
  }
  return {
    selectedAgentId,
    reason: typeof parsed?.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'Selected based on the current Execution Context.',
    task: typeof parsed?.task === 'string' ? parsed.task.trim() : '',
  };
}

function parseCompletionDecision(raw, resultIds) {
  const parsed = parseJsonObject(raw, 'Graph Executor could not parse the Loop completion decision');
  const completed = parsed?.completed === true;
  const finalAgentResultId = typeof parsed?.finalAgentResultId === 'string'
    ? parsed.finalAgentResultId.trim()
    : '';
  if (completed && !resultIds.has(finalAgentResultId)) {
    throw createHttpError('Completion Controller selected an Agent Result that is not in this Graph execution', 502);
  }
  return {
    completed,
    reason: typeof parsed?.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : completed ? 'The Graph goal is complete.' : 'More collaboration is required.',
    finalAgentResultId: completed ? finalAgentResultId : '',
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))].slice(0, 50);
}

function parseAgentResult(raw, agentName, fallbackText = '') {
  let parsed;
  try {
    parsed = parseJsonObject(raw, 'Agent Runtime could not parse the structured Agent result');
  } catch {
    const summary = String(fallbackText || raw || '').trim();
    if (!summary) throw createHttpError('Agent Runtime returned an empty result', 502);
    return { agent: agentName, summary, type: 'agent_result', findings: [summary], newQuestions: [], confidence: 0.5 };
  }
  const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
  if (!summary) throw createHttpError('Agent Runtime returned an empty result summary', 502);
  const confidence = Number(parsed?.confidence);
  return {
    agent: typeof parsed?.agent === 'string' && parsed.agent.trim() ? parsed.agent.trim() : agentName,
    summary,
    type: typeof parsed?.type === 'string' && parsed.type.trim() ? parsed.type.trim() : 'agent_result',
    findings: normalizeStringList(parsed?.findings),
    newQuestions: normalizeStringList(parsed?.newQuestions),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
  };
}

function formatAgentResult(result) {
  const sections = [`Type: ${result.type}`, result.summary];
  if (result.findings.length) sections.push(`Findings:\n${result.findings.map((entry) => `- ${entry}`).join('\n')}`);
  if (result.newQuestions.length) sections.push(`New questions:\n${result.newQuestions.map((entry) => `- ${entry}`).join('\n')}`);
  sections.push(`Confidence: ${result.confidence}`);
  return sections.join('\n\n');
}

export async function selectAgentWithClaude({
  run,
  abortController,
  excludedAgentIds = [],
  reconsiderationReason = '',
  dependencies = {},
}) {
  const graph = run.graphSnapshot;
  const excluded = new Set(excludedAgentIds);
  const profiles = graph.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    workingDescription: agent.workingDescription,
    skills: agent.skills,
    tools: agent.tools,
    topSkill: agent.topSkill.slice(0, MAX_SELECTOR_AGENT_PROFILE),
    activationCount: run.agentStates.find((state) => state.agentId === agent.id)?.activationCount || 0,
  }));
  const prompt = [
    'Decide which Agent should be activated next for this Agent Graph run.',
    'The Graph is not a workflow. Relations are collaboration and capability hints only; never treat them as required execution edges or a fixed order.',
    'Use the current goal, shared Context, Agent responsibilities, Top Skills, prior results, and Relations.',
    'Select the best Agent even if it is not adjacent to the previously selected Agent.',
    'Avoid repeating an Agent unless another activation is materially necessary.',
    'Only select an Agent. Completion is evaluated separately after that Agent updates the shared Context.',
    excluded.size ? `Do not select these Agents for this reconsideration: ${[...excluded].join(', ')}` : '',
    reconsiderationReason ? `Reconsideration reason: ${reconsiderationReason}` : '',
    '',
    `Graph: ${JSON.stringify({ id: graph.id, name: graph.name, goal: graph.goal, agents: profiles, relations: graph.relations })}`,
    '',
    `Execution Context and referenced store summaries: ${JSON.stringify(buildControllerContext(run))}`,
    '',
    'Return JSON only using this Executor-internal decision shape:',
    '{"selectedAgentId":"agent-id","reason":"why this Agent fits now","task":"natural-language task for this activation"}',
  ].join('\n');
  const result = await runClaudeTurn({
    workspacePath: run.workspacePath,
    tenantId: run.tenantId,
    userId: run.userId,
    workspaceId: run.workspaceId,
    prompt,
    systemPrompt: 'You are the control-plane Agent Activation component of Graph Executor. Coordinate Agents but never call Skills or Tools. Return only the requested JSON.',
    tools: [],
    mcpServers: null,
    maxTurns: MAX_CONTROL_PLANE_TURNS,
    outputFormat: ACTIVATION_OUTPUT_FORMAT,
    abortController,
    ...dependencies,
  });
  return parseActivationDecision(
    result.structuredOutput ?? result.text,
    new Set(graph.agents.map((agent) => agent.id)),
    excluded,
  );
}

export async function evaluateCompletionWithClaude({ run, abortController, dependencies = {} }) {
  const controllerContext = buildControllerContext(run);
  const prompt = [
    'Decide whether the Agent Graph collaboration goal is complete after the latest Agent result updated the shared Context.',
    'The Graph is not a workflow. Judge evidence sufficiency, unresolved questions, limitations, and the original user goal.',
    'Do not call Skills, Tools, MCP, or Agents. Do not write, synthesize, rewrite, or improve any business answer.',
    'When complete, select exactly one existing Agent Result as the final result source.',
    '',
    `Graph goal: ${run.graphSnapshot.goal}`,
    `Execution Context, Evidence, and Agent Results: ${JSON.stringify(controllerContext)}`,
    '',
    'Return JSON only:',
    '{"completed":false,"reason":"why collaboration should continue or stop","finalAgentResultId":"existing result id when completed, otherwise empty"}',
  ].join('\n');
  const result = await runClaudeTurn({
    workspacePath: run.workspacePath,
    tenantId: run.tenantId,
    userId: run.userId,
    workspaceId: run.workspaceId,
    prompt,
    systemPrompt: 'You are the stateless completion-control component of Graph Executor. Evaluate existing state only. Never author a business answer. Return only the requested JSON.',
    tools: [],
    mcpServers: null,
    maxTurns: MAX_CONTROL_PLANE_TURNS,
    outputFormat: COMPLETION_OUTPUT_FORMAT,
    abortController,
    ...dependencies,
  });
  return parseCompletionDecision(
    result.structuredOutput ?? result.text,
    new Set((run.resultStore || []).map((entry) => entry.resultId)),
  );
}

async function loadBoundSkills(workspacePath, skillNames) {
  await reconcileWorkspaceSkillsForAgentTurn({ workspacePath });
  const inventory = await listWorkspaceSkills(workspacePath);
  const byName = new Map(inventory.skills.map((skill) => [skill.name, skill]));
  return Promise.all(skillNames.map(async (name) => {
    const skill = byName.get(name);
    if (!skill || !skill.enabled || skill.status === 'invalid') {
      throw createHttpError(`Bound Skill is unavailable: ${name}`, 409);
    }
    const content = await fs.readFile(skill.manifestPath, 'utf8');
    return { name, content, runtimePath: skill.runtimePath || path.dirname(skill.manifestPath) };
  }));
}

export function resolveAgentTools(agent, mcpServers) {
  const selected = new Set(SKILL_RUNTIME_TOOLS);
  for (const tool of agent.tools) {
    for (const builtIn of BUILT_IN_TOOL_NAMES[String(tool).toLowerCase()] || []) selected.add(builtIn);
  }
  const selectedMcp = {};
  for (const tool of agent.tools) {
    const serverName = mcpServers?.[tool]
      ? tool
      : AGENT_GRAPH_MCP_BINDING_ALIASES[tool];
    if (serverName && mcpServers?.[serverName]) {
      selectedMcp[serverName] = mcpServers[serverName];
      selected.add(`mcp__${serverName}__*`);
    }
  }
  return { toolNames: [...selected], mcpServers: selectedMcp };
}

export async function executeAgentWithClaude({
  run,
  agent,
  decision,
  agentSession,
  agentContext,
  abortController,
  dependencies = {},
}) {
  const { loadSkills = loadBoundSkills, ...runtimeDependencies } = dependencies;
  const skills = await loadSkills(run.workspacePath, agent.skills);
  const skillInstructions = skills.map((skill) => [
    `### Bound Skill: ${skill.name}`,
    `Runtime directory: ${skill.runtimePath}`,
    'Resolve relative paths mentioned by this Skill against that runtime directory.',
    skill.content,
  ].join('\n')).join('\n\n');
  const systemPrompt = [
    agent.topSkill,
    '',
    '# Runtime contract',
    `You are the independent Agent named "${agent.name}" inside an Agent Graph run.`,
    'Use only the bound Skills and Tool/MCP capabilities listed below. Decide autonomously which of them are needed.',
    'Do not invoke or communicate with another Agent. Your internal analysis loop belongs to Agent Runtime; independently investigate hypotheses with your bound Skills and Tools before returning.',
    `Your activation has a bounded execution budget. Use no more than ${MAX_AGENT_TOOL_CALLS} tool calls, avoid repeating an equivalent query, and reserve enough turns to return the required AgentResult.`,
    'A bound Tool/MCP name is only callable when a matching tool is actually present in your runtime tool list. If it is absent, treat it as not configured, do not retry or emulate it, and record the limitation in findings or newQuestions.',
    'Return a structured AgentResult containing: agent, summary, type, findings, newQuestions, and confidence from 0 to 1. Keep evidence and important limitations in summary/findings.',
    'Do not modify the Graph or your Top Skill.',
    '',
    skillInstructions || 'No Skills are bound.',
    '',
    `Bound Tool/MCP names: ${agent.tools.length ? agent.tools.join(', ') : 'None'}`,
  ].join('\n');
  const specificContext = agentContext || buildAgentSpecificContext({ run, agent, agentSession });
  const prompt = [
    specificContext.resumedSession
      ? 'Continue this Agent task in your existing execution-scoped Claude Session. Use only the new task and context delta below; do not repeat completed investigation unless needed.'
      : 'Start this Agent task using the execution-scoped context below.',
    '',
    `Your current task:\n${decision.task || decision.reason}`,
    '',
    `Agent-specific Context:\n${JSON.stringify(specificContext, null, 2)}`,
    '',
    `Continue according to your Top Skill. Complete the most valuable analysis within at most ${MAX_AGENT_TOOL_CALLS} tool calls, then stop investigating and return the structured AgentResult for the shared Context. If evidence is incomplete, return what is supported and put the remaining gaps in newQuestions.`,
  ].join('\n');
  const result = await runClaudeTurn({
    workspacePath: run.workspacePath,
    tenantId: run.tenantId,
    userId: run.userId,
    workspaceId: run.workspaceId,
    prompt,
    systemPrompt,
    tools: SKILL_RUNTIME_TOOLS,
    mcpServers: null,
    capabilityResolver: async (runtimeContext) => {
      const allMcpServers = await loadMcpConfig(run.workspacePath, {
        includeHostConfig: !runtimeContext.disableHostMcpConfig,
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
        runtimeMode: runtimeContext.mode,
        runtimeHomePath: runtimeContext.runtimeHomePath,
      });
      const capabilities = resolveAgentTools(agent, allMcpServers);
      return { tools: capabilities.toolNames, mcpServers: capabilities.mcpServers };
    },
    maxTurns: MAX_AGENT_RUNTIME_TURNS,
    outputFormat: AGENT_RESULT_OUTPUT_FORMAT,
    persistSession: true,
    resumeSessionId: agentSession?.providerSessionId || null,
    abortController,
    ...runtimeDependencies,
  });
  const agentResult = parseAgentResult(result.structuredOutput ?? result.text, agent.name, result.text);
  return {
    ...result,
    text: formatAgentResult(agentResult),
    agentResult,
  };
}
