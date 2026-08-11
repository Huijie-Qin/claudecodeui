import type {
  FieldChoice,
  FieldType,
  HookActionType,
  HookConfigDraft,
  HookEventDefinition,
  HookEventName,
  HookResources,
  HookToolResource,
} from './types';

export const EVENT_DEFINITIONS: HookEventDefinition[] = [
  { name: 'Setup', group: 'session', matcherField: 'trigger', fields: [{ key: 'trigger', type: 'string', options: ['init', 'maintenance'] }] },
  { name: 'SessionStart', group: 'session', matcherField: 'source', fields: [{ key: 'source', type: 'string', options: ['startup', 'resume', 'clear', 'compact'] }, { key: 'model', type: 'string' }, { key: 'agentType', type: 'string' }] },
  { name: 'Stop', group: 'session', fields: [{ key: 'stopHookActive', type: 'boolean' }, { key: 'lastAssistantMessage', type: 'string' }] },
  { name: 'StopFailure', group: 'session', matcherField: 'error', fields: [{ key: 'error', type: 'string', options: ['rate_limit', 'authentication_failed', 'server_error', 'unknown'] }, { key: 'errorDetails', type: 'string' }, { key: 'lastAssistantMessage', type: 'string' }] },
  { name: 'SessionEnd', group: 'session', matcherField: 'reason', fields: [{ key: 'reason', type: 'string' }] },
  { name: 'UserPromptSubmit', group: 'prompt', fields: [{ key: 'prompt', type: 'string' }, { key: 'sessionTitle', type: 'string' }] },
  { name: 'UserPromptExpansion', group: 'prompt', matcherField: 'commandName', fields: [{ key: 'expansionType', type: 'string', options: ['slash_command', 'mcp_prompt'] }, { key: 'commandName', type: 'string' }, { key: 'commandArgs', type: 'string' }, { key: 'prompt', type: 'string' }] },
  { name: 'Notification', group: 'prompt', matcherField: 'notificationType', fields: [{ key: 'title', type: 'string' }, { key: 'message', type: 'string' }, { key: 'notificationType', type: 'string' }] },
  { name: 'PreToolUse', group: 'tool', matcherField: 'toolName', fields: [{ key: 'toolName', type: 'string' }, { key: 'toolInput', type: 'object' }, { key: 'toolUseId', type: 'string' }] },
  { name: 'PostToolUse', group: 'tool', matcherField: 'toolName', fields: [{ key: 'toolName', type: 'string' }, { key: 'toolInput', type: 'object' }, { key: 'toolResponse', type: 'object' }, { key: 'toolUseId', type: 'string' }] },
  { name: 'PostToolUseFailure', group: 'tool', matcherField: 'toolName', fields: [{ key: 'toolName', type: 'string' }, { key: 'toolInput', type: 'object' }, { key: 'error', type: 'string' }, { key: 'isInterrupt', type: 'boolean' }] },
  { name: 'PermissionRequest', group: 'tool', matcherField: 'toolName', fields: [{ key: 'toolName', type: 'string' }, { key: 'toolInput', type: 'object' }, { key: 'permissionSuggestions', type: 'array' }] },
  { name: 'PermissionDenied', group: 'tool', matcherField: 'toolName', fields: [{ key: 'toolName', type: 'string' }, { key: 'toolInput', type: 'object' }, { key: 'reason', type: 'string' }] },
  { name: 'SubagentStart', group: 'agent', matcherField: 'agentType', fields: [{ key: 'agentId', type: 'string' }, { key: 'agentType', type: 'string' }] },
  { name: 'SubagentStop', group: 'agent', matcherField: 'agentType', fields: [{ key: 'agentId', type: 'string' }, { key: 'agentType', type: 'string' }, { key: 'lastAssistantMessage', type: 'string' }] },
  { name: 'TeammateIdle', group: 'agent', fields: [{ key: 'teammateName', type: 'string' }, { key: 'teamName', type: 'string' }] },
  { name: 'TaskCreated', group: 'agent', fields: [{ key: 'taskId', type: 'string' }, { key: 'taskSubject', type: 'string' }, { key: 'taskDescription', type: 'string' }] },
  { name: 'TaskCompleted', group: 'agent', fields: [{ key: 'taskId', type: 'string' }, { key: 'taskSubject', type: 'string' }, { key: 'taskDescription', type: 'string' }] },
  { name: 'PreCompact', group: 'context', matcherField: 'trigger', fields: [{ key: 'trigger', type: 'string', options: ['manual', 'auto'] }, { key: 'customInstructions', type: 'string' }] },
  { name: 'PostCompact', group: 'context', matcherField: 'trigger', fields: [{ key: 'trigger', type: 'string', options: ['manual', 'auto'] }, { key: 'compactSummary', type: 'string' }] },
  { name: 'Elicitation', group: 'mcp', matcherField: 'mcpServerName', fields: [{ key: 'mcpServerName', type: 'string' }, { key: 'message', type: 'string' }, { key: 'mode', type: 'string', options: ['form', 'url'] }, { key: 'requestedSchema', type: 'object' }, { key: 'url', type: 'string' }] },
  { name: 'ElicitationResult', group: 'mcp', matcherField: 'mcpServerName', fields: [{ key: 'mcpServerName', type: 'string' }, { key: 'action', type: 'string', options: ['accept', 'decline', 'cancel'] }, { key: 'content', type: 'object' }, { key: 'mode', type: 'string', options: ['form', 'url'] }] },
  { name: 'ConfigChange', group: 'workspace', matcherField: 'source', fields: [{ key: 'source', type: 'string' }, { key: 'filePath', type: 'string' }] },
  { name: 'InstructionsLoaded', group: 'workspace', matcherField: 'loadReason', fields: [{ key: 'filePath', type: 'string' }, { key: 'memoryType', type: 'string' }, { key: 'loadReason', type: 'string' }] },
  { name: 'CwdChanged', group: 'workspace', fields: [{ key: 'oldCwd', type: 'string' }, { key: 'newCwd', type: 'string' }] },
  { name: 'FileChanged', group: 'workspace', matcherField: 'fileName', fields: [{ key: 'filePath', type: 'string' }, { key: 'changeType', type: 'string', options: ['change', 'add', 'unlink'] }] },
  { name: 'WorktreeCreate', group: 'workspace', fields: [{ key: 'name', type: 'string' }] },
  { name: 'WorktreeRemove', group: 'workspace', fields: [{ key: 'worktreePath', type: 'string' }] },
];

