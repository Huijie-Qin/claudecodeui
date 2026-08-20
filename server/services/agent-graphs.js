import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { findAppRoot, getModuleDir } from '../utils/runtime-paths.js';

import { applyWorkspaceOwnership } from './workspace-ownership.js';
import { expandLeadingSkillCommand } from './skill-command-expander.js';

const STORE_VERSION = 1;
const STORE_DIRECTORY = '.ccui';
const STORE_FILE = 'agent-graphs.json';
const MAX_GRAPHS = 100;
const MAX_AGENTS = 200;
const MAX_RELATIONS = 500;
const MAX_TOP_SKILL_LENGTH = 120_000;
const REQUIRED_TOP_SKILL_SECTIONS = [
  'Role',
  'Responsibility',
  'Working Method',
  'Skill Usage Guidance',
  'Tool Usage Guidance',
  'Input Understanding',
  'Output Requirement',
];

const APP_ROOT = findAppRoot(getModuleDir(import.meta.url));
const BUILT_IN_SKILL_CREATOR_PATH = path.join(APP_ROOT, 'server', 'skills', 'skill-creator', 'SKILL.md');
const BUILT_IN_SKILL_CREATOR = `---
name: skill-creator
description: Create concise, reusable SKILL.md instructions for an Agent.
---

# Skill Creator

Create a complete SKILL.md that another Agent can follow without additional explanation.
Keep instructions concise and operational. Describe when each bound Skill and Tool should be used.
Treat the Agent as an independent capability unit, not as a workflow step. Do not define a fixed
cross-Agent execution order, branching, loops, or a Graph runtime. Return only SKILL.md content.

Required second-level sections: Role, Responsibility, Working Method, Skill Usage Guidance,
Tool Usage Guidance, Input Understanding, and Output Requirement.`;

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireString(value, field, { max = 500, allowEmpty = false } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!allowEmpty && !normalized) {
    throw createHttpError(`${field} is required`);
  }
  if (normalized.length > max) {
    throw createHttpError(`${field} must be at most ${max} characters`);
  }
  return normalized;
}

function normalizeStringList(value, field) {
  if (!Array.isArray(value)) {
    throw createHttpError(`${field} must be an array`);
  }
  return [...new Set(value.map((entry, index) => requireString(entry, `${field}[${index}]`, { max: 200 })))]
    .slice(0, 200);
}

function normalizePosition(value, field) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw createHttpError(`${field} must contain finite x and y values`);
  }
  return { x, y };
}

function assertRequiredTopSkillSections(content, statusCode = 400) {
  for (const section of REQUIRED_TOP_SKILL_SECTIONS) {
    const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## ${escapedSection}\\s*$`, 'm').test(content)) {
      throw createHttpError(`Top Skill is missing the required section: ${section}`, statusCode);
    }
  }
}

function normalizeAgent(value, index) {
  const field = `agents[${index}]`;
  const topSkill = requireString(value?.topSkill, `${field}.topSkill`, {
    max: MAX_TOP_SKILL_LENGTH,
  });
  assertRequiredTopSkillSections(topSkill);
  return {
    id: requireString(value?.id, `${field}.id`, { max: 100 }),
    name: requireString(value?.name, `${field}.name`, { max: 200 }),
    topSkill,
    skills: normalizeStringList(value?.skills ?? [], `${field}.skills`),
    tools: normalizeStringList(value?.tools ?? [], `${field}.tools`),
    position: normalizePosition(value?.position, `${field}.position`),
    workingDescription: requireString(value?.workingDescription, `${field}.workingDescription`, {
      max: 10_000,
      allowEmpty: true,
    }),
    businessContext: requireString(value?.businessContext, `${field}.businessContext`, {
      max: 10_000,
      allowEmpty: true,
    }),
  };
}

