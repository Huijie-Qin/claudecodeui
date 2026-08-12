import crypto from 'node:crypto';

import { appConfigDb, db } from '../database/db.js';

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
const MAX_SCRIPT_BYTES = 128 * 1024;
const MAX_POST_ACTIONS = 20;
const POST_ACTION_TYPES = Object.freeze(['call_mcp_tool', 'invoke_skill']);
const SKILL_ACTION_EVENTS = new Set(['Stop', 'StopFailure']);
const SCRIPT_OUTPUT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);
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
  return new Set(SKILL_ACTION_EVENTS.has(eventName) ? POST_ACTION_TYPES : ['call_mcp_tool']);
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

function normalizePostActions(value, eventName) {
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
          inputs,
        },
      };
    }
    if (action.type === 'invoke_skill') {
      const maxTurns = Number(config.maxTurns ?? 3);
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 5) {
        throw createHttpError(`postActions[${index}].config.maxTurns must be an integer from 1 to 5`);
      }
      return {
        id,
        type: 'invoke_skill',
        position: index,
        config: {
          skillName: requireString(
            typeof config.skillName === 'string' ? config.skillName : '',
            `postActions[${index}].config.skillName`,
            { max: 120, allowEmpty: true },
          ),
          argumentsTemplate: requireString(
            typeof config.argumentsTemplate === 'string' ? config.argumentsTemplate : '',
            `postActions[${index}].config.argumentsTemplate`,
            { max: 10000, allowEmpty: true },
          ),
          maxTurns,
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
    if (action.type === 'call_mcp_tool') {
      for (const binding of Object.values(action.config.inputs)) {
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
    eventName: row.event_name,
    matcher: parseJson(row.matcher_json, {}),
    extensionLogic: normalizeExtensionLogic(parseJson(row.extension_logic_json, null)),
    postActions: normalizePostActions(parseJson(row.post_actions_json, []), row.event_name),
    claudeResponse: normalizeClaudeResponse(parseJson(row.claude_response_json, { bindings: {} })),
    version: Number(row.version || 0),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
    boundUserCount: Number(row.bound_user_count || 0),
  };
}

function hasTable(database, tableName) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function normalizeRecordLimit(value) {
  const number = Number(value ?? 50);
  return Number.isInteger(number) && number > 0 ? Math.min(number, 200) : 50;
}

function mapExecutionRow(row) {
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
    input: parseJson(row.input_json, {}),
    scriptOutput: parseJson(row.script_output_json, null),
    actions: parseJson(row.actions_json, {}),
    response: parseJson(row.response_json, {}),
    logs: parseJson(row.logs_json, []),
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    completedAt: row.completed_at,
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

function listSkillCatalog(database) {
  if (!hasTable(database, 'tenant_skill_presets')) return [];
  const rows = database
    .prepare(
      `
    SELECT p.name, p.display_name, p.description, t.code AS tenant_code
    FROM tenant_skill_presets p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.status = 'published'
    ORDER BY p.display_name, p.name
  `,
    )
    .all();
  const byName = new Map();
  for (const row of rows) {
    const current = byName.get(row.name) || {
      name: row.name,
      displayName: row.display_name,
      description: row.description || '',
      tenantCodes: [],
    };
    if (!current.tenantCodes.includes(row.tenant_code)) current.tenantCodes.push(row.tenant_code);
    byName.set(row.name, current);
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function validatePublishResources(hook, database) {
  const mcpTools = new Map(listMcpToolCatalog(database).map((tool) => [tool.name, tool]));
  const skills = new Set(listSkillCatalog(database).map((skill) => skill.name));
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
    } else if (!action.config.skillName || !skills.has(action.config.skillName)) {
      throw createHttpError(`Skill ${action.config.skillName || '(empty)'} is not available`);
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
    return mapHookRow({ ...row, bound_user_count: bindingCount?.count || 0 });
  };
  const requireHook = (hookId) => {
    const hook = getHook(hookId);
    if (!hook) throw createHttpError('Hook not found', 404);
    return hook;
  };
  return {
    listHooks: () => {
      const rows = database
        .prepare(
          `
        SELECT h.*,
          (SELECT COUNT(*) FROM user_hook_bindings b WHERE b.hook_id = h.id) AS bound_user_count
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
          (SELECT COUNT(*) FROM user_hook_bindings all_bindings WHERE all_bindings.hook_id = h.id) AS bound_user_count
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
          )
        ORDER BY h.updated_at DESC, h.created_at DESC
      `,
        )
        .all(userId);
      return rows.map(mapHookRow);
    },

    getHook,

    listExecutions: (hookId, { limit } = {}) => {
      requireHook(hookId);
      if (!hasTable(database, 'hook_executions')) return [];
      return database
        .prepare(`
          SELECT * FROM hook_executions
          WHERE hook_id = ?
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?
        `)
        .all(hookId, normalizeRecordLimit(limit))
        .map(mapExecutionRow);
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
          created_by, updated_by
        ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
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

    publishHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      const normalized = normalizeHookInput(hook, { strict: true });
      validatePublishResources(normalized, database);
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

    startHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      if (hook.status !== 'published') {
        throw createHttpError('Publish the Hook before starting it');
      }
      database
        .prepare(
          `
        UPDATE hooks
        SET activation_scope = 'all_users', updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `,
        )
        .run(userId, hookId);
      return getHook(hookId);
    },

    stopHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      if (hook.status !== 'published') {
        throw createHttpError('Only a published Hook can be stopped');
      }
      database
        .prepare(
          `
        UPDATE hooks
        SET activation_scope = 'manual', updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `,
        )
        .run(userId, hookId);
      return getHook(hookId);
    },

    deleteHook: (hookId) => {
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
      skills: listSkillCatalog(database),
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
  allowedClaudeOutputs,
  allowedPostActions,
  normalizeHookInput,
};