export const EVENT_BY_NAME = new Map(EVENT_DEFINITIONS.map((event) => [event.name, event]));

export const EVENT_GROUPS = ['session', 'prompt', 'tool', 'agent', 'context', 'mcp', 'workspace'];

export const TOOL_EVENTS = new Set<HookEventName>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);

const APPEND_CONTEXT_EVENTS = new Set<HookEventName>([
  'Setup',
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
]);

const DECISION_EVENTS = new Set<HookEventName>([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'Stop',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
]);

export const ACTION_TYPES: HookActionType[] = [
  'record_data',
  'call_tool',
  'append_context',
  'invoke_skill_recovery',
  'decision',
  'update_input',
  'update_output',
];

export function isConcreteToolMatcher(value?: string) {
  return Boolean(value && value !== '*' && !/[.*+?()[\]{}|^$\\]/.test(value));
}

export function actionAvailability(eventName: HookEventName, matcherValue: string | undefined, type: HookActionType) {
  if (type === 'record_data' || type === 'call_tool') return { available: true };
  if (type === 'append_context') return { available: APPEND_CONTEXT_EVENTS.has(eventName) };
  if (type === 'invoke_skill_recovery') return { available: eventName === 'StopFailure' };
  if (type === 'decision') return { available: DECISION_EVENTS.has(eventName) };
  if (type === 'update_input') {
    if (eventName !== 'PreToolUse') return { available: false };
    return isConcreteToolMatcher(matcherValue)
      ? { available: true }
      : { available: false, reasonKey: 'hooks.actions.selectToolFirst' };
  }
  if (type === 'update_output') return { available: eventName === 'PostToolUse' };
  return { available: false };
}

export function createEmptyHook(eventName: HookEventName): HookConfigDraft {
  return {
    name: '',
    description: '',
    eventName,
    matcher: {},
    gate: { mode: 'all', conditions: [] },
    advancedScript: null,
    actions: [],
  };
}

function normalizePropertyType(type?: string): FieldType {
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'array') return 'array';
  if (type === 'object') return 'object';
  return 'string';
}

export function findMatchedTool(resources: HookResources, matcherValue?: string): HookToolResource | undefined {
  if (!matcherValue) return undefined;
  return [...resources.builtinTools, ...resources.mcpTools].find((tool) => tool.name === matcherValue);
}

