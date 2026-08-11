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

const DEFAULT_VISIBLE_EVENTS = Object.freeze([
  'Stop',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
]);

const EVENT_SET = new Set(HOOK_EVENTS);
const ACTION_TYPES = new Set([
  'record_data',
  'call_tool',
  'append_context',
  'invoke_skill_recovery',
  'decision',
  'update_input',
  'update_output',
]);
const CONDITION_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'matches_regex',
  'greater_than',
  'less_than',
  'is_true',
  'is_false',
  'is_empty',
  'is_not_empty',
]);
const GATE_EXCLUDED_FIELDS = new Set([
  '$context.sessionId',
  '$context.transcriptPath',
  '$context.cwd',
  '$context.userId',
  '$context.tenantId',
  '$context.projectId',
]);
const APPEND_CONTEXT_EVENTS = new Set([
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
const DECISION_EVENTS = new Set([
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
const TOOL_MATCHER_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);
const VISIBLE_EVENTS_CONFIG_KEY = 'admin_hook_visible_events';
const MAX_ACTIONS = 20;
const MAX_CONDITIONS = 20;
const MAX_SCRIPT_BYTES = 128 * 1024;

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

function normalizeMatcher(value) {
  const source = isPlainObject(value) ? value : {};
  const mode = source.mode === 'regex' ? 'regex' : 'exact';
  const matcherValue = typeof source.value === 'string' ? source.value.trim() : '';
  if (matcherValue.length > 240) {
    throw createHttpError('matcher.value must be 240 characters or fewer');
  }
  if (mode === 'regex' && matcherValue) {
    try {
      new RegExp(matcherValue);
    } catch {
      throw createHttpError('matcher.value is not a valid regular expression');
    }
  }
  return matcherValue ? { mode, value: matcherValue } : {};
}

function normalizeCondition(condition, index) {
  if (!isPlainObject(condition)) {
    throw createHttpError(`gate.conditions[${index}] must be an object`);
  }
  const field = requireString(condition.field, `gate.conditions[${index}].field`, { max: 180 });
  if (GATE_EXCLUDED_FIELDS.has(field)) {
    throw createHttpError(`${field} cannot be used as an execution gate`);
  }
  const operator = String(condition.operator || '');
  if (!CONDITION_OPERATORS.has(operator)) {
    throw createHttpError(`gate.conditions[${index}].operator is not supported`);
  }
  const normalized = {
    id: typeof condition.id === 'string' && condition.id.trim()
      ? condition.id.trim().slice(0, 80)
      : crypto.randomUUID(),
    field,
    operator,
  };
  if (!['is_true', 'is_false', 'is_empty', 'is_not_empty'].includes(operator)) {
    const value = condition.value;
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw createHttpError(`gate.conditions[${index}].value is required`);
    }
    normalized.value = value;
    if (operator === 'matches_regex') {
      try {
        new RegExp(String(value));
      } catch {
        throw createHttpError(`gate.conditions[${index}].value is not a valid regular expression`);
      }
    }
  }
  return normalized;
}

function normalizeGate(value) {
  const source = isPlainObject(value) ? value : {};
  const mode = source.mode === 'any' ? 'any' : 'all';
  const conditions = Array.isArray(source.conditions) ? source.conditions : [];
  if (conditions.length > MAX_CONDITIONS) {
    throw createHttpError(`A Hook can contain at most ${MAX_CONDITIONS} execution conditions`);
  }
  return {
    mode,
    conditions: conditions.map(normalizeCondition),
  };
}

function normalizeScriptOutput(output, index) {
  if (!isPlainObject(output)) {
    throw createHttpError(`advancedScript.outputs[${index}] must be an object`);
  }
  const name = requireString(output.name, `advancedScript.outputs[${index}].name`, { max: 80 });
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    throw createHttpError(`advancedScript.outputs[${index}].name is invalid`);
  }
  const type = ['string', 'number', 'boolean', 'object', 'array'].includes(output.type)
    ? output.type
    : 'string';
  return {
    name,
    type,
    description: requireString(
      typeof output.description === 'string' ? output.description : '',
      `advancedScript.outputs[${index}].description`,
      { max: 240, allowEmpty: true },
    ),
  };
}

function normalizeAdvancedScript(value) {
  if (!isPlainObject(value) || value.enabled !== true) return null;
  const code = typeof value.code === 'string' ? value.code : '';
  if (Buffer.byteLength(code, 'utf8') > MAX_SCRIPT_BYTES) {
    throw createHttpError('advancedScript.code is too large');
  }
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  if (outputs.length > 50) {
    throw createHttpError('advancedScript.outputs can contain at most 50 fields');
  }
  const seen = new Set();
  return {
    enabled: true,
    language: 'javascript',
    code,
    outputs: outputs.map(normalizeScriptOutput).filter((output) => {
      if (seen.has(output.name)) return false;
      seen.add(output.name);
      return true;
    }),
  };
}

function normalizeActionConfig(config, index) {
  const normalized = isPlainObject(config) ? structuredClone(config) : {};
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    throw createHttpError(`actions[${index}].config is too large`);
  }
  return normalized;
}

