import crypto from 'node:crypto';

import { db as defaultDatabase } from '../database/db.js';

import { isBuiltinHookSkillId, loadBuiltinHookSkill } from './hook-builtin-skills.js';
import { allowedClaudeOutputs } from './hook-configs.js';
import { callHookMcpTool } from './hook-mcp-client.js';
import { executeHookScript } from './hook-script-executor.js';

const UNRESOLVED = Symbol('unresolved');
const MAX_AUDIT_JSON_BYTES = 128 * 1024;
const MAX_CLAUDE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 200;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function redactForAudit(value, depth = 0) {
  if (depth > 20) return '[depth limit]';
  if (Array.isArray(value)) return value.map((entry) => redactForAudit(entry, depth + 1));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : redactForAudit(entry, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]');
  }
  return value;
}

function serializeForAudit(value) {
  let json;
  try {
    json = JSON.stringify(redactForAudit(value ?? null));
  } catch {
    json = JSON.stringify({ error: 'Value is not JSON serializable' });
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_AUDIT_JSON_BYTES) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_AUDIT_JSON_BYTES) });
}

function readPath(root, dottedPath) {
  if (typeof dottedPath !== 'string' || !dottedPath.trim()) return UNRESOLVED;
  let current = root;
  for (const segment of dottedPath.split('.')) {
    if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), segment)) {
      return UNRESOLVED;
    }
    current = current[segment];
  }
  return current === undefined ? UNRESOLVED : current;
}

function renderTemplate(template, references) {
  let hasUnresolvedReference = false;
  const rendered = String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, path) => {
    const value = readPath(references, path);
    if (value === UNRESOLVED) {
      hasUnresolvedReference = true;
      return '';
    }
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  return hasUnresolvedReference ? UNRESOLVED : rendered;
}

function resolveBinding(binding, references) {
  if (!isPlainObject(binding)) return UNRESOLVED;
  if (binding.source === 'literal') return binding.value;
  if (binding.source === 'reference') return readPath(references, binding.path);
  if (binding.source === 'template') return renderTemplate(binding.template, references);
  return UNRESOLVED;
}

function setPath(target, dottedPath, value) {
  const segments = dottedPath.split('.').filter(Boolean);
  if (segments.length === 0) return;
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!isPlainObject(current[segment])) current[segment] = {};
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function assertClaudeOutputValue(pathName, value) {
  const booleanFields = new Set([
    'continue',
    'suppressOutput',
    'hookSpecificOutput.retry',
  ]);
  const stringFields = new Set([
    'stopReason',
    'systemMessage',
    'reason',
    'hookSpecificOutput.additionalContext',
    'hookSpecificOutput.initialUserMessage',
    'hookSpecificOutput.sessionTitle',
    'hookSpecificOutput.permissionDecisionReason',
    'hookSpecificOutput.worktreePath',
  ]);
  if (booleanFields.has(pathName) && typeof value !== 'boolean') {
    throw new Error(`Claude response field ${pathName} must be boolean`);
  }
  if (stringFields.has(pathName) && typeof value !== 'string') {
    throw new Error(`Claude response field ${pathName} must be string`);
  }
  if (pathName === 'decision' && !['approve', 'block'].includes(value)) {
    throw new Error('Claude response field decision must be approve or block');
  }
  if (pathName === 'hookSpecificOutput.permissionDecision' && !['allow', 'deny', 'ask', 'defer'].includes(value)) {
    throw new Error('Claude permissionDecision must be allow, deny, ask, or defer');
  }
  if (pathName === 'hookSpecificOutput.action' && !['accept', 'decline', 'cancel'].includes(value)) {
    throw new Error('Claude elicitation action must be accept, decline, or cancel');
  }
  if (['hookSpecificOutput.updatedInput', 'hookSpecificOutput.decision', 'hookSpecificOutput.content'].includes(pathName)
      && !isPlainObject(value)) {
    throw new Error(`Claude response field ${pathName} must be an object`);
  }
  if (pathName === 'hookSpecificOutput.watchPaths'
      && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
    throw new Error('Claude response field hookSpecificOutput.watchPaths must be a string array');
  }
}