function normalizeRelation(value, index, agentIds) {
  const field = `relations[${index}]`;
  const sourceAgent = requireString(value?.sourceAgent, `${field}.sourceAgent`, { max: 100 });
  const targetAgent = requireString(value?.targetAgent, `${field}.targetAgent`, { max: 100 });
  if (sourceAgent === targetAgent) {
    throw createHttpError(`${field} must connect two different Agents`);
  }
  if (!agentIds.has(sourceAgent) || !agentIds.has(targetAgent)) {
    throw createHttpError(`${field} references an Agent that is not in this Graph`);
  }
  return {
    id: requireString(value?.id, `${field}.id`, { max: 100 }),
    sourceAgent,
    targetAgent,
    description: requireString(value?.description, `${field}.description`, { max: 2_000 }),
  };
}

export function normalizeAgentGraph(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createHttpError('Graph must be an object');
  }
  if (!Array.isArray(value.agents) || value.agents.length > MAX_AGENTS) {
    throw createHttpError(`agents must be an array with at most ${MAX_AGENTS} entries`);
  }
  if (!Array.isArray(value.relations) || value.relations.length > MAX_RELATIONS) {
    throw createHttpError(`relations must be an array with at most ${MAX_RELATIONS} entries`);
  }

  const agents = value.agents.map(normalizeAgent);
  const agentIds = new Set(agents.map((agent) => agent.id));
  if (agentIds.size !== agents.length) {
    throw createHttpError('Agent ids must be unique within a Graph');
  }
  const relations = value.relations.map((relation, index) => normalizeRelation(relation, index, agentIds));
  if (new Set(relations.map((relation) => relation.id)).size !== relations.length) {
    throw createHttpError('Relation ids must be unique within a Graph');
  }

  return {
    id: requireString(value.id, 'id', { max: 100 }),
    name: requireString(value.name, 'name', { max: 200 }),
    goal: requireString(value.goal, 'goal', { max: 10_000 }),
    agents,
    relations,
  };
}

function getStorePath(workspacePath) {
  return path.join(path.resolve(workspacePath), STORE_DIRECTORY, STORE_FILE);
}

async function readStore(workspacePath) {
  const storePath = getStorePath(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(storePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.graphs)) {
      throw createHttpError('Agent Graph store is invalid', 500);
    }
    return {
      version: STORE_VERSION,
      graphs: parsed.graphs.map(normalizeAgentGraph),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: STORE_VERSION, graphs: [] };
    }
    if (error instanceof SyntaxError) {
      throw createHttpError('Agent Graph store contains invalid JSON', 500);
    }
    throw error;
  }
}