export function buildFieldChoices(
  draft: HookConfigDraft,
  resources: HookResources,
): FieldChoice[] {
  const event = EVENT_BY_NAME.get(draft.eventName);
  const fields: FieldChoice[] = (event?.fields || []).map((field) => ({
    path: `$event.${field.key}`,
    labelKey: `hooks.fields.${field.key}`,
    type: field.type,
    options: field.options?.map((value) => ({ value, label: value })),
    gateAllowed: !['toolUseId', 'agentId', 'taskId', 'filePath', 'worktreePath'].includes(field.key),
    group: 'event',
  }));

  const matchedTool = findMatchedTool(resources, draft.matcher.value);
  const properties = matchedTool?.inputSchema?.properties || {};
  for (const [key, property] of Object.entries(properties)) {
    fields.push({
      path: `$event.toolInput.${key}`,
      label: property.description || key,
      description: key,
      type: normalizePropertyType(property.type),
      options: property.enum?.map((value) => ({ value: String(value), label: String(value) })),
      gateAllowed: true,
      group: 'event',
    });
  }

  for (const variable of resources.environmentVariables) {
    fields.push({
      path: variable.path,
      labelKey: `hooks.variables.${variable.path.replace('$context.', '')}`,
      type: normalizePropertyType(variable.type),
      gateAllowed: false,
      group: 'environment',
    });
  }

  for (const output of draft.advancedScript?.outputs || []) {
    fields.push({
      path: `$script.output.${output.name}`,
      label: output.description || output.name,
      description: output.name,
      type: output.type,
      gateAllowed: true,
      group: 'script',
    });
  }

  draft.actions.forEach((action, index) => {
    fields.push({
      path: `$actions.${index}.output`,
      label: `#${index + 1}`,
      type: 'object',
      gateAllowed: false,
      group: 'action',
    });
  });
  return fields;
}

export function inferScriptOutputs(code: string) {
  const outputs: Array<{ name: string; type: FieldType; description: string }> = [];
  const matcher = /@output\s+([A-Za-z_$][A-Za-z0-9_$]*):(string|number|boolean|object|array)\s*([^\r\n]*)/g;
  let match = matcher.exec(code);
  while (match) {
    if (!outputs.some((output) => output.name === match?.[1])) {
      outputs.push({
        name: match[1],
        type: match[2] as FieldType,
        description: match[3].trim(),
      });
    }
    match = matcher.exec(code);
  }
  return outputs;
}

type ScriptTemplateInput = {
  path: string;
  label: string;
  type: FieldType;
};

const SCRIPT_RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function scriptCommentText(value: string) {
  return value.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').trim();
}

function scriptParameterName(path: string, usedNames: Set<string>) {
  const parts = path.replace(/^\$/, '').split('.');
  const rawName = parts[0] === 'event' && parts[1] === 'toolInput' && parts.length > 2
    ? `toolInput_${parts.slice(2).join('_')}`
    : parts.at(-1) || 'value';
  const words = rawName.split(/[^A-Za-z0-9$]+/).filter(Boolean);
  const candidate = words
    .map((word, index) => index === 0 ? word : `${word[0]?.toUpperCase() || ''}${word.slice(1)}`)
    .join('')
    .replace(/^[^A-Za-z_$]/, '_') || 'value';
  const baseName = SCRIPT_RESERVED_WORDS.has(candidate) ? `_${candidate}` : candidate;
  let name = baseName;
  let suffix = 2;
  while (usedNames.has(name)) {
    name = `${baseName}${suffix}`;
    suffix += 1;
  }
  usedNames.add(name);
  return name;
}

export function buildScriptTemplate({
  eventName,
  eventLabel,
  eventDescription,
  inputs,
}: {
  eventName: HookEventName;
  eventLabel: string;
  eventDescription: string;
  inputs: ScriptTemplateInput[];
}) {
  const usedNames = new Set<string>();
  const parameters = inputs.map((input) => ({
    ...input,
    label: scriptCommentText(input.label),
    path: scriptCommentText(input.path),
    name: scriptParameterName(input.path, usedNames),
  }));
  const parameterLines = parameters.length
    ? parameters.map((input) => `  ${input.name}, // ${input.type}：${input.label}；来源 ${input.path}`).join('\n')
    : '  // 当前事件没有额外输入字段';
  return `/**
 * 高级脚本：${scriptCommentText(eventLabel)}（${eventName}）
 * 触发说明：${scriptCommentText(eventDescription)}
 *
 * 输入参数已经展开，可在“业务逻辑区”直接使用变量名，不需要再读取 ctx.event 或 ctx.context。
 *
 * output 是可选的 CCUI 自定义计算结果，不是 Claude Code SDK 的原生 Hook 返回值。
 * 不需要自定义结果时保持 output 为空；需要时使用 @output 字段名:类型 中文说明 声明字段。
 * 声明后的字段会以 $script.output.<字段名> 提供给执行门槛和后续基础行为。
 */
export async function run({
${parameterLines}
}) {
  // ===== 在这里编写业务逻辑 =====


  // ===== 业务逻辑结束 =====

  return {
    output: {},
  };
}
`;
}

export function getToolTargetFields(resources: HookResources, matcherValue?: string) {
  const tool = findMatchedTool(resources, matcherValue);
  const properties = tool?.inputSchema?.properties || {};
  return Object.entries(properties).map(([key, property]) => ({
    path: `tool_input.${key}`,
    label: property.description || key,
    description: key,
    type: normalizePropertyType(property.type),
    options: property.enum?.map((value) => ({ value: String(value), label: String(value) })),
  }));
}
