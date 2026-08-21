import crypto from 'node:crypto';

import { appConfigDb, db } from '../database/db.js';

import { isBuiltinHookSkillId } from './hook-builtin-skills.js';

const HOOK_EVENTS = Object.freeze([
  'Setup',
  'SessionStart',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
]);

const DEFAULT_VISIBLE_EVENTS = Object.freeze(['Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);

const EVENT_SET = new Set(HOOK_EVENTS);
const MATCHER_EVENTS = new Set([
  'Setup',
  'SessionStart',
  'StopFailure',
  'SessionEnd',
  'UserPromptExpansion',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'FileChanged',
]);
const VISIBLE_EVENTS_CONFIG_KEY = 'admin_hook_visible_events';
const SQL_CHECK_HOOK_NAME = 'SQL Check 强制校验';
const MAX_SCRIPT_BYTES = 128 * 1024;
const MAX_POST_ACTIONS = 20;
const POST_ACTION_TYPES = Object.freeze(['call_mcp_tool', 'write_record', 'invoke_skill']);
const SKILL_ACTION_EVENTS = new Set(['Stop', 'StopFailure']);
const SCRIPT_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
const EXECUTION_OUTCOMES = new Set([
  'succeeded',
  'failed',
  'denied',
  'stopped',
  'ask',
  'defer',
  'modified_input',
  'modified_output',
  'post_action',
  'additional_context',
]);
const ENVIRONMENT_VARIABLE_PATHS = new Set([
  'ccui.env.userId',
  'ccui.env.username',
  'ccui.env.tenantId',
  'ccui.env.workspaceId',
  'ccui.env.sessionId',
]);
const COMMON_CLAUDE_OUTPUTS = Object.freeze([
  'continue',
  'stopReason',
  'suppressOutput',
  'systemMessage',
]);
const DECISION_EVENTS = new Set([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
  'ConfigChange',
  'PreCompact',
]);
const EVENT_CLAUDE_OUTPUTS = Object.freeze({
  Setup: ['hookSpecificOutput.additionalContext'],
  SessionStart: [
    'hookSpecificOutput.additionalContext',
    'hookSpecificOutput.initialUserMessage',
    'hookSpecificOutput.watchPaths',
  ],
  UserPromptSubmit: ['hookSpecificOutput.additionalContext', 'hookSpecificOutput.sessionTitle'],
  UserPromptExpansion: ['hookSpecificOutput.additionalContext'],
  Notification: ['hookSpecificOutput.additionalContext'],
  PreToolUse: [
    'hookSpecificOutput.permissionDecision',
    'hookSpecificOutput.permissionDecisionReason',
    'hookSpecificOutput.updatedInput',
    'hookSpecificOutput.additionalContext',
  ],
  PostToolUse: ['hookSpecificOutput.additionalContext', 'hookSpecificOutput.updatedMCPToolOutput'],
  PostToolUseFailure: ['hookSpecificOutput.additionalContext'],
  PermissionRequest: ['hookSpecificOutput.decision'],
  PermissionDenied: ['hookSpecificOutput.retry'],
  SubagentStart: ['hookSpecificOutput.additionalContext'],
  Elicitation: ['hookSpecificOutput.action', 'hookSpecificOutput.content'],
  ElicitationResult: ['hookSpecificOutput.action', 'hookSpecificOutput.content'],
  CwdChanged: ['hookSpecificOutput.watchPaths'],
  FileChanged: ['hookSpecificOutput.watchPaths'],
  WorktreeCreate: ['hookSpecificOutput.worktreePath'],
});

function allowedPostActions(eventName) {
  return new Set(SKILL_ACTION_EVENTS.has(eventName)
    ? POST_ACTION_TYPES
    : POST_ACTION_TYPES.filter((type) => type !== 'invoke_skill'));
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, name, { max = 200, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw createHttpError(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) {
    throw createHttpError(`${name} is required`);
  }
  if (normalized.length > max) {
    throw createHttpError(`${name} must be ${max} characters or fewer`);
  }
  return normalized;
}

function normalizeEventName(value) {
  const eventName = String(value || '');
  if (!EVENT_SET.has(eventName)) {
    throw createHttpError('eventName is not supported');
  }
  return eventName;
}

function normalizeMatcher(value, eventName) {
  if (!MATCHER_EVENTS.has(eventName)) return {};
  const source = isPlainObject(value) ? value : {};
  const matcherValue = typeof source.value === 'string' ? source.value.trim() : '';
  if (!matcherValue || matcherValue === '*') return {};
  if (matcherValue.length > 240) {
    throw createHttpError('matcher.value must be 240 characters or fewer');
  }
  const exactPattern = eventName === 'StopFailure' ? /^[A-Za-z0-9_|]+$/ : /^[A-Za-z0-9_,| -]+$/;
  const mode = eventName === 'FileChanged' || exactPattern.test(matcherValue) ? 'exact' : 'regex';
  if (mode === 'regex' && matcherValue) {
    try {
      new RegExp(matcherValue);
    } catch {
      throw createHttpError('matcher.value is not a valid regular expression');
    }
  }
  return { mode, value: matcherValue };
}

function normalizeExtensionLogic(value) {
  if (!isPlainObject(value)) return null;
  const code = typeof value.code === 'string' ? value.code : '';
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) {
    throw createHttpError('extensionLogic.code is too large');
  }
  const rawOutputs = Array.isArray(value.outputs) ? value.outputs : [];
  if (rawOutputs.length > 50) {
    throw createHttpError('extensionLogic.outputs must contain 50 items or fewer');
  }
  const names = new Set();
  const outputs = rawOutputs.map((output, index) => {
    if (!isPlainObject(output)) {
      throw createHttpError(`extensionLogic.outputs[${index}] must be an object`);
    }
    const name = requireString(output.name, `extensionLogic.outputs[${index}].name`, { max: 80 });
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw createHttpError(`extensionLogic.outputs[${index}].name must be a valid identifier`);
    }
    if (names.has(name)) {
      throw createHttpError(`extensionLogic output ${name} is duplicated`);
    }
    names.add(name);
    const type = String(output.type || 'string');
    if (!SCRIPT_OUTPUT_TYPES.has(type)) {
      throw createHttpError(`extensionLogic.outputs[${index}].type is not supported`);
    }
    return {
      name,
      type,
      description: requireString(
        typeof output.description === 'string' ? output.description : '',
        `extensionLogic.outputs[${index}].description`,
        { max: 300, allowEmpty: true },
      ),
    };
  });
  return {
    language: value.language === 'python' ? 'python' : 'javascript',
    code,
    outputs,
  };
}

function normalizeBinding(value, name) {
  if (!isPlainObject(value)) throw createHttpError(`${name} must be an object`);
  if (value.source === 'reference') {
    return {
      source: 'reference',
      path: requireString(value.path, `${name}.path`, { max: 300 }),
    };
  }
  if (value.source === 'template') {
    return {
      source: 'template',
      template: requireString(
        typeof value.template === 'string' ? value.template : '',
        `${name}.template`,
        { max: 20000, allowEmpty: true },
      ),
    };
  }
  if (value.source !== 'literal') {
    throw createHttpError(`${name}.source must be literal, reference, or template`);
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'value')) {
    throw createHttpError(`${name}.value is required`);
  }
  return { source: 'literal', value: value.value };
}