async function writeStore(workspacePath, store) {
  const storePath = getStorePath(workspacePath);
  const storeDirectory = path.dirname(storePath);
  await fs.mkdir(storeDirectory, { recursive: true });
  const tempPath = `${storePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, storePath);
  await applyWorkspaceOwnership({
    workspaceRoot: workspacePath,
    targetPaths: [storePath],
    reason: 'agent_graph_store',
  });
}

function findGraphIndex(store, graphId) {
  return store.graphs.findIndex((graph) => graph.id === graphId);
}

export async function listAgentGraphs(workspacePath) {
  return (await readStore(workspacePath)).graphs;
}

export async function getAgentGraph({ workspacePath, graphId }) {
  const normalizedGraphId = requireString(graphId, 'graphId', { max: 100 });
  const graph = (await readStore(workspacePath)).graphs.find((entry) => entry.id === normalizedGraphId);
  if (!graph) {
    throw createHttpError('Agent Graph not found', 404);
  }
  return graph;
}

export async function createAgentGraph({ workspacePath, graph }) {
  const normalized = normalizeAgentGraph({
    ...graph,
    id: graph?.id || crypto.randomUUID(),
    agents: graph?.agents ?? [],
    relations: graph?.relations ?? [],
  });
  const store = await readStore(workspacePath);
  if (store.graphs.length >= MAX_GRAPHS) {
    throw createHttpError(`A workspace can contain at most ${MAX_GRAPHS} Agent Graphs`);
  }
  if (findGraphIndex(store, normalized.id) !== -1) {
    throw createHttpError('An Agent Graph with this id already exists', 409);
  }
  store.graphs.push(normalized);
  await writeStore(workspacePath, store);
  return normalized;
}

export async function updateAgentGraph({ workspacePath, graphId, graph }) {
  const normalizedGraphId = requireString(graphId, 'graphId', { max: 100 });
  const normalized = normalizeAgentGraph({ ...graph, id: normalizedGraphId });
  const store = await readStore(workspacePath);
  const index = findGraphIndex(store, normalizedGraphId);
  if (index === -1) {
    throw createHttpError('Agent Graph not found', 404);
  }
  store.graphs[index] = normalized;
  await writeStore(workspacePath, store);
  return normalized;
}

export async function deleteAgentGraph({ workspacePath, graphId }) {
  const normalizedGraphId = requireString(graphId, 'graphId', { max: 100 });
  const store = await readStore(workspacePath);
  const index = findGraphIndex(store, normalizedGraphId);
  if (index === -1) {
    throw createHttpError('Agent Graph not found', 404);
  }
  const [removed] = store.graphs.splice(index, 1);
  await writeStore(workspacePath, store);
  return removed;
}

function toSkillSlug(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return normalized || 'agent-top-skill';
}

function toSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function markdownQuote(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => `> ${line || ' '}`)
    .join('\n');
}

function markdownCode(value) {
  return `\`${toSingleLine(value).replace(/`/g, "'")}\``;
}

function guidanceList(values, emptyMessage, buildLine) {
  if (!values.length) return `- ${emptyMessage}`;
  return values.map((value) => `- ${buildLine(value)}`).join('\n');
}

export function buildSkillCreatorFallback(resolved) {
  const name = toSingleLine(resolved.name);
  const description = toSingleLine(resolved.workingDescription);
  const businessContext = resolved.businessContext
    ? `\n\n业务背景：\n\n${markdownQuote(resolved.businessContext)}`
    : '';
  const skillGuidance = guidanceList(
    resolved.skills,
    '当前未绑定下级 Skill；只在已有信息范围内完成任务，并明确能力缺口。',
    (skill) => `当任务需要 ${markdownCode(skill)} 提供的能力时调用该 Skill，并核对其输入、输出与数据口径。`,
  );
  const toolGuidance = guidanceList(
    resolved.tools,
    '当前未绑定 Tool/MCP；不得声称已调用外部系统或取得外部数据。',
    (tool) => `仅在需要外部执行或取数时使用 ${markdownCode(tool)}，检查调用结果后再形成结论。`,
  );

  return `---
name: ${toSkillSlug(name)}
description: ${JSON.stringify(description.slice(0, 240))}
---

# ${name}

## Role

你是“${name}”，按以下工作要求独立完成任务：

${markdownQuote(resolved.workingDescription)}${businessContext}

## Responsibility

- 理解用户目标、对象、范围和交付要求。
- 使用已绑定的 Skill 与 Tool/MCP 获取证据，不虚构未取得的数据或执行结果。
- 区分事实、估算、假设和建议，并说明限制与风险。
- 输出可复核、可执行且符合业务背景的结论。

## Working Method

1. 明确问题、时间范围、分析对象、成功标准和缺失信息。
2. 将任务拆成当前 Agent 可以独立完成的分析步骤，不定义跨 Agent 的固定执行顺序。
3. 选择最少且足够的 Skill 与 Tool/MCP 获取数据或完成操作。
4. 检查数据口径、筛选条件、完整性和相互一致性。
5. 用证据验证主要发现，标记不确定性和替代解释。
6. 按输出要求给出结论、证据、限制和下一步建议。

## Skill Usage Guidance

${skillGuidance}

## Tool Usage Guidance

${toolGuidance}

## Input Understanding

执行前确认：

- 用户问题与业务目标。
- 时间范围、对象范围和筛选条件。
- 已绑定 Skill 与 Tool/MCP 的能力边界。
- 数据口径、期望输出形式及可接受的不确定性。

信息不足且会实质改变结论时先询问；可以安全假设时明确写出假设。

## Output Requirement

- 先给核心结论，再给关键证据与分析过程。
- 写明数据来源、查询范围、指标或标签口径。
- 将推断与已验证事实分开，不把相关性表述为因果关系。
- 给出限制、风险及可执行的后续动作。
- 不声称调用未绑定的 Skill、Tool/MCP 或获得不存在的数据。
`;
}