function normalizeActions(value) {
  const actions = Array.isArray(value) ? value : [];
  if (actions.length > MAX_ACTIONS) {
    throw createHttpError(`A Hook can contain at most ${MAX_ACTIONS} actions`);
  }
  const seen = new Set();
  return actions.map((action, index) => {
    if (!isPlainObject(action)) {
      throw createHttpError(`actions[${index}] must be an object`);
    }
    const type = String(action.type || '');
    if (!ACTION_TYPES.has(type)) {
      throw createHttpError(`actions[${index}].type is not supported`);
    }
    let id = typeof action.id === 'string' && action.id.trim()
      ? action.id.trim().slice(0, 100)
      : crypto.randomUUID();
    if (seen.has(id)) id = crypto.randomUUID();
    seen.add(id);
    return {
      id,
      type,
      position: index,
      config: normalizeActionConfig(action.config, index),
    };
  });
}

function allowedActionTypes(eventName, matcher) {
  const allowed = new Set(['record_data', 'call_tool']);
  if (APPEND_CONTEXT_EVENTS.has(eventName)) allowed.add('append_context');
  if (DECISION_EVENTS.has(eventName)) allowed.add('decision');
  if (eventName === 'StopFailure') allowed.add('invoke_skill_recovery');
  if (eventName === 'PreToolUse' && isConcreteToolMatcher(matcher)) allowed.add('update_input');
  if (eventName === 'PostToolUse') allowed.add('update_output');
  return allowed;
}

function isConcreteToolMatcher(matcher) {
  if (!isPlainObject(matcher) || matcher.mode === 'regex') return false;
  const value = matcher.value;
  return typeof value === 'string' && Boolean(value) && value !== '*';
}

function requireConfigString(config, key, actionIndex, { max = 20000 } = {}) {
  const value = typeof config[key] === 'string' ? config[key].trim() : '';
  if (!value) {
    throw createHttpError(`actions[${actionIndex}].config.${key} is required before publishing`);
  }
  if (value.length > max) {
    throw createHttpError(`actions[${actionIndex}].config.${key} is too long`);
  }
  return value;
}

function validateActionForPublish(action, index, eventName, matcher) {
  const allowed = allowedActionTypes(eventName, matcher);
  if (!allowed.has(action.type)) {
    throw createHttpError(`${action.type} is not available for ${eventName}`);
  }
  const config = action.config;
  switch (action.type) {
    case 'record_data':
      if (!Array.isArray(config.fields) || config.fields.length === 0) {
        throw createHttpError(`actions[${index}] must select at least one field to record`);
      }
      break;
    case 'call_tool':
      if (!requireConfigString(config, 'toolName', index).startsWith('mcp__')) {
        throw createHttpError(`actions[${index}] can only call an MCP tool`);
      }
      if (!isPlainObject(config.inputs)) {
        throw createHttpError(`actions[${index}].config.inputs must be an object`);
      }
      break;
    case 'append_context':
      requireConfigString(config, 'template', index);
      break;
    case 'invoke_skill_recovery': {
      requireConfigString(config, 'skillName', index, { max: 160 });
      requireConfigString(config, 'argumentsTemplate', index);
      const maxTurns = Number(config.maxTurns);
      if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 5) {
        throw createHttpError(`actions[${index}].config.maxTurns must be between 1 and 5`);
      }
      break;
    }
    case 'decision':
      requireConfigString(config, 'outcome', index, { max: 40 });
      requireConfigString(config, 'reason', index);
      break;
    case 'update_input':
    case 'update_output':
      requireConfigString(config, 'targetPath', index, { max: 240 });
      if (!isPlainObject(config.replacement)) {
        throw createHttpError(`actions[${index}].config.replacement is required`);
      }
      if (config.replacement.source === 'reference') {
        requireConfigString(config.replacement, 'path', index, { max: 240 });
      } else if (!Object.hasOwn(config.replacement, 'value')) {
        throw createHttpError(`actions[${index}].config.replacement.value is required`);
      }
      break;
    default:
      break;
  }
}