function normalizePostActions(value, eventName, { validateBuiltinSkillIds = true } = {}) {
  const rawActions = value == null ? [] : value;
  if (!Array.isArray(rawActions)) throw createHttpError('postActions must be an array');
  if (rawActions.length > MAX_POST_ACTIONS) {
    throw createHttpError(`postActions must contain ${MAX_POST_ACTIONS} items or fewer`);
  }
  const ids = new Set();
  return rawActions.map((action, index) => {
    if (!isPlainObject(action)) throw createHttpError(`postActions[${index}] must be an object`);
    const id = requireString(action.id, `postActions[${index}].id`, { max: 100 });
    if (ids.has(id)) throw createHttpError(`post action ${id} is duplicated`);
    ids.add(id);
    const config = isPlainObject(action.config) ? action.config : {};
    if (!allowedPostActions(eventName).has(action.type)) {
      if (action.type === 'invoke_skill') {
        throw createHttpError('invoke_skill is only supported for Stop and StopFailure');
      }
      throw createHttpError(`postActions[${index}].type is not supported`);
    }
    if (action.type === 'call_mcp_tool') {
      const rawInputs = isPlainObject(config.inputs) ? config.inputs : {};
      const inputs = {};
      for (const [key, binding] of Object.entries(rawInputs)) {
        const inputName = requireString(key, `postActions[${index}].config.inputs key`, { max: 200 });
        inputs[inputName] = normalizeBinding(binding, `postActions[${index}].config.inputs.${inputName}`);
      }
      return {
        id,
        type: 'call_mcp_tool',
        position: index,
        config: {
          toolName: requireString(
            typeof config.toolName === 'string' ? config.toolName : '',
            `postActions[${index}].config.toolName`,
            { max: 300, allowEmpty: true },
          ),
          condition: config.condition == null
            ? null
            : normalizeBinding(config.condition, `postActions[${index}].config.condition`),
          inputs,
        },
      };
    }
    if (action.type === 'write_record') {
      const rawFields = isPlainObject(config.fields) ? config.fields : {};
      const fields = {};
      for (const [key, binding] of Object.entries(rawFields)) {
        const fieldName = requireString(key, `postActions[${index}].config.fields key`, { max: 200 });
        fields[fieldName] = normalizeBinding(binding, `postActions[${index}].config.fields.${fieldName}`);
      }
      return {
        id,
        type: 'write_record',
        position: index,
        config: {
          recordType: requireString(
            typeof config.recordType === 'string' ? config.recordType : '',
            `postActions[${index}].config.recordType`,
            { max: 120, allowEmpty: true },
          ),
          condition: config.condition == null
            ? null
            : normalizeBinding(config.condition, `postActions[${index}].config.condition`),
          fields,
        },
      };
    }
    if (action.type === 'invoke_skill') {
      const skillId = requireString(
        typeof config.skillId === 'string' ? config.skillId : '',
        `postActions[${index}].config.skillId`,
        { max: Number.POSITIVE_INFINITY, allowEmpty: true },
      );
      if (validateBuiltinSkillIds && skillId && !isBuiltinHookSkillId(skillId)) {
        throw createHttpError(`postActions[${index}].config.skillId must reference a built-in Hook Skill`);
      }
      return {
        id,
        type: 'invoke_skill',
        position: index,
        config: {
          skillId,
          skillName: requireString(
            typeof config.skillName === 'string' ? config.skillName : '',
            `postActions[${index}].config.skillName`,
            { max: Number.POSITIVE_INFINITY, allowEmpty: true },
          ),
          argumentsTemplate: requireString(
            typeof config.argumentsTemplate === 'string' ? config.argumentsTemplate : '',
            `postActions[${index}].config.argumentsTemplate`,
            { max: 10000, allowEmpty: true },
          ),
        },
      };
    }
    throw createHttpError(`postActions[${index}].type is not supported`);
  });
}

function normalizeClaudeResponse(value) {
  const source = isPlainObject(value) ? value : {};
  const rawBindings = isPlainObject(source.bindings) ? source.bindings : {};
  if (Object.keys(rawBindings).length > 50) {
    throw createHttpError('claudeResponse.bindings must contain 50 items or fewer');
  }
  const bindings = {};
  for (const [path, binding] of Object.entries(rawBindings)) {
    const outputPath = requireString(path, 'claudeResponse.bindings key', { max: 200 });
    bindings[outputPath] = normalizeBinding(binding, `claudeResponse.bindings.${outputPath}`);
  }
  return { bindings };
}