export function buildSkillCreatorOptimizationFallback(resolved) {
  const guidance = `Apply this user-requested optimization while preserving all required Top Skill sections:\n\n${markdownQuote(resolved.optimizationPrompt)}`;
  const content = resolved.currentTopSkill.trim();
  const sectionPattern = /^## Optimization Guidance\s*$[\s\S]*?(?=^## |\s*$)/m;
  if (sectionPattern.test(content)) {
    return `${content.replace(sectionPattern, `## Optimization Guidance\n\n${guidance}\n\n`)}\n`;
  }
  return `${content}\n\n## Optimization Guidance\n\n${guidance}\n`;
}

function isClaudeAuthenticationError(error) {
  const messages = [error?.message, error?.cause?.message]
    .filter(Boolean)
    .join('\n');
  return /not logged in|please run \/login|authentication[_ ]error|invalid (?:api )?key|api key (?:is )?(?:missing|not found)/i
    .test(messages);
}

function buildSkillCreatorRequest(input) {
  const name = requireString(input?.name, 'name', { max: 200 });
  const workingDescription = requireString(input?.workingDescription, 'workingDescription', { max: 10_000 });
  const businessContext = requireString(input?.businessContext, 'businessContext', {
    max: 10_000,
    allowEmpty: true,
  });
  const skills = normalizeStringList(input?.skills ?? [], 'skills');
  const tools = normalizeStringList(input?.tools ?? [], 'tools');

  const request = [
    'Create the complete Top Skill for the following Agent.',
    '',
    `Agent name: ${name}`,
    '',
    'How the Agent should work:',
    workingDescription,
    '',
    `Bound Skills:\n${skills.length ? skills.map((skill) => `- ${skill}`).join('\n') : '- None'}`,
    '',
    `Bound Tools/MCP:\n${tools.length ? tools.map((tool) => `- ${tool}`).join('\n') : '- None'}`,
    ...(businessContext ? ['', 'Business context:', businessContext] : []),
    '',
    'Return only the SKILL.md. It must include YAML frontmatter and all required second-level sections.',
    'Do not create files, call tools, explain the answer, define a Graph execution order, or invent capabilities.',
  ].join('\n');

  return { name, workingDescription, businessContext, skills, tools, request };
}

function buildSkillCreatorOptimizationRequest(input) {
  const normalized = buildSkillCreatorRequest(input);
  const currentTopSkill = requireString(input?.currentTopSkill, 'currentTopSkill', {
    max: MAX_TOP_SKILL_LENGTH,
  });
  assertRequiredTopSkillSections(currentTopSkill);
  const optimizationPrompt = requireString(input?.optimizationPrompt, 'optimizationPrompt', {
    max: 10_000,
  });
  const request = [
    'Optimize the existing Top Skill for the Agent below.',
    '',
    `Agent name: ${normalized.name}`,
    '',
    'How the Agent should work:',
    normalized.workingDescription,
    '',
    `Bound Skills:\n${normalized.skills.length ? normalized.skills.map((skill) => `- ${skill}`).join('\n') : '- None'}`,
    '',
    `Bound Tools/MCP:\n${normalized.tools.length ? normalized.tools.map((tool) => `- ${tool}`).join('\n') : '- None'}`,
    ...(normalized.businessContext ? ['', 'Business context:', normalized.businessContext] : []),
    '',
    'User optimization request:',
    optimizationPrompt,
    '',
    'Existing Top Skill:',
    currentTopSkill,
    '',
    'Return the complete replacement SKILL.md, not a patch or explanation.',
    'Preserve YAML frontmatter and every required second-level section. Keep existing useful constraints unless the optimization request explicitly changes them.',
    'Do not create files, call tools, define a Graph execution order, or invent capabilities.',
  ].join('\n');

  return { ...normalized, currentTopSkill, optimizationPrompt, request };
}

