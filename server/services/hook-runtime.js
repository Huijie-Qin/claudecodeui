import crypto from 'node:crypto';

import { canIncludeSubagents } from '../../shared/hookSubagents.js';
import { db as defaultDatabase } from '../database/db.js';

import { isRequiredHook } from './claude-hook-policy.js';
import { isBuiltinHookSkillId, loadBuiltinHookSkill } from './hook-builtin-skills.js';
import { allowedClaudeOutputs, hookConfigService } from './hook-configs.js';
import { callHookMcpTool } from './hook-mcp-client.js';
import { executeHookScript } from './hook-script-executor.js';
import { subagentHookTimeoutSeconds } from './hook-subagent-mcp-loop.js';
import { createHookVariableRedactor, mergeHookUserVariableValues } from './hook-user-variables.js';

const UNRESOLVED = Symbol('unresolved');
const MAX_AUDIT_JSON_BYTES = 128 * 1024;
const MAX_CLAUDE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_ENTRIES = 200;
const MAX_COMPLETION_REVIEWS = 5;
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

function toAuditValue(value) {
  return JSON.parse(serializeForAudit(value));
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

function normalizeCompletionValidationResult(value) {
  if (value?.isError === true) {
    throw new Error('程序校验工具返回错误。');
  }
  if (!isPlainObject(value) || typeof value.passed !== 'boolean') {
    throw new Error('程序校验结果必须包含布尔值 passed。');
  }
  const rawIssues = value.issues ?? [];
  if (!Array.isArray(rawIssues) || rawIssues.length > 20
      || rawIssues.some((issue) => typeof issue !== 'string' || issue.length > 600)) {
    throw new Error('程序校验结果 issues 必须是最多 20 个短文本。');
  }
  const result = { passed: value.passed, issues: rawIssues.map((issue) => issue.trim()).filter(Boolean) };
  if (Object.prototype.hasOwnProperty.call(value, 'evidence')) {
    let serialized;
    try { serialized = JSON.stringify(value.evidence); } catch { /* Report a bounded validation error below. */ }
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 4_000) {
      throw new Error('程序校验结果 evidence 必须是 4 KB 以内的 JSON。');
    }
    result.evidence = JSON.parse(serialized);
  }
  return result;
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
  const confirmation = hook.eventName === 'PreToolUse'
    && hook.postActions?.find((action) => action.type === 'request_confirmation');
  if (confirmation) {
    const result = references.actions[confirmation.id]?.output;
    if (!result || typeof result.requested !== 'boolean') {
      throw new Error('Confirmation post action did not produce a decision');
    }
    if (result.requested && output.continue !== false
        && output.hookSpecificOutput?.permissionDecision !== 'deny') {
      output.hookSpecificOutput = {
        ...output.hookSpecificOutput,
        permissionDecision: 'ask',
        permissionDecisionReason: result.reason,
      };
    } else if (!output.hookSpecificOutput?.permissionDecision) {
      output.hookSpecificOutput = { ...output.hookSpecificOutput, permissionDecision: 'defer' };
    }
  }
  if (isPlainObject(output.hookSpecificOutput) && Object.keys(output.hookSpecificOutput).length > 0) {
    output.hookSpecificOutput.hookEventName = hook.eventName;
  }
  if (hook.eventName === 'PreToolUse' && isRequiredHook(hook)
      && !output.hookSpecificOutput?.permissionDecision) {
    throw new Error('Required PreToolUse Hook must return an explicit permissionDecision');
  }
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CLAUDE_OUTPUT_BYTES) {
    throw new Error('Claude Hook response is larger than 2 MB');
  }
  return output;
}

function resolveEffectiveHook(hook, event) {
  if (!event) return null;
  if (hook.eventName === 'Stop' && hook.includeSubagents === true
      && event.hook_event_name === 'SubagentStop' && event.agent_id) {
    return { ...hook, eventName: 'SubagentStop' };
  }
  if (event.hook_event_name !== hook.eventName) return null;
  if (event.agent_id && canIncludeSubagents(hook.eventName)) {
    if (hook.includeSubagents === false) return null;
    // An inherited Stop runs through its SubagentStop registration only.
    if (hook.eventName === 'Stop' && hook.includeSubagents === true) return null;
  }
  return hook;
}