function allowedClaudeOutputs(eventName) {
  if (eventName === 'StopFailure') return new Set();
  return new Set([
    ...COMMON_CLAUDE_OUTPUTS,
    ...(DECISION_EVENTS.has(eventName) ? ['decision', 'reason'] : []),
    ...(EVENT_CLAUDE_OUTPUTS[eventName] || []),
  ]);
}

function isAllowedReference(path, { scriptOutputs, actionIds }) {
  if (path === 'event' || path.startsWith('event.')) return true;
  if ([...ENVIRONMENT_VARIABLE_PATHS].some((environmentPath) => path === environmentPath || path.startsWith(`${environmentPath}.`))) {
    return true;
  }
  if (path.startsWith('script.output.')) {
    const name = path.slice('script.output.'.length).split('.')[0];
    return scriptOutputs.has(name);
  }
  if (path.startsWith('actions.')) {
    const [, actionId, outputSegment] = path.split('.');
    return outputSegment === 'output' && actionIds.has(actionId);
  }
  return false;
}

function bindingReferences(binding) {
  if (binding.source === 'reference') return [binding.path];
  if (binding.source !== 'template') return [];
  return [...binding.template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1]);
}

function validateHookReferences(hook) {
  const scriptOutputs = new Set((hook.extensionLogic?.outputs || []).map((output) => output.name));
  const allActionIds = new Set(hook.postActions.map((action) => action.id));
  const precedingActionIds = new Set();
  for (const action of hook.postActions) {
    if (action.type === 'call_mcp_tool' || action.type === 'write_record') {
      const bindings = action.type === 'call_mcp_tool'
        ? [action.config.condition, ...Object.values(action.config.inputs)].filter(Boolean)
        : [action.config.condition, ...Object.values(action.config.fields)].filter(Boolean);
      for (const binding of bindings) {
        for (const path of bindingReferences(binding)) {
          if (!isAllowedReference(path, { scriptOutputs, actionIds: precedingActionIds })) {
            throw createHttpError(`Reference ${path} is not available to post action ${action.id}`);
          }
        }
      }
    } else {
      const matches = action.config.argumentsTemplate.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g);
      for (const match of matches) {
        const path = match[1];
        if (!isAllowedReference(path, { scriptOutputs, actionIds: precedingActionIds })) {
          throw createHttpError(`Reference ${path} is not available to post action ${action.id}`);
        }
      }
    }
    precedingActionIds.add(action.id);
  }
  for (const binding of Object.values(hook.claudeResponse.bindings)) {
    for (const path of bindingReferences(binding)) {
      if (!isAllowedReference(path, { scriptOutputs, actionIds: allActionIds })) {
        throw createHttpError(`Reference ${path} is not available to claudeResponse`);
      }
    }
  }
}

function normalizeHookInput(input, { strict = false } = {}) {
  if (!isPlainObject(input)) throw createHttpError('Hook payload must be an object');
  const eventName = normalizeEventName(input.eventName);
  const matcher = normalizeMatcher(input.matcher, eventName);
  const normalized = {
    name: requireString(input.name, 'name', { max: 120 }),
    description: requireString(typeof input.description === 'string' ? input.description : '', 'description', {
      max: 1000,
      allowEmpty: true,
    }),
    eventName,
    matcher,
    extensionLogic: normalizeExtensionLogic(input.extensionLogic),
    postActions: normalizePostActions(input.postActions, eventName),
    claudeResponse: normalizeClaudeResponse(input.claudeResponse),
  };
  validateHookReferences(normalized);
  if (strict) {
    const allowedOutputs = allowedClaudeOutputs(eventName);
    for (const path of Object.keys(normalized.claudeResponse.bindings)) {
      if (!allowedOutputs.has(path)) {
        throw createHttpError(`Claude response field ${path} is not supported for ${eventName}`);
      }
    }
    const hasEffect = Boolean(normalized.extensionLogic?.code.trim())
      || normalized.postActions.length > 0
      || Object.keys(normalized.claudeResponse.bindings).length > 0;
    if (!hasEffect) throw createHttpError('Configure a script, post action, or Claude response before publishing');
  }
  return normalized;
}

function mapHookRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status,
    activationScope: row.activation_scope === 'all_users' ? 'all_users' : 'manual',
    bindingController: row.binding_controller === 'sql_check' ? 'sql_check' : 'admin',
    eventName: row.event_name,
    matcher: parseJson(row.matcher_json, {}),
    extensionLogic: normalizeExtensionLogic(parseJson(row.extension_logic_json, null)),
    // Historical records must remain readable so administrators can repair an
    // unavailable Skill from the Hook card. Create, update, publish, and runtime
    // paths retain their strict built-in Skill validation.
    postActions: normalizePostActions(parseJson(row.post_actions_json, []), row.event_name, {
      validateBuiltinSkillIds: false,
    }),
    claudeResponse: normalizeClaudeResponse(parseJson(row.claude_response_json, { bindings: {} })),
    version: Number(row.version || 0),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
    boundUserCount: Number(row.bound_user_count || 0),
    boundTenantCount: Number(row.bound_tenant_count || 0),
  };
}

function hasTable(database, tableName) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function normalizeRecordLimit(value) {
  const number = Number(value ?? 50);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 200) : 50;
}