async function readBuiltInSkillCreator() {
  try {
    return await fs.readFile(BUILT_IN_SKILL_CREATOR_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return BUILT_IN_SKILL_CREATOR;
    throw error;
  }
}

export async function resolveSkillCreatorPrompt({ workspacePath, input, expand = expandLeadingSkillCommand }) {
  const normalized = buildSkillCreatorRequest(input);
  const invocation = `/skill-creator ${normalized.request}`;
  const expanded = await expand({ prompt: invocation, workspacePath });
  if (expanded.expanded) {
    return { ...normalized, prompt: expanded.prompt, source: expanded.namespace || 'installed' };
  }

  const builtInSkillCreator = await readBuiltInSkillCreator();
  return {
    ...normalized,
    prompt: `${builtInSkillCreator.trim()}\n\n## User request\n\n${normalized.request}\n`,
    source: 'built-in',
  };
}

export async function resolveSkillCreatorOptimizationPrompt({
  workspacePath,
  input,
  expand = expandLeadingSkillCommand,
}) {
  const normalized = buildSkillCreatorOptimizationRequest(input);
  const invocation = `/skill-creator ${normalized.request}`;
  const expanded = await expand({ prompt: invocation, workspacePath });
  if (expanded.expanded) {
    return { ...normalized, prompt: expanded.prompt, source: expanded.namespace || 'installed' };
  }

  const builtInSkillCreator = await readBuiltInSkillCreator();
  return {
    ...normalized,
    prompt: `${builtInSkillCreator.trim()}\n\n## User request\n\n${normalized.request}\n`,
    source: 'built-in',
  };
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

function cleanGeneratedSkill(raw, name, workingDescription) {
  let content = String(raw || '').trim();
  const fenced = content.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) content = fenced[1].trim();

  const roleIndex = content.search(/^## Role\s*$/m);
  const frontmatterIndex = content.search(/^---\s*$/m);
  if (frontmatterIndex > 0) {
    content = content.slice(frontmatterIndex);
  } else if (frontmatterIndex === -1 && roleIndex > 0) {
    content = content.slice(roleIndex);
  }
  if (!/^---\s*$/m.test(content)) {
    const description = workingDescription.replace(/\s+/g, ' ').slice(0, 240).replace(/"/g, '\\"');
    content = `---\nname: ${toSkillSlug(name)}\ndescription: "${description}"\n---\n\n${content}`;
  }

  try {
    assertRequiredTopSkillSections(content, 502);
  } catch (error) {
    if (error?.statusCode === 502) {
      error.message = error.message.replace('Top Skill', 'skill-creator response');
    }
    throw error;
  }
  if (content.length > MAX_TOP_SKILL_LENGTH) {
    throw createHttpError('skill-creator response is too large', 502);
  }
  return `${content.trim()}\n`;
}

async function executeSkillCreator({
  workspacePath,
  tenantId,
  userId,
  workspaceId,
  resolved,
  fallback,
  authenticationWarning,
  runQuery = null,
  runtimeManager = null,
  mapOptions = null,
  abortController = null,
}) {
  const effectiveRunQuery = runQuery || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const effectiveRuntimeManager = runtimeManager
    || (await import('./agent-session-runtime.js')).agentSessionRuntimeManager;
  const effectiveMapOptions = mapOptions || (await import('../claude-sdk.js')).mapCliOptionsToSDK;
  let runtimeContext = null;
  let runtimeSucceeded = false;

  try {
    runtimeContext = await effectiveRuntimeManager.prepareClaudeRuntime({
      tenantId,
      userId,
      workspaceId,
      cwd: workspacePath,
      projectPath: workspacePath,
    });
    const runtimeOptions = {
      cwd: runtimeContext.cwd || workspacePath,
      projectPath: runtimeContext.projectPath || workspacePath,
      pathToClaudeCodeExecutable: runtimeContext.pathToClaudeCodeExecutable,
      executableArgs: runtimeContext.executableArgs,
      spawnClaudeCodeProcess: runtimeContext.spawnClaudeCodeProcess,
      executionEnv: runtimeContext.executionEnv,
      settingSources: runtimeContext.settingSources,
      permissionMode: 'bypassPermissions',
    };
    const sdkOptions = effectiveMapOptions(runtimeOptions);
    sdkOptions.persistSession = false;
    sdkOptions.includePartialMessages = false;
    sdkOptions.maxTurns = 1;
    sdkOptions.allowedTools = [];
    sdkOptions.tools = [];
    sdkOptions.systemPrompt = 'Follow the supplied skill-creator instructions. Return only the requested SKILL.md content.';
    if (abortController) sdkOptions.abortController = abortController;

    let responseText = '';
    for await (const message of effectiveRunQuery({ prompt: resolved.prompt, options: sdkOptions })) {
      const text = extractAssistantText(message);
      if (text) responseText = text;
    }
    const topSkill = cleanGeneratedSkill(responseText, resolved.name, resolved.workingDescription);
    runtimeSucceeded = true;
    return { topSkill, generator: 'skill-creator', source: resolved.source };
  } catch (error) {
    if (!isClaudeAuthenticationError(error)) throw error;

    const topSkill = cleanGeneratedSkill(
      fallback(resolved),
      resolved.name,
      resolved.workingDescription,
    );
    console.warn(authenticationWarning);
    runtimeSucceeded = true;
    return {
      topSkill,
      generator: 'skill-creator',
      source: `${resolved.source}:auth-fallback`,
    };
  } finally {
    if (runtimeContext?.runtimeId) {
      if (runtimeSucceeded) effectiveRuntimeManager.markIdle(runtimeContext.runtimeId);
      else effectiveRuntimeManager.markFailed(runtimeContext.runtimeId);
    }
  }
}

export async function generateTopSkill({
  workspacePath,
  tenantId,
  userId,
  workspaceId,
  input,
  runQuery = null,
  runtimeManager = null,
  mapOptions = null,
  abortController = null,
  expand,
}) {
  const resolved = await resolveSkillCreatorPrompt({ workspacePath, input, expand });
  return executeSkillCreator({
    workspacePath,
    tenantId,
    userId,
    workspaceId,
    resolved,
    fallback: buildSkillCreatorFallback,
    authenticationWarning: '[agent-graphs] Claude authentication is unavailable; generated Top Skill with the built-in skill-creator template.',
    runQuery,
    runtimeManager,
    mapOptions,
    abortController,
  });
}

export async function optimizeTopSkill({
  workspacePath,
  tenantId,
  userId,
  workspaceId,
  input,
  runQuery = null,
  runtimeManager = null,
  mapOptions = null,
  abortController = null,
  expand,
}) {
  const resolved = await resolveSkillCreatorOptimizationPrompt({ workspacePath, input, expand });
  return executeSkillCreator({
    workspacePath,
    tenantId,
    userId,
    workspaceId,
    resolved,
    fallback: buildSkillCreatorOptimizationFallback,
    authenticationWarning: '[agent-graphs] Claude authentication is unavailable; optimized Top Skill with the built-in skill-creator template.',
    runQuery,
    runtimeManager,
    mapOptions,
    abortController,
  });
}

export const agentGraphsService = {
  listAgentGraphs,
  getAgentGraph,
  createAgentGraph,
  updateAgentGraph,
  deleteAgentGraph,
  generateTopSkill,
  optimizeTopSkill,
};