function buildClaudeHookOutput(hook, references) {
  const output = {};
  const allowedOutputs = allowedClaudeOutputs(hook.eventName);
  for (const [path, binding] of Object.entries(hook.claudeResponse?.bindings || {})) {
    if (!allowedOutputs.has(path)) throw new Error(`Claude response field ${path} is not valid for ${hook.eventName}`);
    const value = resolveBinding(binding, references);
    if (value !== UNRESOLVED) {
      assertClaudeOutputValue(path, value);
      setPath(output, path, value);
    }
  }
  if (isPlainObject(output.hookSpecificOutput) && Object.keys(output.hookSpecificOutput).length > 0) {
    output.hookSpecificOutput.hookEventName = hook.eventName;
  }
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CLAUDE_OUTPUT_BYTES) {
    throw new Error('Claude Hook response is larger than 2 MB');
  }
  return output;
}

function outputMatchesType(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function normalizeScriptOutput(result, declarations = []) {
  const rawOutput = isPlainObject(result?.output) ? result.output : {};
  const output = {};
  for (const declaration of declarations) {
    if (!Object.prototype.hasOwnProperty.call(rawOutput, declaration.name)) continue;
    const value = rawOutput[declaration.name];
    if (!outputMatchesType(value, declaration.type)) {
      throw new Error(`Script output ${declaration.name} must be ${declaration.type}`);
    }
    output[declaration.name] = value;
  }
  return output;
}

function createExecutionRecord(database, hook, context, input, startedAtMs, toolUseId) {
  const executionId = crypto.randomUUID();
  database.prepare(`
    INSERT INTO hook_executions (
      id, hook_id, hook_version, user_id, tenant_id, workspace_id,
      session_id, event_name, tool_use_id, input_json, started_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    executionId,
    hook.id,
    hook.version || 0,
    context.userId || null,
    context.tenantId || null,
    context.workspaceId || null,
    input?.session_id || context.sessionId?.() || null,
    hook.eventName,
    input?.tool_use_id || toolUseId || null,
    serializeForAudit(input),
    startedAtMs,
  );
  return executionId;
}

function completeExecution(database, executionId, { status, startedAt, scriptOutput, actions, response, logs, error }) {
  database.prepare(`
    UPDATE hook_executions
    SET status = ?, script_output_json = ?, actions_json = ?, response_json = ?,
        logs_json = ?, error_message = ?, duration_ms = ?, completed_at_ms = ?,
        completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    status,
    scriptOutput == null ? null : serializeForAudit(scriptOutput),
    serializeForAudit(actions || {}),
    serializeForAudit(response || {}),
    serializeForAudit(logs || []),
    error ? String(error).slice(0, 8000) : null,
    Math.max(0, Date.now() - startedAt),
    Date.now(),
    executionId,
  );
}

function writeDataRecord(database, executionId, hook, context, event, recordType, data) {
  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO hook_data_records (
      id, execution_id, hook_id, user_id, tenant_id, workspace_id,
      session_id, record_type, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    executionId,
    hook.id,
    context.userId || null,
    context.tenantId || null,
    context.workspaceId || null,
    event?.session_id || context.sessionId?.() || null,
    recordType,
    serializeForAudit(data),
  );
  return { id, type: recordType };
}

function buildEnvironment(context, event) {
  return {
    userId: context.userId || null,
    username: context.username || null,
    tenantId: context.tenantId || null,
    workspaceId: context.workspaceId || null,
    sessionId: event?.session_id || context.sessionId?.() || null,
    sqlCheckRuleIds: Array.isArray(context.sqlCheckRuleIds) ? [...context.sqlCheckRuleIds] : [],
  };
}

function expandSkillArguments(content, argumentsText) {
  const args = String(argumentsText || '').trim();
  const hasPlaceholder = /\$(?:ARGUMENTS|\d+\b)/.test(content);
  let expanded = content.replace(/\$ARGUMENTS/g, args);
  const tokens = args ? args.split(/\s+/) : [];
  tokens.forEach((token, index) => {
    expanded = expanded.replace(new RegExp(`\\$${index + 1}\\b`, 'g'), token);
  });
  if (args && !hasPlaceholder) expanded = `${expanded.trim()}\n\n## User request\n\n${args}\n`;
  return `${expanded.trim()}\n`;
}

async function loadSkillContent(skillId, skillName, argumentsText) {
  const normalizedName = String(skillName || '').trim();
  if (!normalizedName) throw new Error('Skill name is required');
  if (!isBuiltinHookSkillId(skillId)) {
    throw new Error('Only built-in Hook Skills can be invoked');
  }
  const skill = await loadBuiltinHookSkill({ skillId, skillName: normalizedName });
  return expandSkillArguments(skill.content, argumentsText);
}

async function executePostActions({ hook, references, context, event, signal, recoveryKeys, writeRecord }) {
  for (const action of hook.postActions || []) {
    if (action.type === 'call_mcp_tool') {
      const condition = action.config?.condition == null
        ? true
        : resolveBinding(action.config.condition, references);
      if (condition === UNRESOLVED) {
        throw new Error(`Post action ${action.id} condition is unresolved`);
      }
      if (!condition) {
        references.actions[action.id] = {
          output: { called: false, reason: 'condition_false' },
        };
        continue;
      }
      const input = {};
      for (const [key, binding] of Object.entries(action.config?.inputs || {})) {
        const value = resolveBinding(binding, references);
        if (value === UNRESOLVED) throw new Error(`Post action ${action.id} input ${key} is unresolved`);
        input[key] = value;
      }
      if (hook.bindingController === 'sql_check' && !Object.hasOwn(input, 'rule_ids')) {
        input.rule_ids = Array.isArray(context.sqlCheckRuleIds) ? [...context.sqlCheckRuleIds] : [];
      }
      const output = await context.mcpCaller({
        qualifiedToolName: action.config.toolName,
        input,
        mcpServers: context.mcpServers,
        cwd: context.workspaceRoot,
        signal,
      });
      references.actions[action.id] = { output };
      continue;
    }
    if (action.type === 'write_record') {
      const condition = action.config?.condition == null
        ? true
        : resolveBinding(action.config.condition, references);
      if (condition === UNRESOLVED) {
        throw new Error(`Post action ${action.id} condition is unresolved`);
      }
      if (!condition) {
        references.actions[action.id] = {
          output: { recorded: false, reason: 'condition_false' },
        };
        continue;
      }
      const data = {};
      for (const [key, binding] of Object.entries(action.config?.fields || {})) {
        const value = resolveBinding(binding, references);
        if (value === UNRESOLVED) throw new Error(`Post action ${action.id} field ${key} is unresolved`);
        data[key] = value;
      }
      const record = await writeRecord(action.config.recordType, data);
      references.actions[action.id] = {
        output: { recorded: true, ...record },
      };
      continue;
    }
    if (action.type === 'invoke_skill') {
      const condition = action.config?.condition == null
        ? true
        : resolveBinding(action.config.condition, references);
      if (condition === UNRESOLVED) {
        throw new Error(`Post action ${action.id} condition is unresolved`);
      }
      if (!condition) {
        references.actions[action.id] = {
          output: { scheduled: false, reason: 'condition_false' },
        };
        continue;
      }
      const recoveryKey = `${hook.id}:${action.id}`;
      if (recoveryKeys.has(recoveryKey)) {
        references.actions[action.id] = { output: { scheduled: false, reason: 'already_scheduled' } };
        continue;
      }
      const argumentsText = renderTemplate(action.config.argumentsTemplate, references);
      if (argumentsText === UNRESOLVED) {
        throw new Error(`Post action ${action.id} arguments contain an unresolved variable`);
      }
      const modelContent = await context.skillContentLoader(
        action.config.skillId,
        action.config.skillName,
        argumentsText,
      );
      await context.enqueueSkillRecovery({
        hook,
        action,
        event,
        modelContent,
        displayCommand: `/${action.config.skillName}${argumentsText ? ` ${argumentsText}` : ''}`,
      });
      recoveryKeys.add(recoveryKey);
      references.actions[action.id] = {
        output: { scheduled: true, skillName: action.config.skillName },
      };
    }
  }
}

export function createHookRuntimeSession({
  hooks = [],
  userId,
  username,
  tenantId,
  workspaceId,
  sqlCheckRuleIds = [],
  workspaceRoot,
  sessionId = () => null,
  mcpServers = {},
  skillContentLoader = loadSkillContent,
  enqueueSkillRecovery = async () => {
    throw new Error('Skill recovery is not available in this runtime');
  },
  database = defaultDatabase,
  scriptExecutor = executeHookScript,
  mcpCaller = callHookMcpTool,
} = {}) {
  const recoveryKeys = new Set();
  const context = {
    userId,
    username,
    tenantId,
    workspaceId,
    sqlCheckRuleIds,
    workspaceRoot,
    sessionId,
    mcpServers,
    skillContentLoader,
    enqueueSkillRecovery,
    mcpCaller,
  };

  const executeHook = async (hook, event, toolUseId, callbackOptions = {}) => {
    if (!event || event.hook_event_name !== hook.eventName) return {};
    const startedAt = Date.now();
    const executionId = createExecutionRecord(database, hook, context, event, startedAt, toolUseId);
    const logs = [];
    let scriptOutput = {};
    const references = {
      event,
      ccui: { env: buildEnvironment(context, event) },
      script: { output: scriptOutput },
      actions: {},
    };
    try {
      if (hook.extensionLogic?.code?.trim()) {
        const scriptResult = await scriptExecutor({
          hookId: hook.id,
          language: hook.extensionLogic.language,
          code: hook.extensionLogic.code,
          event,
          env: references.ccui.env,
          workspaceRoot,
          signal: callbackOptions.signal,
          onRecord: async (recordType, data) => writeDataRecord(
            database,
            executionId,
            hook,
            context,
            event,
            recordType,
            data,
          ),
          onLog: async (message, data) => {
            const entry = { timestamp: new Date().toISOString(), message, data };
            if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
            console.info(`[Hook:${hook.id}] ${redactForAudit(message)}`, redactForAudit(data ?? ''));
            return entry;
          },
        });
        scriptOutput = normalizeScriptOutput(scriptResult, hook.extensionLogic.outputs);
        references.script.output = scriptOutput;
      }
      await executePostActions({
        hook,
        references,
        context,
        event,
        signal: callbackOptions.signal,
        recoveryKeys,
        writeRecord: async (recordType, data) => writeDataRecord(
          database,
          executionId,
          hook,
          context,
          event,
          recordType,
          data,
        ),
      });
      const response = hook.eventName === 'StopFailure' ? {} : buildClaudeHookOutput(hook, references);
      completeExecution(database, executionId, {
        status: 'succeeded',
        startedAt,
        scriptOutput,
        actions: references.actions,
        response,
        logs,
      });
      return response;
    } catch (error) {
      completeExecution(database, executionId, {
        status: 'failed',
        startedAt,
        scriptOutput,
        actions: references.actions,
        response: {},
        logs,
        error: error?.stack || error?.message || String(error),
      });
      console.error(`[Hook:${hook.id}] Runtime execution failed:`, error?.message || error);
      return {};
    }
  };

  const sdkHooks = {};
  for (const hook of hooks) {
    const rawMatcher = typeof hook.matcher?.value === 'string' ? hook.matcher.value.trim() : '';
    const matcher = rawMatcher === '*' ? '' : rawMatcher;
    const entry = {
      ...(matcher ? { matcher } : {}),
      hooks: [(event, toolUseId, options) => executeHook(hook, event, toolUseId, options)],
      timeout: 60,
    };
    if (!sdkHooks[hook.eventName]) sdkHooks[hook.eventName] = [];
    sdkHooks[hook.eventName].push(entry);
  }

  return { hooks: sdkHooks, executeHook };
}

export function mergeSdkHooks(...hookMaps) {
  const merged = {};
  for (const hookMap of hookMaps) {
    for (const [eventName, matchers] of Object.entries(hookMap || {})) {
      if (!Array.isArray(matchers) || matchers.length === 0) continue;
      merged[eventName] = [...(merged[eventName] || []), ...matchers];
    }
  }
  return merged;
}

export { buildClaudeHookOutput, normalizeScriptOutput, renderTemplate, resolveBinding };