function normalizeRecordOffset(value) {
  const number = Number(value ?? 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function mapExecutionRow(row, { summary = false } = {}) {
  if (!row) return null;
  const input = parseJson(row.input_json, {});
  const actions = parseJson(row.actions_json, {});
  const response = parseJson(row.response_json, {});
  const hookSpecificOutput = isPlainObject(response.hookSpecificOutput) ? response.hookSpecificOutput : {};
  const permissionDecision = typeof hookSpecificOutput.permissionDecision === 'string'
    ? hookSpecificOutput.permissionDecision
    : isPlainObject(hookSpecificOutput.decision) && typeof hookSpecificOutput.decision.behavior === 'string'
      ? hookSpecificOutput.decision.behavior
      : null;
  const effects = [];
  if (Object.prototype.hasOwnProperty.call(hookSpecificOutput, 'updatedInput')) effects.push('updated_input');
  if (Object.prototype.hasOwnProperty.call(hookSpecificOutput, 'updatedMCPToolOutput')
      || Object.prototype.hasOwnProperty.call(hookSpecificOutput, 'updatedToolOutput')) effects.push('updated_output');
  if (typeof hookSpecificOutput.additionalContext === 'string' && hookSpecificOutput.additionalContext) {
    effects.push('additional_context');
  }
  if (Object.keys(actions).length > 0) effects.push('post_action');
  if (permissionDecision) effects.push(`permission_${permissionDecision}`);
  if (response.decision === 'block') effects.push('blocked');
  if (response.continue === false) effects.push('stopped');
  let outcome = 'succeeded';
  if (row.status === 'failed') outcome = 'failed';
  else if (permissionDecision === 'deny' || response.decision === 'block') outcome = 'denied';
  else if (response.continue === false) outcome = 'stopped';
  else if (permissionDecision === 'ask' || permissionDecision === 'defer') outcome = permissionDecision;
  else if (effects.includes('updated_input')) outcome = 'modified_input';
  else if (effects.includes('updated_output')) outcome = 'modified_output';
  else if (effects.includes('post_action')) outcome = 'post_action';
  else if (effects.includes('additional_context')) outcome = 'additional_context';
  const parsedStartedAtMs = Number(row.started_at_ms);
  const fallbackStartedAtMs = Date.parse(row.started_at || '');
  const startedAtMs = Number.isFinite(parsedStartedAtMs) && parsedStartedAtMs > 0
    ? parsedStartedAtMs
    : Number.isFinite(fallbackStartedAtMs) ? fallbackStartedAtMs : null;
  const parsedCompletedAtMs = Number(row.completed_at_ms);
  const completedAtMs = Number.isFinite(parsedCompletedAtMs) && parsedCompletedAtMs > 0
    ? parsedCompletedAtMs
    : startedAtMs != null && row.duration_ms != null ? startedAtMs + Number(row.duration_ms || 0) : null;
  return {
    id: row.id,
    hookId: row.hook_id,
    hookVersion: Number(row.hook_version || 0),
    userId: row.user_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    eventName: row.event_name,
    toolUseId: row.tool_use_id,
    status: row.status,
    hookName: row.hook_name || null,
    bindingController: row.binding_controller === 'sql_check' ? 'sql_check' : 'admin',
    username: row.username || null,
    toolName: typeof input.tool_name === 'string' ? input.tool_name : null,
    input: summary ? null : input,
    scriptOutput: summary ? null : parseJson(row.script_output_json, null),
    actions: summary ? {} : actions,
    response: summary ? {} : response,
    logs: summary ? [] : parseJson(row.logs_json, []),
    errorMessage: summary ? null : row.error_message,
    durationMs: row.duration_ms,
    startedAtMs,
    completedAtMs,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    diagnostics: {
      outcome,
      effects,
      permissionDecision,
      updatedInput: effects.includes('updated_input'),
      actionCount: Object.keys(actions).length,
      failOpen: row.status === 'failed',
    },
  };
}

function mapDataRecordRow(row) {
  return {
    id: row.id,
    executionId: row.execution_id,
    hookId: row.hook_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    type: row.record_type,
    data: parseJson(row.data_json, null),
    createdAt: row.created_at,
  };
}

function listMcpToolCatalog(database) {
  if (!hasTable(database, 'mcp_server_presets')) return [];
  const rows = database
    .prepare(
      `
    SELECT p.name, p.display_name, p.description, p.tools_json, t.code AS tenant_code
    FROM mcp_server_presets p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.status = 'published'
      AND p.last_test_status = 'healthy'
      AND p.tool_count > 0
    ORDER BY p.display_name, p.name
  `,
    )
    .all();
  const byName = new Map();
  for (const row of rows) {
    const tools = parseJson(row.tools_json, []);
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) continue;
      const name = `mcp__${row.name}__${tool.name.trim()}`;
      const current = byName.get(name) || {
        name,
        serverName: row.name,
        serverDisplayName: row.display_name,
        toolName: tool.name.trim(),
        description: typeof tool.description === 'string' ? tool.description : row.description || '',
        inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
        tenantCodes: [],
      };
      if (!current.tenantCodes.includes(row.tenant_code)) current.tenantCodes.push(row.tenant_code);
      byName.set(name, current);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function validatePublishResources(hook, database, validatedSkills) {
  const mcpTools = new Map(listMcpToolCatalog(database).map((tool) => [tool.name, tool]));
  const skills = new Map((validatedSkills || []).map((skill) => [String(skill.skillId || ''), skill]));
  for (const action of hook.postActions) {
    if (action.type === 'call_mcp_tool') {
      if (!action.config.toolName.startsWith('mcp__')) {
        throw createHttpError(`Post action ${action.id} must select an MCP tool`);
      }
      const tool = mcpTools.get(action.config.toolName);
      if (!tool) throw createHttpError(`MCP tool ${action.config.toolName} is not available`);
      for (const requiredName of tool.inputSchema?.required || []) {
        if (!Object.prototype.hasOwnProperty.call(action.config.inputs, requiredName)) {
          throw createHttpError(`MCP tool ${action.config.toolName} requires input ${requiredName}`);
        }
      }
    } else if (action.type === 'write_record') {
      if (!action.config.recordType) {
        throw createHttpError(`Post action ${action.id} must set a record type`);
      }
    } else {
      const skill = skills.get(action.config.skillId);
      if (
        !isBuiltinHookSkillId(action.config.skillId)
        || !action.config.skillName
        || skill?.name !== action.config.skillName
      ) {
        throw createHttpError(`Skill ${action.config.skillName || '(empty)'} was not validated as a built-in Hook Skill`);
      }
    }
  }
}

const BUILTIN_TOOLS = Object.freeze([
  {
    name: 'Bash',
    description: 'Claude Code command tool',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Command that will be executed',
        },
        description: {
          type: 'string',
          description: 'Command description shown to the user',
        },
        timeout: {
          type: 'number',
          description: 'Maximum execution time in milliseconds',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Run the command in the background',
        },
      },
    },
  },
  {
    name: 'Write',
    description: 'Claude Code file write tool',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target file path' },
        content: { type: 'string', description: 'Complete file content' },
      },
    },
  },
  {
    name: 'Edit',
    description: 'Claude Code file edit tool',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target file path' },
        old_string: { type: 'string', description: 'Text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every matching occurrence',
        },
      },
    },
  },
  {
    name: 'Skill',
    description: 'Claude Code Skill tool',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name' },
        args: { type: 'string', description: 'Skill arguments' },
      },
    },
  },
]);