function recoveryKeyFor(hook, action, event) {
  return JSON.stringify([hook.id, action.id, event?.agent_id || null]);
}

function isSubagentStop(event) {
  return event?.hook_event_name === 'SubagentStop' && Boolean(event.agent_id);
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

function createExecutionRecord(database, hook, context, input, startedAtMs, toolUseId, redact = (value) => value) {
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
    serializeForAudit(redact(input)),
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

function writeDataRecord(database, executionId, hook, context, event, recordType, data, provenance = {}) {
  const id = crypto.randomUUID();
  database.prepare(`
    INSERT INTO hook_data_records (
      id, execution_id, hook_id, user_id, tenant_id, workspace_id,
      session_id, record_type, data_json, post_action_id, hook_version, record_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    provenance.postActionId || null,
    Number.isInteger(hook.version) && hook.version > 0 ? hook.version : null,
    ['post_action', 'script', 'system'].includes(provenance.recordSource)
      ? provenance.recordSource : 'unknown',
  );
  return { id, type: recordType, data: toAuditValue(data) };
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

function requiredHookFailureResponse(hook, auditFailure = false) {
  if (hook?.eventName === 'PreToolUse' && isRequiredHook(hook)) {
    return { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: auditFailure
        ? '必需的工具调用前校验无法执行或保存记录，已拒绝本次调用。请修复 Hook 服务后重试。'
        : '必需的工具调用前校验失败，已拒绝本次调用。请查看 Hook 执行记录并修复后重试。',
    } };
  }
  return {};
}

function completionReviewFailureResponse(hook, reviewNumber, auditFailure = false) {
  if (hook?.eventName !== 'Stop') return null;
  const reviewAction = hook.postActions?.find((action) => action.type === 'review_completion');
  if (!reviewAction) return null;
  const maxReviews = Math.min(reviewAction.config?.maxReviews ?? 3, MAX_COMPLETION_REVIEWS);
  const reason = auditFailure
    ? '模型验收无法保存执行记录，请检查 Hook 存储后继续任务。'
    : '模型验收 Hook 执行失败，请检查 Hook 执行记录后继续任务。';
  return reviewNumber >= maxReviews
    ? { continue: false, stopReason: `${reason}已达到 ${maxReviews} 次复核上限。` }
    : { decision: 'block', reason };
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

async function executePostActions({
  hook,
  executionId,
  references,
  context,
  event,
  signal,
  recoveryKeys,
  subagentFeedback,
  subagentMcpResults,
  onLoopProgress,
  writeRecord,
  onLog,
}) {
  for (const action of hook.postActions || []) {
    if (action.type === 'request_confirmation') {
      if (hook.eventName !== 'PreToolUse') throw new Error('Confirmation requires PreToolUse');
      if (typeof event?.tool_name !== 'string' || !event.tool_name.trim()) {
        throw new Error('MCP confirmation requires a tool name');
      }
      if (!event.tool_name.startsWith('mcp__')) {
        references.actions[action.id] = { output: { requested: false, reason: 'not_mcp_tool' } };
        continue;
      }
      const condition = action.config?.condition == null
        ? true : resolveBinding(action.config.condition, references);
      if (typeof condition !== 'boolean') {
        throw new Error(`Post action ${action.id} condition must resolve to a boolean`);
      }
      if (!condition) {
        references.actions[action.id] = { output: { requested: false, reason: 'condition_false' } };
        continue;
      }
      if (!isPlainObject(event.tool_input)) throw new Error('MCP confirmation requires object tool_input');
      const reason = renderTemplate(action.config.messageTemplate, references);
      if (reason === UNRESOLVED || !reason.trim()) {
        throw new Error(`Post action ${action.id} confirmation message is empty or unresolved`);
      }
      await onLog('MCP 调用前参数确认', { toolName: event.tool_name, toolInput: event.tool_input });
      // This records a request, never an approval. The SDK permission callback
      // displays the effective arguments and waits for the user's decision.
      references.actions[action.id] = { output: {
        requested: true, reason, toolName: event.tool_name, toolInput: event.tool_input,
      } };
      continue;
    }
    if (action.type === 'call_mcp_tool') {
      const sqlWriteGuard = hook.bindingController === 'sql_check'
        && hook.eventName === 'PreToolUse' && event.tool_name === 'Write'
        && /(?:^|__)check_sql_syntax$/.test(action.config?.toolName || '');
      const condition = action.config?.condition == null
        ? true
        : resolveBinding(action.config.condition, references);
      if (condition === UNRESOLVED) {
        throw new Error(`Post action ${action.id} condition is unresolved`);
      }
      if (sqlWriteGuard && typeof condition !== 'boolean') {
        throw new Error('SQL Check condition must resolve to a boolean');
      }
      if (!condition) {
        references.actions[action.id] = {
          output: { called: false, reason: 'condition_false', ...(sqlWriteGuard ? {
            permissionDecision: 'defer', permissionDecisionReason: '本次 Write 未包含 SQL。',
          } : {}) },
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
        ...await context.resolveMcpAction({ hook, action }),
        input,
        cwd: context.workspaceRoot,
        signal,
        headersHelperRunner: context.headersHelperRunner,
      });
      if (sqlWriteGuard) {
        if (!isPlainObject(output) || output.isError === true || typeof output.valid !== 'boolean') {
          throw new Error('SQL Check did not return a valid boolean verdict');
        }
        const issues = Array.isArray(output.issues)
          ? output.issues.map((issue) => typeof issue === 'string' ? issue : issue?.message)
            .filter((message) => typeof message === 'string').slice(0, 5).join('；').slice(0, 1500)
          : '';
        references.actions[action.id] = { output: { ...output,
          // A successful check must not bypass other permission checks.
          permissionDecision: output.valid ? 'defer' : 'deny',
          permissionDecisionReason: output.valid ? 'SQL Check 校验通过。'
            : `SQL Check 校验未通过，已拒绝写入。${issues || '请修正 SQL 后重试。'}`,
        } };
      } else {
        references.actions[action.id] = { output };
      }
      continue;
    }
    if (action.type === 'mcp_loop_run') {
      const input = isPlainObject(event?.tool_input) ? event.tool_input : {};
      const schedulingResult = await context.enqueueMcpLoop({
        hook,
        action,
        event,
        executionId,
        input,
        signal,
        environment: references.ccui.env,
        onProgress: event?.agent_id ? onLoopProgress : undefined,
      });
      if (event?.agent_id && Object.prototype.hasOwnProperty.call(schedulingResult || {}, 'toolUseResult')) {
        subagentMcpResults.push(schedulingResult.toolUseResult);
      }
      references.actions[action.id] = {
        output: {
          scheduled: Boolean(schedulingResult?.scheduled),
          ...(isPlainObject(schedulingResult) ? schedulingResult : {}),
        },
      };
      continue;
    }
    if (action.type === 'review_completion') {
      if (hook.eventName !== 'Stop' || event?.agent_id) {
        throw new Error('Completion review only supports the main agent Stop event');
      }
      const reviewNumber = references.ccui.env.hookInvocationCount;
      const maxReviews = Math.min(action.config?.maxReviews ?? 3, MAX_COMPLETION_REVIEWS);
      let validationResult;
      let validationError = '';
      if (action.config?.validationResultPath) {
        const rawValidation = readPath(references, action.config.validationResultPath);
        try {
          if (rawValidation === UNRESOLVED) {
            throw new Error('配置的程序校验结果不存在。');
          }
          validationResult = normalizeCompletionValidationResult(rawValidation);
        } catch (error) {
          validationError = error?.message || '程序校验结果无效。';
        }
      }
      let verdict;
      if (validationError) {
        verdict = {
          complete: false,
          reason: `程序校验未能执行：${validationError}`,
          nextStep: '检查 Hook 的程序校验脚本或 MCP 输出后继续任务。',
          failed: true,
        };
      } else {
        try {
          verdict = await context.reviewCompletion({
            event,
            workspaceRoot: context.workspaceRoot,
            model: action.config?.model || undefined,
            criteria: action.config?.criteria || '',
            artifactPaths: action.config?.artifactPaths || [],
            validationResult,
            signal,
          });
          if (!isPlainObject(verdict) || typeof verdict.complete !== 'boolean'
              || typeof verdict.reason !== 'string' || !verdict.reason.trim()
              || typeof verdict.nextStep !== 'string') {
            throw new Error('Completion reviewer returned an invalid verdict');
          }
        } catch (error) {
          const failure = error?.code === 'COMPLETION_REVIEW_TIMEOUT'
            ? '审查模型超时'
            : error?.name === 'AbortError'
              ? '审查已中止'
              : '审查模型调用失败或返回无效结果';
          verdict = {
            complete: false,
            reason: `模型验收未能执行：${failure}。`,
            nextStep: '检查审查模型和 Hook 配置后继续任务。',
            failed: true,
          };
        }
      }
      if (validationResult && !validationResult.passed) {
        const issues = validationResult.issues.length > 0
          ? validationResult.issues : ['程序校验未通过。'];
        verdict = {
          ...verdict,
          complete: false,
          reason: [`程序校验未通过：${issues.join('；')}`, verdict.complete ? '' : verdict.reason]
            .filter(Boolean).join('\n'),
          nextStep: [verdict.nextStep, '修复上述程序校验问题并重新生成交付物。']
            .filter(Boolean).join('\n'),
        };
      }
      references.actions[action.id] = { output: {
        complete: verdict.complete,
        reason: verdict.reason.trim().slice(0, 2000),
        nextStep: verdict.nextStep.trim().slice(0, 2000),
        reviewNumber,
        maxReviews,
        failed: verdict.failed === true,
        ...(action.config?.validationResultPath ? {
          validationResult: validationResult || null,
          ...(validationError ? { validationError } : {}),
        } : {}),
      } };
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
      const record = await writeRecord(action.config.recordType, data, {
        recordSource: 'post_action', postActionId: action.id,
      });
      references.actions[action.id] = {
        output: { recorded: true, ...record },
      };
      continue;
    }
    if (action.type === 'send_agent_message') {
      if (context.suppressSkillRecovery) {
        references.actions[action.id] = {
          output: { scheduled: false, reason: 'hook_recovery_turn' },
        };
        continue;
      }
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
      const recoveryKey = recoveryKeyFor(hook, action, event);
      if (isSubagentStop(event) && event.stop_hook_active) {
        references.actions[action.id] = { output: { scheduled: false, reason: 'subagent_recovery_turn' } };
        continue;
      }
      if (recoveryKeys.has(recoveryKey)) {
        references.actions[action.id] = { output: { scheduled: false, reason: 'already_scheduled' } };
        continue;
      }
      const messageText = renderTemplate(action.config.messageTemplate, references);
      if (messageText === UNRESOLVED) {
        throw new Error(`Post action ${action.id} message contains an unresolved variable`);
      }
      if (!messageText.trim()) {
        throw new Error(`Post action ${action.id} message is empty`);
      }
      const schedulingResult = isSubagentStop(event)
        ? { deliveredTo: 'subagent', agentId: event.agent_id }
        : await context.enqueueAgentMessage({
        hook,
        action,
        event,
        executionId,
        messageText,
        displayMessage: context.redact(messageText),
      });
      if (isSubagentStop(event)) subagentFeedback.push(messageText);
      recoveryKeys.add(recoveryKey);
      references.actions[action.id] = {
        output: {
          scheduled: true,
          messageLength: messageText.length,
          ...(isPlainObject(schedulingResult) ? schedulingResult : {}),
        },
      };
      continue;
    }
    if (action.type === 'invoke_skill') {
      if (context.suppressSkillRecovery) {
        references.actions[action.id] = {
          output: { scheduled: false, reason: 'hook_recovery_turn' },
        };
        continue;
      }
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
      const recoveryKey = recoveryKeyFor(hook, action, event);
      if (isSubagentStop(event) && event.stop_hook_active) {
        references.actions[action.id] = { output: { scheduled: false, reason: 'subagent_recovery_turn' } };
        continue;
      }
      if (recoveryKeys.has(recoveryKey)) {
        references.actions[action.id] = { output: { scheduled: false, reason: 'already_scheduled' } };
        continue;
      }
      const argumentsText = renderTemplate(action.config.argumentsTemplate, references);
      if (argumentsText === UNRESOLVED) {
        throw new Error(`Post action ${action.id} arguments contain an unresolved variable`);
      }
      let schedulingResult;
      const childRecovery = isSubagentStop(event);
      // Reserve before asynchronous content loading so duplicate callbacks for
      // the same child cannot both deliver the same recovery Skill.
      if (childRecovery) recoveryKeys.add(recoveryKey);
      try {
        const modelContent = await context.skillContentLoader(
          action.config.skillId,
          action.config.skillName,
          argumentsText,
        );
        const recoveryRequest = {
          hook,
          action,
          event,
          executionId,
          argumentsText,
          modelContent,
          displayCommand: context.redact(`/${action.config.skillName}${argumentsText ? ` ${argumentsText}` : ''}`),
        };
        if (childRecovery) {
          const content = await context.prepareSubagentSkillRecovery(recoveryRequest);
          if (typeof content !== 'string' || !content.trim()) {
            throw new Error('Subagent Skill recovery must provide nonempty content');
          }
          subagentFeedback.push(content);
          schedulingResult = { deliveredTo: 'subagent', agentId: event.agent_id };
        } else {
          schedulingResult = await context.enqueueSkillRecovery(recoveryRequest);
        }
      } catch (error) {
        if (childRecovery) recoveryKeys.delete(recoveryKey);
        throw error;
      }
      recoveryKeys.add(recoveryKey);
      references.actions[action.id] = {
        output: {
          scheduled: true,
          skillName: action.config.skillName,
          ...(isPlainObject(schedulingResult) ? schedulingResult : {}),
        },
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
  resolveUserVariables = ({ hook }) => workspaceId
    ? hookConfigService.getWorkspaceHookUserVariables({ workspaceId, tenantId, userId, hook })
    : {},
  sqlCheckRuleIds = [],
  workspaceRoot,
  sessionId = () => null,
  mcpServers = {},
  resolveMcpAction = async ({ action }) => ({
    qualifiedToolName: action.config.toolName,
    mcpServers,
  }),
  headersHelperRunner = null,
  suppressSkillRecovery = false,
  skillContentLoader = loadSkillContent,
  enqueueSkillRecovery = async () => {
    throw new Error('Skill recovery is not available in this runtime');
  },
  prepareSubagentSkillRecovery = async () => {
    throw new Error('Subagent Skill recovery is not available in this runtime');
  },
  enqueueAgentMessage = async () => {
    throw new Error('Agent messaging is not available in this runtime');
  },
  enqueueMcpLoop = async () => {
    throw new Error('MCP loop scheduling is not available in this runtime');
  },
  reviewCompletion = async () => {
    throw new Error('Completion reviewer is not available in this runtime');
  },
  onSubagentLoopWait = () => {},
  onExecutionActivity = () => {},
  database = defaultDatabase,
  scriptExecutor = executeHookScript,
  mcpCaller = callHookMcpTool,
} = {}) {
  const recoveryKeys = new Set();
  // Each SDK query owns this runtime. Keep counts out of the persistent audit
  // history so resuming the same conversation starts a fresh checking cycle.
  const invocationCounts = new Map();
  const context = {
    userId,
    username,
    tenantId,
    workspaceId,
    sqlCheckRuleIds,
    workspaceRoot,
    sessionId,
    mcpServers,
    resolveMcpAction,
    headersHelperRunner,
    suppressSkillRecovery,
    skillContentLoader,
    enqueueSkillRecovery,
    prepareSubagentSkillRecovery,
    enqueueAgentMessage,
    enqueueMcpLoop,
    reviewCompletion,
    onExecutionActivity,
    mcpCaller,
    scriptExecutor,
  };

  const reportExecutionActivity = (activity) => {
    try {
      const result = context.onExecutionActivity(activity);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`[Hook:${activity.hook.id}] Failed to report execution activity:`, error?.message || error);
        });
      }
    } catch (error) {
      console.warn(`[Hook:${activity.hook.id}] Failed to report execution activity:`, error?.message || error);
    }
  };

  const executeHookWithAudit = async (configuredHook, event, toolUseId, callbackOptions = {}) => {
    const hook = resolveEffectiveHook(configuredHook, event);
    if (!hook) return {};
    const environment = buildEnvironment(context, event);
    const invocationScope = JSON.stringify([
      hook.id, hook.eventName, environment.sessionId, event.agent_id || null,
    ]);
    let invocations = invocationCounts.get(invocationScope);
    if (!invocations) {
      invocations = { count: 0, toolUses: new Map() };
      invocationCounts.set(invocationScope, invocations);
    }
    const invocationToolId = event.tool_use_id || toolUseId || null;
    // Reserve synchronously before resolving variables or running scripts so
    // overlapping callbacks get distinct counts, and retries retain theirs.
    if (invocationToolId && invocations.toolUses.has(invocationToolId)) {
      environment.hookInvocationCount = invocations.toolUses.get(invocationToolId);
    } else {
      environment.hookInvocationCount = ++invocations.count;
      if (invocationToolId) invocations.toolUses.set(invocationToolId, invocations.count);
    }
    const startedAt = Date.now();
    const definitions = hook.userVariables || [];
    let userVariables = {};
    let variableError = null;
    try {
      if (definitions.length) userVariables = await resolveUserVariables({ hook });
    } catch {
      variableError = new Error('无法读取 Hook 个人变量，请在辅助功能中重新配置');
    }
    const redact = createHookVariableRedactor(definitions, userVariables);
    const executionId = createExecutionRecord(database, hook, context, event, startedAt, toolUseId, redact);
    reportExecutionActivity({
      hook,
      event: redact(event),
      executionId,
      status: 'running',
      startedAt,
    });
    const logs = [];
    const onLog = async (message, data) => {
      const entry = { timestamp: new Date().toISOString(), message: redact(message), data: redact(data) };
      if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
      console.info(`[Hook:${hook.id}] ${redactForAudit(entry.message)}`, redactForAudit(entry.data ?? ''));
      return entry;
    };
    const subagentFeedback = [];
    const subagentMcpResults = [];
    let loop;
    const onLoopProgress = (job) => {
      loop = {
        jobId: job.id,
        status: job.status,
        attemptCount: job.attemptCount,
        startedAtMs: job.startedAtMs,
        nextPollAtMs: job.nextPollAtMs,
        targetTool: job.toolName,
        toolUseId: job.toolUseId,
      };
      reportExecutionActivity({
        hook, event: redact(event), executionId, startedAt,
        status: 'running', loop,
      });
    };
    let scriptOutput = {};
    const references = {
      event,
      ccui: { env: environment },
      script: { output: scriptOutput },
      actions: {},
    };
    try {
      if (variableError) throw variableError;
      userVariables = mergeHookUserVariableValues(definitions, userVariables, undefined, { requireComplete: true });
      if (definitions.length) references.ccui.env.userVariables = Object.fromEntries(
        definitions.map((variable) => [variable.name, userVariables[variable.name] || '']),
      );
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
            redact(data),
            { recordSource: 'script' },
          ),
          onLog,
        });
        scriptOutput = normalizeScriptOutput(scriptResult, hook.extensionLogic.outputs);
        references.script.output = scriptOutput;
      }
      await executePostActions({
        hook,
        executionId,
        references,
        context: { ...context, redact },
        event,
        signal: callbackOptions.signal,
        recoveryKeys,
        subagentFeedback,
        subagentMcpResults,
        onLoopProgress,
        onLog,
        writeRecord: async (recordType, data, provenance) => writeDataRecord(
          database,
          executionId,
          hook,
          context,
          event,
          recordType,
          redact(data),
          provenance,
        ),
      });
      const response = hook.eventName === 'StopFailure' ? {} : buildClaudeHookOutput(hook, references);
      const completionReview = hook.postActions?.find((action) => action.type === 'review_completion');
      const reviewOutput = completionReview && references.actions[completionReview.id]?.output;
      if (reviewOutput) {
        if (reviewOutput.complete) {
          if (response.decision !== 'block' && response.continue !== false) {
            response.decision = 'approve';
            response.reason = reviewOutput.reason;
          }
        } else if (reviewOutput.reviewNumber >= reviewOutput.maxReviews) {
          response.continue = false;
          response.stopReason = `模型验收已进行 ${reviewOutput.maxReviews} 次，任务仍未通过：${reviewOutput.reason}`;
          delete response.decision;
          delete response.reason;
        } else if (response.continue !== false) {
          response.decision = 'block';
          response.reason = [response.reason, reviewOutput.reason, reviewOutput.nextStep]
            .filter(Boolean).join('\n').slice(0, 4000);
        }
      }
      if (subagentMcpResults.length > 0) {
        response.hookSpecificOutput = {
          ...response.hookSpecificOutput,
          hookEventName: 'PostToolUse',
          // The CLI puts this value directly into tool_result.content. Keep
          // business data in audit actions, but send valid MCP content blocks.
          updatedMCPToolOutput: [{
            type: 'text',
            text: JSON.stringify(subagentMcpResults.at(-1)) ?? 'null',
          }],
        };
      }
      if (subagentFeedback.length > 0 && response.continue !== false) {
        response.decision = 'block';
        response.reason = [response.reason, ...subagentFeedback].filter(Boolean).join('\n\n');
      }
      if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_CLAUDE_OUTPUT_BYTES) {
        throw new Error('Claude Hook response is larger than 2 MB');
      }
      completeExecution(database, executionId, {
        status: reviewOutput?.failed ? 'failed' : 'succeeded',
        startedAt,
        scriptOutput: redact(scriptOutput),
        actions: redact(references.actions),
        response: redact(response),
        logs,
      });
      reportExecutionActivity({
        hook,
        event: redact(event),
        executionId,
        status: reviewOutput?.failed ? 'failed' : 'succeeded',
        startedAt,
        completedAt: Date.now(),
        actions: toAuditValue(redact(references.actions)),
        ...(loop ? { loop } : {}),
      });
      return response;
    } catch (error) {
      const response = completionReviewFailureResponse(hook, environment.hookInvocationCount)
        || requiredHookFailureResponse(hook);
      completeExecution(database, executionId, {
        status: 'failed',
        startedAt,
        scriptOutput: redact(scriptOutput),
        actions: redact(references.actions),
        response,
        logs,
        error: redact(error?.stack || error?.message || String(error)),
      });
      reportExecutionActivity({
        hook,
        event: redact(event),
        executionId,
        status: 'failed',
        startedAt,
        completedAt: Date.now(),
        actions: toAuditValue(redact(references.actions)),
        ...(loop ? { loop } : {}),
        error: redact(error?.message || String(error)),
      });
      console.error(`[Hook:${hook.id}] Runtime execution failed:`, redact(error?.message || String(error)));
      return response;
    }
  };

  const executeHook = async (hook, event, toolUseId, callbackOptions = {}) => {
    const effectiveHook = resolveEffectiveHook(hook, event);
    const waitId = effectiveHook && event.agent_id
      && effectiveHook.postActions?.some((action) => action.type === 'mcp_loop_run')
      ? `subagent-hook-${crypto.randomUUID()}` : null;
    if (waitId) onSubagentLoopWait({ id: waitId, waiting: true });
    try {
      return await executeHookWithAudit(hook, event, toolUseId, callbackOptions);
    } catch (error) {
      if (effectiveHook?.eventName === 'Stop') {
        const environment = buildEnvironment(context, event);
        const invocationScope = JSON.stringify([
          effectiveHook.id, effectiveHook.eventName, environment.sessionId, event?.agent_id || null,
        ]);
        const reviewNumber = invocationCounts.get(invocationScope)?.count || 1;
        const response = completionReviewFailureResponse(effectiveHook, reviewNumber, true);
        if (response) return response;
      }
      if (!isRequiredHook(effectiveHook)) throw error;
      // An audit/database failure must not turn a required check into a rejected
      // SDK callback, which the SDK can otherwise ignore as a Hook error.
      console.error(`[Hook:${hook.id}] Required ${effectiveHook.eventName} check could not persist its execution.`);
      return requiredHookFailureResponse(effectiveHook, true);
    } finally {
      if (waitId) onSubagentLoopWait({ id: waitId, waiting: false });
    }
  };

  const sdkHooks = {};
  for (const hook of hooks) {
    const rawMatcher = typeof hook.matcher?.value === 'string' ? hook.matcher.value.trim() : '';
    const matcher = rawMatcher === '*' ? '' : rawMatcher;
    const entry = {
      ...(matcher ? { matcher } : {}),
      hooks: [(event, toolUseId, options) => executeHook(hook, event, toolUseId, options)],
      timeout: subagentHookTimeoutSeconds(hook),
    };
    if (!sdkHooks[hook.eventName]) sdkHooks[hook.eventName] = [];
    sdkHooks[hook.eventName].push(entry);
    if (hook.eventName === 'Stop' && hook.includeSubagents === true) {
      if (!sdkHooks.SubagentStop) sdkHooks.SubagentStop = [];
      // Stop has no matcher; a SubagentStop matcher would filter agent types.
      sdkHooks.SubagentStop.push({ hooks: entry.hooks, timeout: entry.timeout });
    }
  }

  return { hooks: sdkHooks, executeHook, hasRequiredHook: hooks.some(isRequiredHook) };
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