function normalizeHookInput(input, { strict = false } = {}) {
  if (!isPlainObject(input)) throw createHttpError('Hook payload must be an object');
  const eventName = normalizeEventName(input.eventName);
  const matcher = normalizeMatcher(input.matcher);
  const normalized = {
    name: requireString(input.name, 'name', { max: 120 }),
    description: requireString(
      typeof input.description === 'string' ? input.description : '',
      'description',
      { max: 1000, allowEmpty: true },
    ),
    eventName,
    matcher,
    gate: normalizeGate(input.gate),
    advancedScript: normalizeAdvancedScript(input.advancedScript),
    actions: normalizeActions(input.actions),
  };
  if (strict) {
    if (normalized.actions.length === 0) {
      throw createHttpError('Add at least one basic action before publishing');
    }
    normalized.actions.forEach((action, index) => {
      validateActionForPublish(action, index, normalized.eventName, normalized.matcher);
    });
  }
  return normalized;
}

function mapHookRow(row, actions = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    status: row.status,
    activationScope: row.activation_scope === 'all_users' ? 'all_users' : 'manual',
    eventName: row.event_name,
    matcher: parseJson(row.matcher_json, {}),
    gate: parseJson(row.gate_json, { mode: 'all', conditions: [] }),
    advancedScript: parseJson(row.advanced_script_json, null),
    actions: actions.map((action) => ({
      id: action.id,
      type: action.action_type,
      position: Number(action.position),
      config: parseJson(action.config_json, {}),
    })),
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

function listMcpToolCatalog(database) {
  if (!hasTable(database, 'mcp_server_presets')) return [];
  const rows = database.prepare(`
    SELECT p.name, p.display_name, p.description, p.tools_json, t.code AS tenant_code
    FROM mcp_server_presets p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.status = 'published'
      AND p.last_test_status = 'healthy'
      AND p.tool_count > 0
    ORDER BY p.display_name, p.name
  `).all();
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
  const rows = database.prepare(`
    SELECT p.name, p.display_name, p.description, t.code AS tenant_code
    FROM tenant_skill_presets p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE p.status = 'published'
    ORDER BY p.display_name, p.name
  `).all();
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

const BUILTIN_TOOLS = Object.freeze([
  {
    name: 'Bash',
    description: 'Claude Code command tool',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command that will be executed' },
        description: { type: 'string', description: 'Command description shown to the user' },
        timeout: { type: 'number', description: 'Maximum execution time in milliseconds' },
        run_in_background: { type: 'boolean', description: 'Run the command in the background' },
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
        replace_all: { type: 'boolean', description: 'Replace every matching occurrence' },
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
    const actions = database.prepare(`
      SELECT * FROM hook_actions WHERE hook_id = ? ORDER BY position ASC
    `).all(hookId);
    const bindingCount = database.prepare(`
      SELECT COUNT(*) AS count FROM user_hook_bindings WHERE hook_id = ?
    `).get(hookId);
    return mapHookRow({ ...row, bound_user_count: bindingCount?.count || 0 }, actions);
  };
  const requireHook = (hookId) => {
    const hook = getHook(hookId);
    if (!hook) throw createHttpError('Hook not found', 404);
    return hook;
  };
  const replaceActions = database.transaction((hookId, actions) => {
    database.prepare('DELETE FROM hook_actions WHERE hook_id = ?').run(hookId);
    const insert = database.prepare(`
      INSERT INTO hook_actions (id, hook_id, position, action_type, config_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const action of actions) {
      insert.run(action.id, hookId, action.position, action.type, JSON.stringify(action.config));
    }
  });

  return {
    listHooks: () => {
      const rows = database.prepare(`
        SELECT h.*,
          (SELECT COUNT(*) FROM hook_actions a WHERE a.hook_id = h.id) AS action_count,
          (SELECT COUNT(*) FROM user_hook_bindings b WHERE b.hook_id = h.id) AS bound_user_count
        FROM hooks h
        ORDER BY h.updated_at DESC, h.created_at DESC
      `).all();
      const loadActions = database.prepare(`
        SELECT * FROM hook_actions WHERE hook_id = ? ORDER BY position ASC
      `);
      return rows.map((row) => {
        const actions = loadActions.all(row.id);
        return {
          ...mapHookRow(row, actions),
          actionCount: Number(row.action_count || 0),
        };
      });
    },

    listActiveHooksForUser: (userId) => {
      const rows = database.prepare(`
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
      `).all(userId);
      const loadActions = database.prepare(`
        SELECT * FROM hook_actions WHERE hook_id = ? ORDER BY position ASC
      `);
      return rows.map((row) => mapHookRow(row, loadActions.all(row.id)));
    },

    getHook,

    createHook: ({ input, userId }) => {
      const normalized = normalizeHookInput(input);
      const hookId = crypto.randomUUID();
      const create = database.transaction(() => {
        database.prepare(`
          INSERT INTO hooks (
            id, name, description, status, event_name, matcher_json, gate_json,
            advanced_script_json, created_by, updated_by
          ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
        `).run(
          hookId,
          normalized.name,
          normalized.description,
          normalized.eventName,
          JSON.stringify(normalized.matcher),
          JSON.stringify(normalized.gate),
          normalized.advancedScript ? JSON.stringify(normalized.advancedScript) : null,
          userId,
          userId,
        );
        replaceActions(hookId, normalized.actions);
      });
      create();
      return getHook(hookId);
    },

    updateHook: ({ hookId, input, userId }) => {
      requireHook(hookId);
      const normalized = normalizeHookInput(input);
      const update = database.transaction(() => {
        database.prepare(`
          UPDATE hooks
          SET name = ?, description = ?, status = 'draft', event_name = ?,
              matcher_json = ?, gate_json = ?, advanced_script_json = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          normalized.name,
          normalized.description,
          normalized.eventName,
          JSON.stringify(normalized.matcher),
          JSON.stringify(normalized.gate),
          normalized.advancedScript ? JSON.stringify(normalized.advancedScript) : null,
          userId,
          hookId,
        );
        replaceActions(hookId, normalized.actions);
      });
      update();
      return getHook(hookId);
    },

    publishHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      normalizeHookInput(hook, { strict: true });
      database.prepare(`
        UPDATE hooks
        SET status = 'published', version = version + 1,
            published_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `).run(userId, hookId);
      return getHook(hookId);
    },

    startHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      if (hook.status !== 'published') {
        throw createHttpError('Publish the Hook before starting it');
      }
      database.prepare(`
        UPDATE hooks
        SET activation_scope = 'all_users', updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `).run(userId, hookId);
      return getHook(hookId);
    },

    stopHook: ({ hookId, userId }) => {
      const hook = requireHook(hookId);
      if (hook.status !== 'published') {
        throw createHttpError('Only a published Hook can be stopped');
      }
      database.prepare(`
        UPDATE hooks
        SET activation_scope = 'manual', updated_at = CURRENT_TIMESTAMP, updated_by = ?
        WHERE id = ?
      `).run(userId, hookId);
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
        ? input.visibleEvents.filter((eventName, index, values) => (
          EVENT_SET.has(eventName) && values.indexOf(eventName) === index
        ))
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
        { path: '$context.userId', type: 'number' },
        { path: '$context.username', type: 'string' },
        { path: '$context.tenantId', type: 'number' },
        { path: '$context.sessionId', type: 'string' },
        { path: '$context.projectId', type: 'number' },
      ],
    }),
  };
}

export const hookConfigService = createHookConfigService();

export {
  DEFAULT_VISIBLE_EVENTS,
  HOOK_EVENTS,
  normalizeHookInput,
};