export function createHookConfigService({ database = db, configStore = appConfigDb } = {}) {
  const getRow = (hookId) => database.prepare('SELECT * FROM hooks WHERE id = ?').get(hookId);
  const getHook = (hookId) => {
    const row = getRow(hookId);
    if (!row) return null;
    const bindingCount = database
      .prepare(
        `
      SELECT COUNT(*) AS count FROM user_hook_bindings WHERE hook_id = ?
    `,
      )
      .get(hookId);
    const tenantBindingCount = database
      .prepare('SELECT COUNT(*) AS count FROM hook_tenant_bindings WHERE hook_id = ?')
      .get(hookId);
    return mapHookRow({
      ...row,
      bound_user_count: bindingCount?.count || 0,
      bound_tenant_count: tenantBindingCount?.count || 0,
    });
  };
  const requireHook = (hookId) => {
    const hook = getHook(hookId);
    if (!hook) throw createHttpError('Hook not found', 404);
    return hook;
  };
  const getSqlCheckHookRow = ({ publishedOnly = false } = {}) => database.prepare(`
    SELECT *
    FROM hooks
    WHERE binding_controller = 'sql_check'
      ${publishedOnly ? "AND status = 'published'" : ''}
    ORDER BY
      CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
      updated_at DESC,
      created_at DESC
    LIMIT 1
  `).get();
  const getSqlCheckEnforcement = ({ userId }) => {
    const normalizedUserId = Number(userId);
    if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw createHttpError('userId must be a positive integer');
    }
    const hook = getSqlCheckHookRow();
    if (!hook) {
      return {
        available: false,
        enabled: false,
        hookId: null,
        hookName: null,
        hookStatus: null,
        reason: 'not_configured',
      };
    }
    const available = hook.status === 'published';
    const binding = available
      ? database.prepare(`
        SELECT 1 AS enabled
        FROM user_hook_bindings
        WHERE user_id = ? AND hook_id = ?
      `).get(normalizedUserId, hook.id)
      : null;
    return {
      available,
      enabled: Boolean(binding),
      hookId: hook.id,
      hookName: hook.name,
      hookStatus: hook.status,
      reason: available ? null : 'not_published',
    };
  };
  const queryExecutions = ({
    hookId,
    eventName,
    status,
    userId,
    sessionId,
    toolUseId,
    q,
    bindingController,
    outcome,
    limit,
    offset,
    summary = false,
  } = {}) => {
    const normalizedLimit = normalizeRecordLimit(limit);
    const normalizedOffset = normalizeRecordOffset(offset);
    if (!hasTable(database, 'hook_executions')) {
      return {
        executions: [],
        total: 0,
        executionTotal: 0,
        limit: normalizedLimit,
        offset: normalizedOffset,
      };
    }
    const conditions = [];
    const parameters = [];
    if (hookId) {
      conditions.push('e.hook_id = ?');
      parameters.push(String(hookId));
    }
    if (eventName) {
      conditions.push('e.event_name = ?');
      parameters.push(normalizeEventName(eventName));
    }
    if (status) {
      if (!['running', 'succeeded', 'failed'].includes(status)) {
        throw createHttpError('status must be running, succeeded, or failed');
      }
      conditions.push('e.status = ?');
      parameters.push(status);
    }
    if (userId != null && userId !== '') {
      const normalizedUserId = Number(userId);
      if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
        throw createHttpError('userId must be a positive integer');
      }
      conditions.push('e.user_id = ?');
      parameters.push(normalizedUserId);
    }
    if (sessionId) {
      conditions.push('e.session_id = ?');
      parameters.push(requireString(String(sessionId), 'sessionId', { max: 300 }));
    }
    if (toolUseId) {
      conditions.push('e.tool_use_id = ?');
      parameters.push(requireString(String(toolUseId), 'toolUseId', { max: 300 }));
    }
    if (bindingController) {
      if (!['admin', 'sql_check'].includes(bindingController)) {
        throw createHttpError('bindingController must be admin or sql_check');
      }
      conditions.push("COALESCE(h.binding_controller, 'admin') = ?");
      parameters.push(bindingController);
    }

    const safeInputJson = "CASE WHEN json_valid(e.input_json) THEN e.input_json ELSE '{}' END";
    const safeActionsJson = "CASE WHEN json_valid(e.actions_json) THEN e.actions_json ELSE '{}' END";
    const safeResponseJson = "CASE WHEN json_valid(e.response_json) THEN e.response_json ELSE '{}' END";
    const permissionDecisionSql = `COALESCE(
      json_extract(${safeResponseJson}, '$.hookSpecificOutput.permissionDecision'),
      json_extract(${safeResponseJson}, '$.hookSpecificOutput.decision.behavior')
    )`;
    const outcomeSql = `CASE
      WHEN e.status = 'failed' THEN 'failed'
      WHEN ${permissionDecisionSql} = 'deny'
        OR json_extract(${safeResponseJson}, '$.decision') = 'block' THEN 'denied'
      WHEN json_extract(${safeResponseJson}, '$.continue') = 0 THEN 'stopped'
      WHEN ${permissionDecisionSql} = 'ask' THEN 'ask'
      WHEN ${permissionDecisionSql} = 'defer' THEN 'defer'
      WHEN json_type(${safeResponseJson}, '$.hookSpecificOutput.updatedInput') IS NOT NULL THEN 'modified_input'
      WHEN json_type(${safeResponseJson}, '$.hookSpecificOutput.updatedMCPToolOutput') IS NOT NULL
        OR json_type(${safeResponseJson}, '$.hookSpecificOutput.updatedToolOutput') IS NOT NULL THEN 'modified_output'
      WHEN EXISTS (SELECT 1 FROM json_each(${safeActionsJson})) THEN 'post_action'
      WHEN COALESCE(json_extract(${safeResponseJson}, '$.hookSpecificOutput.additionalContext'), '') <> ''
        THEN 'additional_context'
      ELSE 'succeeded'
    END`;

    if (outcome) {
      if (!EXECUTION_OUTCOMES.has(outcome)) {
        throw createHttpError('outcome is not supported');
      }
      conditions.push(`${outcomeSql} = ?`);
      parameters.push(outcome);
    }
    const normalizedQuery = String(q || '').trim().toLowerCase();
    if (normalizedQuery) {
      if (normalizedQuery.length > 300) throw createHttpError('q must be 300 characters or fewer');
      const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
      conditions.push(`(
        LOWER(COALESCE(h.name, e.hook_id, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(users.username, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(CAST(e.user_id AS TEXT), '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(CAST(e.tenant_id AS TEXT), '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(CAST(e.workspace_id AS TEXT), '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.session_id, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.tool_use_id, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.event_name, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(json_extract(${safeInputJson}, '$.tool_name'), '')) LIKE ? ESCAPE '\\'
      )`);
      parameters.push(...Array(9).fill(pattern));
    }

    const groupKeySql = `CASE
      WHEN NULLIF(e.tool_use_id, '') IS NOT NULL THEN
        'tool:' || COALESCE(e.session_id, '') || CHAR(31) || e.event_name || CHAR(31) || e.tool_use_id
      ELSE 'execution:' || e.id
    END`;
    const sortTimeSql = `COALESCE(
      e.started_at_ms,
      CAST(strftime('%s', e.started_at) AS INTEGER) * 1000,
      0
    )`;
    const filteredCte = `
      WITH filtered AS (
        SELECT e.*, h.name AS hook_name, h.binding_controller, users.username,
          ${groupKeySql} AS execution_group_key,
          ${sortTimeSql} AS execution_sort_ms,
          e.rowid AS execution_rowid
        FROM hook_executions e
        LEFT JOIN hooks h ON h.id = e.hook_id
        LEFT JOIN users ON users.id = e.user_id
        ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      )
    `;
    const totals = database.prepare(`
      ${filteredCte}
      SELECT COUNT(*) AS total, COALESCE(SUM(execution_count), 0) AS execution_total
      FROM (
        SELECT execution_group_key, COUNT(*) AS execution_count
        FROM filtered
        GROUP BY execution_group_key
      ) grouped
    `).get(...parameters);
    const rows = database.prepare(`
      ${filteredCte},
      page_groups AS (
        SELECT execution_group_key,
          MAX(execution_sort_ms) AS group_sort_ms,
          MAX(execution_rowid) AS group_sort_rowid
        FROM filtered
        GROUP BY execution_group_key
        ORDER BY group_sort_ms DESC, group_sort_rowid DESC
        LIMIT ? OFFSET ?
      )
      SELECT filtered.*
      FROM filtered
      INNER JOIN page_groups USING (execution_group_key)
      ORDER BY page_groups.group_sort_ms DESC, page_groups.group_sort_rowid DESC,
        filtered.execution_sort_ms DESC, filtered.execution_rowid DESC
    `).all(...parameters, normalizedLimit, normalizedOffset);
    return {
      executions: rows.map((row) => mapExecutionRow(row, { summary })),
      total: Number(totals?.total || 0),
      executionTotal: Number(totals?.execution_total || 0),
      limit: normalizedLimit,
      offset: normalizedOffset,
    };
  };
  return {
    listHooks: () => {
      const rows = database
        .prepare(
          `
        SELECT h.*,
          (SELECT COUNT(*) FROM user_hook_bindings b WHERE b.hook_id = h.id) AS bound_user_count,
          (SELECT COUNT(*) FROM hook_tenant_bindings tb WHERE tb.hook_id = h.id) AS bound_tenant_count
        FROM hooks h
        ORDER BY h.updated_at DESC, h.created_at DESC
      `,
        )
        .all();
      return rows.map(mapHookRow);
    },

    listActiveHooksForUser: (userId) => {
      const rows = database
        .prepare(
          `
        SELECT h.*,
          (SELECT COUNT(*) FROM user_hook_bindings all_bindings WHERE all_bindings.hook_id = h.id) AS bound_user_count,
          (SELECT COUNT(*) FROM hook_tenant_bindings all_tenant_bindings WHERE all_tenant_bindings.hook_id = h.id) AS bound_tenant_count
        FROM hooks h
        WHERE h.status = 'published'
          AND (
            h.activation_scope = 'all_users'
            OR EXISTS (
              SELECT 1
              FROM user_hook_bindings binding
              WHERE binding.hook_id = h.id
                AND binding.user_id = ?
            )
            OR EXISTS (
              SELECT 1
              FROM hook_tenant_bindings tenant_binding
              INNER JOIN tenant_users membership
                ON membership.tenant_id = tenant_binding.tenant_id
               AND membership.user_id = ?
               AND membership.status = 'active'
              INNER JOIN tenants tenant
                ON tenant.id = tenant_binding.tenant_id
               AND tenant.status = 'active'
              WHERE tenant_binding.hook_id = h.id
            )
          )
        ORDER BY h.updated_at DESC, h.created_at DESC
      `,
        )
        .all(userId, userId);
      return rows.map(mapHookRow);
    },

    getHook,

    listHookBindings: (hookId) => {
      const hook = requireHook(hookId);
      if (hook.bindingController === 'sql_check') {
        throw createHttpError('SQL Check Hook bindings are managed by each user from the SQL Check page', 409);
      }
      const users = database
        .prepare(
          `
        SELECT
          users.id,
          users.username,
          users.is_active,
          users.is_system_admin,
          CASE WHEN binding.user_id IS NULL THEN 0 ELSE 1 END AS is_bound
        FROM users
        LEFT JOIN user_hook_bindings binding
          ON binding.user_id = users.id
         AND binding.hook_id = ?
        ORDER BY users.username COLLATE NOCASE ASC, users.id ASC
      `,
        )
        .all(hookId)
        .map((row) => ({
          id: row.id,
          username: row.username,
          isActive: row.is_active === 1,
          isSystemAdmin: row.is_system_admin === 1,
          bound: row.is_bound === 1,
        }));
      const tenants = database
        .prepare(
          `
        SELECT
          tenants.id,
          tenants.code,
          tenants.name,
          tenants.status,
          CASE WHEN binding.tenant_id IS NULL THEN 0 ELSE 1 END AS is_bound,
          (
            SELECT COUNT(*)
            FROM tenant_users membership
            INNER JOIN users ON users.id = membership.user_id AND users.is_active = 1
            WHERE membership.tenant_id = tenants.id
              AND membership.status = 'active'
          ) AS active_user_count
        FROM tenants
        LEFT JOIN hook_tenant_bindings binding
          ON binding.tenant_id = tenants.id
         AND binding.hook_id = ?
        ORDER BY tenants.name COLLATE NOCASE ASC, tenants.id ASC
      `,
        )
        .all(hookId)
        .map((row) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          active: row.status === 'active',
          activeUserCount: Number(row.active_user_count || 0),
          bound: row.is_bound === 1,
        }));
      return {
        scope: hook.activationScope === 'all_users'
          ? 'all_users'
          : hook.boundTenantCount > 0
            ? 'tenants'
            : 'users',
        users,
        tenants,
      };
    },

    replaceHookBindings: ({ hookId, scope = 'users', userIds = [], tenantIds = [], boundBy }) => {
      const hook = requireHook(hookId);
      if (hook.bindingController === 'sql_check') {
        throw createHttpError('SQL Check Hook bindings are managed by each user from the SQL Check page', 409);
      }
      if (hook.status !== 'published') {
        throw createHttpError('Publish the Hook before binding users');
      }
      if (!['users', 'tenants', 'all_users'].includes(scope)) {
        throw createHttpError('scope must be users, tenants, or all_users');
      }
      if (!Array.isArray(userIds)) throw createHttpError('userIds must be an array');
      if (!Array.isArray(tenantIds)) throw createHttpError('tenantIds must be an array');
      const normalizedUserIds = [...new Set(userIds.map((value) => Number(value)))];
      const normalizedTenantIds = [...new Set(tenantIds.map((value) => Number(value)))];
      if (normalizedUserIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw createHttpError('userIds must contain positive integer user IDs');
      }
      if (normalizedTenantIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw createHttpError('tenantIds must contain positive integer tenant IDs');
      }
      if (scope === 'users' && normalizedUserIds.length > 0) {
        const placeholders = normalizedUserIds.map(() => '?').join(', ');
        const activeUsers = database
          .prepare(`SELECT id FROM users WHERE is_active = 1 AND id IN (${placeholders})`)
          .all(...normalizedUserIds);
        if (activeUsers.length !== normalizedUserIds.length) {
          throw createHttpError('One or more selected users do not exist or are inactive');
        }
      }
      if (scope === 'tenants') {
        if (normalizedTenantIds.length === 0) {
          throw createHttpError('Select at least one active tenant');
        }
        const placeholders = normalizedTenantIds.map(() => '?').join(', ');
        const activeTenants = database
          .prepare(`SELECT id FROM tenants WHERE status = 'active' AND id IN (${placeholders})`)
          .all(...normalizedTenantIds);
        if (activeTenants.length !== normalizedTenantIds.length) {
          throw createHttpError('One or more selected tenants do not exist or are inactive');
        }
      }

      const replace = database.transaction(() => {
        database.prepare('DELETE FROM user_hook_bindings WHERE hook_id = ?').run(hookId);
        database.prepare('DELETE FROM hook_tenant_bindings WHERE hook_id = ?').run(hookId);
        const insert = database.prepare(
          `
          INSERT INTO user_hook_bindings (user_id, hook_id, bound_by)
          VALUES (?, ?, ?)
        `,
        );
        if (scope === 'users') {
          for (const userId of normalizedUserIds) insert.run(userId, hookId, boundBy);
        }
        if (scope === 'tenants') {
          const insertTenant = database.prepare(
            `
            INSERT INTO hook_tenant_bindings (hook_id, tenant_id, bound_by)
            VALUES (?, ?, ?)
          `,
          );
          for (const tenantId of normalizedTenantIds) insertTenant.run(hookId, tenantId, boundBy);
        }
        database
          .prepare(
            `
          UPDATE hooks
          SET activation_scope = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
          WHERE id = ?
        `,
          )
          .run(scope === 'all_users' ? 'all_users' : 'manual', boundBy, hookId);
      });
      replace();
      return {
        scope,
        hook: getHook(hookId),
      };
    },

    getSqlCheckEnforcement,

    setSqlCheckEnforcement: ({ userId, enabled }) => {
      const normalizedUserId = Number(userId);
      if (!Number.isSafeInteger(normalizedUserId) || normalizedUserId <= 0) {
        throw createHttpError('userId must be a positive integer');
      }
      if (typeof enabled !== 'boolean') {
        throw createHttpError('enabled must be a boolean');
      }
      const hook = getSqlCheckHookRow({ publishedOnly: true });
      if (!hook) {
        throw createHttpError('A published SQL Check Hook is required before enabling enforcement', 409);
      }
      const update = database.transaction(() => {
        database.prepare(`
          UPDATE hooks
          SET activation_scope = 'manual'
          WHERE id = ?
        `).run(hook.id);
        database.prepare('DELETE FROM hook_tenant_bindings WHERE hook_id = ?').run(hook.id);
        if (enabled) {
          database.prepare(`
            INSERT INTO user_hook_bindings (user_id, hook_id, bound_by)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, hook_id)
            DO UPDATE SET
              bound_by = excluded.bound_by,
              updated_at = CURRENT_TIMESTAMP
          `).run(normalizedUserId, hook.id, normalizedUserId);
        } else {
          database.prepare(`
            DELETE FROM user_hook_bindings
            WHERE user_id = ? AND hook_id = ?
          `).run(normalizedUserId, hook.id);
        }
      });
      update();
      return getSqlCheckEnforcement({ userId: normalizedUserId });
    },

    listExecutions: (hookId, filters = {}) => {
      requireHook(hookId);
      return queryExecutions({ ...filters, hookId }).executions;
    },

    listExecutionPage: (hookId, filters = {}) => {
      requireHook(hookId);
      return queryExecutions({ ...filters, hookId, summary: true });
    },

    listAllExecutions: (filters = {}) => queryExecutions({ ...filters, summary: true }).executions,

    listAllExecutionPage: (filters = {}) => queryExecutions({ ...filters, summary: true }),

    getExecution: (executionId) => {
      if (!hasTable(database, 'hook_executions')) return null;
      const row = database.prepare(`
        SELECT e.*, h.name AS hook_name, h.binding_controller, users.username
        FROM hook_executions e
        LEFT JOIN hooks h ON h.id = e.hook_id
        LEFT JOIN users ON users.id = e.user_id
        WHERE e.id = ?
      `).get(executionId);
      return mapExecutionRow(row);
    },

    listDataRecords: (hookId, { limit } = {}) => {
      requireHook(hookId);
      if (!hasTable(database, 'hook_data_records')) return [];
      return database
        .prepare(`
          SELECT * FROM hook_data_records
          WHERE hook_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        `)
        .all(hookId, normalizeRecordLimit(limit))
        .map(mapDataRecordRow);
    },

    createHook: ({ input, userId }) => {
      const normalized = normalizeHookInput(input);
      const hookId = crypto.randomUUID();
      database
        .prepare(
          `
        INSERT INTO hooks (
          id, name, description, status, event_name, matcher_json,
          extension_logic_json, post_actions_json, claude_response_json,
          binding_controller, created_by, updated_by
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          hookId,
          normalized.name,
          normalized.description,
          normalized.eventName,
          JSON.stringify(normalized.matcher),
          JSON.stringify(normalized.extensionLogic),
          JSON.stringify(normalized.postActions),
          JSON.stringify(normalized.claudeResponse),
          normalized.name === SQL_CHECK_HOOK_NAME ? 'sql_check' : 'admin',
          userId,
          userId,
        );
      return getHook(hookId);
    },

    updateHook: ({ hookId, input, userId }) => {
      requireHook(hookId);
      const normalized = normalizeHookInput(input);
      database
        .prepare(
          `
        UPDATE hooks
        SET name = ?, description = ?, status = 'draft', event_name = ?,
            matcher_json = ?, extension_logic_json = ?, post_actions_json = ?,
            claude_response_json = ?,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(
          normalized.name,
          normalized.description,
          normalized.eventName,
          JSON.stringify(normalized.matcher),
          JSON.stringify(normalized.extensionLogic),
          JSON.stringify(normalized.postActions),
          JSON.stringify(normalized.claudeResponse),
          userId,
          hookId,
        );
      return getHook(hookId);
    },

    publishHook: ({ hookId, userId, validatedSkills = [] }) => {
      const hook = requireHook(hookId);
      const normalized = normalizeHookInput(hook, { strict: true });
      validatePublishResources(normalized, database, validatedSkills);
      database
        .prepare(
          `
        UPDATE hooks
        SET status = 'published', version = version + 1,
            published_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `,
        )
        .run(userId, hookId);
      return getHook(hookId);
    },

    deleteHook: (hookId) => {
      const hook = requireHook(hookId);
      if (hook.bindingController === 'sql_check') {
        throw createHttpError('Built-in SQL Check Hook cannot be deleted', 409);
      }
      const result = database.prepare('DELETE FROM hooks WHERE id = ?').run(hookId);
      if (result.changes === 0) throw createHttpError('Hook not found', 404);
      return true;
    },

    getSettings: () => {
      const stored = parseJson(configStore.get(VISIBLE_EVENTS_CONFIG_KEY), null);
      const visibleEvents = Array.isArray(stored)
        ? stored.filter((eventName, index) => EVENT_SET.has(eventName) && stored.indexOf(eventName) === index)
        : [];
      return {
        visibleEvents: visibleEvents.length > 0 ? visibleEvents : [...DEFAULT_VISIBLE_EVENTS],
      };
    },

    updateSettings: (input) => {
      const visibleEvents = Array.isArray(input?.visibleEvents)
        ? input.visibleEvents.filter(
            (eventName, index, values) => EVENT_SET.has(eventName) && values.indexOf(eventName) === index,
          )
        : [];
      if (visibleEvents.length === 0) {
        throw createHttpError('Select at least one visible Hook event');
      }
      configStore.set(VISIBLE_EVENTS_CONFIG_KEY, JSON.stringify(visibleEvents));
      return { visibleEvents };
    },

    getResources: () => ({
      events: [...HOOK_EVENTS],
      builtinTools: BUILTIN_TOOLS,
      mcpTools: listMcpToolCatalog(database),
      skills: [],
      environmentVariables: [
        { path: 'ccui.env.userId', type: 'number' },
        { path: 'ccui.env.username', type: 'string' },
        { path: 'ccui.env.tenantId', type: 'number' },
        { path: 'ccui.env.workspaceId', type: 'number' },
        { path: 'ccui.env.sessionId', type: 'string' },
      ],
    }),
  };
}

export const hookConfigService = createHookConfigService();

export {
  DEFAULT_VISIBLE_EVENTS,
  HOOK_EVENTS,
  POST_ACTION_TYPES,
  SQL_CHECK_HOOK_NAME,
  allowedClaudeOutputs,
  allowedPostActions,
  normalizeHookInput,
};
