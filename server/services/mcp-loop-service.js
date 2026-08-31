import crypto from 'node:crypto';
import path from 'node:path';

import { db } from '../database/db.js';
import { MCP_LOOP_JOB_SCHEMA_SQL } from '../database/hook-config-schema.js';

import { callHookMcpTool, normalizeToolOutput } from './hook-mcp-client.js';
import { hookMcpCatalogService } from './hook-mcp-catalog.js';
import { executeHookScript } from './hook-script-executor.js';

const DEFAULT_SCHEDULER_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const MAX_ATTEMPT_LOG_BYTES = 64 * 1024;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);
const SENSITIVE_LOG_KEY_PATTERN = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|user[_-]?key|auth[_-]?(?:key|token))/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeJson(value) {
  if (value === undefined) return null;
  return JSON.stringify(value);
}

function redactAttemptLogValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > 20) return '[depth limit]';
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
      .replace(/\b[0-9a-f]{64}\b/gi, '[redacted]');
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactAttemptLogValue(entry, depth + 1, seen));
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_LOG_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactAttemptLogValue(entry, depth + 1, seen),
  ]));
}

function formatAttemptLogValue(value) {
  const redacted = redactAttemptLogValue(value);
  let json;
  try {
    json = JSON.stringify(redacted);
  } catch {
    return { error: 'MCP result is not JSON serializable' };
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_ATTEMPT_LOG_BYTES) return redacted;
  return {
    truncated: true,
    preview: json.slice(0, MAX_ATTEMPT_LOG_BYTES),
  };
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    hookId: row.hook_id,
    hookExecutionId: row.hook_execution_id,
    actionId: row.action_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sessionId: row.session_id,
    toolUseId: row.tool_use_id,
    workspaceRoot: row.workspace_root,
    mcpServerId: row.mcp_server_id,
    toolName: row.tool_name,
    inputs: parseJson(row.inputs_json, {}),
    terminationScript: row.termination_script || '',
    successWhen: parseJson(row.success_when_json, null),
    failureWhen: parseJson(row.failure_when_json, null),
    waitingLabel: row.waiting_label || '',
    pollIntervalMs: row.poll_interval_ms,
    perCallTimeoutMs: row.per_call_timeout_ms,
    maxWaitMs: row.max_wait_ms,
    status: row.status,
    attemptCount: row.attempt_count,
    consecutiveErrorCount: row.consecutive_error_count,
    initialResult: parseJson(row.initial_result_json, null),
    lastResult: parseJson(row.last_result_json, null),
    error: row.error_message || null,
    nextPollAtMs: row.next_poll_at_ms,
    startedAtMs: row.started_at_ms,
    completedAtMs: row.completed_at_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeMcpLoopResult(value) {
  if (value?.isError) {
    return normalizeToolOutput(value);
  }
  if (value?.structuredContent !== undefined) return value.structuredContent;
  const content = Array.isArray(value?.content) ? value.content : null;
  if (content?.length === 1 && typeof content[0]?.text === 'string') {
    try {
      return JSON.parse(content[0].text);
    } catch {
      return content[0].text;
    }
  }
  return value;
}

export function readMcpLoopField(value, field) {
  const segments = String(field || '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;

  let current = value;
  for (const segment of segments) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function conditionMatches(result, condition) {
  if (!isPlainObject(condition) || typeof condition.field !== 'string') return false;
  return readMcpLoopField(result, condition.field) === condition.equals;
}

export function evaluateMcpLoopResult(result, { successWhen, failureWhen } = {}) {
  if (conditionMatches(result, successWhen)) return 'succeeded';
  if (conditionMatches(result, failureWhen)) return 'failed';
  return 'running';
}

function normalizeTerminationScriptOutcome(value) {
  const output = isPlainObject(value?.output) ? value.output : value;
  const status = typeof output === 'string' ? output : output?.status;
  if (status === 'running' || status === 'continue') return 'running';
  if (status === 'success' || status === 'succeeded') return 'succeeded';
  if (status === 'failure' || status === 'failed') return 'failed';
  throw new Error('MCP loop termination script must return output.status as running, success, or failed');
}

export function buildMcpLoopReplacement(job, completedAtMs = Date.now()) {
  const payload = {
    mcpLoop: true,
    replacesToolUseId: job.toolUseId,
    status: job.status,
    attempts: job.attemptCount,
    elapsedMs: Math.max(0, (job.completedAtMs || completedAtMs) - job.startedAtMs),
    result: job.lastResult,
    ...(job.error ? { error: job.error } : {}),
  };
  const matchedTerminalCondition = job.status === 'succeeded'
    || (job.status === 'failed' && !job.error);
  const toolUseResult = matchedTerminalCondition && job.lastResult != null
    ? job.lastResult
    : payload;
  return {
    payload,
    toolId: job.toolUseId,
    content: JSON.stringify(toolUseResult),
    toolUseResult,
    isError: false,
  };
}

async function resolveDefaultTarget(job, runtimeContext = null) {
  const resource = hookMcpCatalogService.listToolResources().find((tool) => (
    tool.mcpServerId === job.mcpServerId
    && (tool.name === job.toolName || tool.toolName === job.toolName)
  ));
  if (!resource) {
    throw new Error(`MCP loop target ${job.toolName} is unavailable`);
  }

  const mcpRoot = path.join(job.workspaceRoot, '.cloudcli', 'hook-config', 'mcp');
  const runtimeMode = runtimeContext?.mode === 'docker' ? 'docker' : 'local';
  const runtime = await hookMcpCatalogService.getRuntimeConfig({
    serverIds: [job.mcpServerId],
    hostDirectory: mcpRoot,
    commandDirectory: runtimeMode === 'docker'
      ? (runtimeContext.commandMcpRoot || '/workspace/.cloudcli/hook-config/mcp')
      : mcpRoot,
    runtimeMode,
    runtimeOwner: runtimeContext?.runtimeOwner || null,
    includePrivateHelperEnv: true,
  });
  return {
    qualifiedToolName: `mcp__${resource.runtimeAlias}__${resource.toolName}`,
    mcpServers: runtime.mcpServers,
    cwd: job.workspaceRoot,
  };
}

async function callDefaultTarget(job, runtimeContext = null) {
  const target = await resolveDefaultTarget(job, runtimeContext);
  return callHookMcpTool({
    ...target,
    input: job.inputs,
    timeoutMs: job.perCallTimeoutMs,
    headersHelperRunner: runtimeContext?.headersHelperRunner || null,
  });
}

function resolveDefaultTargetIdentity({ hook }) {
  const resource = hookMcpCatalogService.listToolResources().find((tool) => (
    tool.name === hook?.matcher?.value
  ));
  if (!resource) {
    throw new Error(`MCP loop Matcher ${hook?.matcher?.value || '(empty)'} is unavailable`);
  }
  return {
    mcpServerId: resource.mcpServerId,
    toolName: resource.name,
  };
}

export function createMcpLoopService({
  database = db,
  callTarget = callDefaultTarget,
  resolveTargetIdentity = resolveDefaultTargetIdentity,
  now = () => Date.now(),
  createId = () => crypto.randomUUID(),
  schedulerIntervalMs = DEFAULT_SCHEDULER_INTERVAL_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
  scriptExecutor = executeHookScript,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  database.exec(MCP_LOOP_JOB_SCHEMA_SQL);
  const jobColumns = new Set(database.prepare('PRAGMA table_info(mcp_loop_jobs)').all()
    .map((column) => column.name));
  if (!jobColumns.has('termination_script')) {
    database.exec("ALTER TABLE mcp_loop_jobs ADD COLUMN termination_script TEXT NOT NULL DEFAULT ''");
  }
  let timer = null;
  let runningCount = 0;
  const runtimeContexts = new Map();
  let handlers = {
    onStarted: async () => {},
    onProgress: async () => {},
    onTerminal: async () => {},
  };

  const selectById = database.prepare('SELECT * FROM mcp_loop_jobs WHERE id = ?');
  const insertJob = database.prepare(`
    INSERT INTO mcp_loop_jobs (
      id, hook_id, hook_execution_id, action_id,
      tenant_id, workspace_id, user_id, session_id, tool_use_id,
      workspace_root, mcp_server_id, tool_name, inputs_json,
      termination_script, success_when_json, failure_when_json, waiting_label,
      poll_interval_ms, per_call_timeout_ms, max_wait_ms,
      status, attempt_count, consecutive_error_count,
      initial_result_json, last_result_json, error_message,
      next_poll_at_ms, started_at_ms, completed_at_ms, updated_at
    ) VALUES (
      @id, @hookId, @hookExecutionId, @actionId,
      @tenantId, @workspaceId, @userId, @sessionId, @toolUseId,
      @workspaceRoot, @mcpServerId, @toolName, @inputsJson,
      @terminationScript, @successWhenJson, @failureWhenJson, @waitingLabel,
      @pollIntervalMs, @perCallTimeoutMs, @maxWaitMs,
      'queued', 0, 0,
      @initialResultJson, @initialResultJson, NULL,
      @nextPollAtMs, @startedAtMs, NULL, CURRENT_TIMESTAMP
    )
    ON CONFLICT(hook_execution_id, action_id) DO NOTHING
  `);
  const selectDue = database.prepare(`
    SELECT * FROM mcp_loop_jobs
    WHERE status = 'queued' AND next_poll_at_ms <= ?
    ORDER BY next_poll_at_ms ASC
    LIMIT ?
  `);
  const claimJob = database.prepare(`
    UPDATE mcp_loop_jobs
    SET status = 'running', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'queued'
  `);
  const requeueJob = database.prepare(`
    UPDATE mcp_loop_jobs
    SET status = 'queued',
        attempt_count = @attemptCount,
        consecutive_error_count = @consecutiveErrorCount,
        last_result_json = @lastResultJson,
        error_message = @errorMessage,
        next_poll_at_ms = @nextPollAtMs,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND status = 'running'
  `);
  const finishJob = database.prepare(`
    UPDATE mcp_loop_jobs
    SET status = @status,
        attempt_count = @attemptCount,
        consecutive_error_count = @consecutiveErrorCount,
        last_result_json = @lastResultJson,
        error_message = @errorMessage,
        completed_at_ms = @completedAtMs,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id AND status = 'running'
  `);
  const cancelJob = database.prepare(`
    UPDATE mcp_loop_jobs
    SET status = 'cancelled', completed_at_ms = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')
  `);
  let upsertAttempt = null;

  function getUpsertAttempt() {
    if (!upsertAttempt) {
      // The loop singleton is constructed while the database module is still
      // initializing. Prepare this cross-Hook audit statement only when the
      // first real Hook execution reaches the loop service.
      upsertAttempt = database.prepare(`
        INSERT INTO mcp_loop_attempts (
          hook_execution_id, action_id, job_id, attempt_count,
          script_status, termination_outcome, failure_stage,
          script_input_json, script_output_json, error_message,
          started_at_ms, completed_at_ms, duration_ms
        ) VALUES (
          @hookExecutionId, @actionId, @jobId, @attemptCount,
          @scriptStatus, @terminationOutcome, @failureStage,
          @scriptInputJson, @scriptOutputJson, @errorMessage,
          @startedAtMs, @completedAtMs, @durationMs
        )
        ON CONFLICT(hook_execution_id, action_id, attempt_count) DO UPDATE SET
          job_id = excluded.job_id,
          script_status = excluded.script_status,
          termination_outcome = excluded.termination_outcome,
          failure_stage = excluded.failure_stage,
          script_input_json = excluded.script_input_json,
          script_output_json = excluded.script_output_json,
          error_message = excluded.error_message,
          started_at_ms = excluded.started_at_ms,
          completed_at_ms = excluded.completed_at_ms,
          duration_ms = excluded.duration_ms
      `);
    }
    return upsertAttempt;
  }

  function getJob(jobId) {
    return mapJob(selectById.get(String(jobId)));
  }

  async function notify(handlerName, job) {
    try {
      await handlers[handlerName]?.(job);
    } catch (error) {
      logger.error?.(`[McpLoop] ${handlerName} failed for ${job.id}:`, error?.message || error);
    }
  }

  async function transitionTerminal(job, status, {
    result = job.lastResult,
    error = null,
    attemptCount = job.attemptCount,
    consecutiveErrorCount = job.consecutiveErrorCount,
  } = {}) {
    const completedAtMs = now();
    const update = finishJob.run({
      id: job.id,
      status,
      attemptCount,
      consecutiveErrorCount,
      lastResultJson: serializeJson(result),
      errorMessage: error ? String(error).slice(0, 8_000) : null,
      completedAtMs,
    });
    const terminalJob = getJob(job.id);
    if (update.changes !== 1) return terminalJob;
    await notify('onTerminal', terminalJob);
    runtimeContexts.delete(job.id);
    return terminalJob;
  }

  function buildTerminationScriptInput(job, result, attemptCount) {
    return {
      result,
      initial_result: job.initialResult,
      inputs: job.inputs,
      attempt_count: attemptCount,
      elapsed_ms: Math.max(0, now() - job.startedAtMs),
    };
  }

  function saveAttempt({
    job,
    jobId = job.id || null,
    attemptCount,
    scriptStatus,
    terminationOutcome = null,
    failureStage = null,
    scriptInput = null,
    scriptOutput = null,
    error = null,
    startedAtMs,
    completedAtMs,
  }) {
    getUpsertAttempt().run({
      hookExecutionId: job.hookExecutionId,
      actionId: job.actionId,
      jobId,
      attemptCount,
      scriptStatus,
      terminationOutcome,
      failureStage,
      scriptInputJson: scriptInput == null ? null : serializeJson(scriptInput),
      scriptOutputJson: scriptOutput == null ? null : serializeJson(scriptOutput),
      errorMessage: error ? String(error).slice(0, 8_000) : null,
      startedAtMs,
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
    });
  }

  function trySaveAttempt(details) {
    try {
      saveAttempt(details);
    } catch (error) {
      logger.error?.(
        `[McpLoop:${details.jobId || details.job?.id || 'initial'}] failed to persist attempt ${details.attemptCount}:`,
        error?.message || error,
      );
    }
  }

  async function evaluateTermination(job, scriptInput) {
    if (!job.terminationScript.trim()) {
      // Active jobs created by the equality-based first release remain
      // resumable after an upgrade.
      const outcome = evaluateMcpLoopResult(scriptInput.result, job);
      return {
        outcome,
        scriptOutput: {
          output: { status: outcome === 'succeeded' ? 'success' : outcome },
          legacyEqualityCondition: true,
        },
      };
    }
    const scriptResult = await scriptExecutor({
      hookId: job.hookId,
      language: 'python',
      code: job.terminationScript,
      event: scriptInput,
      env: {
        userId: job.userId,
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        sessionId: job.sessionId,
      },
      workspaceRoot: job.workspaceRoot,
      onLog: async (message, data) => {
        logger.info?.(`[McpLoop:${job.id}] ${message}`, data ?? '');
        return { message, data };
      },
    });
    return {
      outcome: normalizeTerminationScriptOutcome(scriptResult),
      scriptOutput: scriptResult,
    };
  }

  async function runClaimedJob(job) {
    const currentTime = now();
    if (currentTime - job.startedAtMs >= job.maxWaitMs) {
      return transitionTerminal(job, 'timed_out', {
        error: `MCP loop timed out after ${job.maxWaitMs} ms`,
      });
    }

    const attemptCount = job.attemptCount + 1;
    const attemptStartedAtMs = now();
    let attemptResult;
    let hasAttemptResult = false;
    let attemptStage = 'mcp_call';
    let scriptInput = null;
    let scriptOutput = null;
    try {
      attemptResult = normalizeMcpLoopResult(await callTarget(job, runtimeContexts.get(job.id) || null));
      hasAttemptResult = true;
      attemptStage = 'termination_script';
      scriptInput = buildTerminationScriptInput(job, attemptResult, attemptCount);
      const evaluation = await evaluateTermination(job, scriptInput);
      const { outcome } = evaluation;
      scriptOutput = evaluation.scriptOutput;
      const attemptCompletedAtMs = now();
      trySaveAttempt({
        job,
        attemptCount,
        scriptStatus: 'completed',
        terminationOutcome: outcome,
        scriptInput,
        scriptOutput,
        startedAtMs: attemptStartedAtMs,
        completedAtMs: attemptCompletedAtMs,
      });
      logger.info?.(`[McpLoop:${job.id}] attempt_completed`, {
        jobId: job.id,
        hookId: job.hookId,
        hookExecutionId: job.hookExecutionId,
        sessionId: job.sessionId,
        mcpServerId: job.mcpServerId,
        toolName: job.toolName,
        attemptCount,
        startedAtMs: attemptStartedAtMs,
        completedAtMs: attemptCompletedAtMs,
        durationMs: Math.max(0, attemptCompletedAtMs - attemptStartedAtMs),
        terminationOutcome: outcome,
        result: formatAttemptLogValue(attemptResult),
        scriptOutput: formatAttemptLogValue(scriptOutput),
      });
      if (outcome !== 'running') {
        return transitionTerminal(job, outcome, {
          result: attemptResult,
          attemptCount,
          consecutiveErrorCount: 0,
          error: null,
        });
      }

      const nextPollAtMs = now() + job.pollIntervalMs;
      const update = requeueJob.run({
        id: job.id,
        attemptCount,
        consecutiveErrorCount: 0,
        lastResultJson: serializeJson(attemptResult),
        errorMessage: null,
        nextPollAtMs,
      });
      const pendingJob = getJob(job.id);
      if (update.changes !== 1) return pendingJob;
      await notify('onProgress', pendingJob);
      return pendingJob;
    } catch (error) {
      const consecutiveErrorCount = job.consecutiveErrorCount + 1;
      const attemptCompletedAtMs = now();
      trySaveAttempt({
        job,
        attemptCount,
        scriptStatus: attemptStage === 'mcp_call' ? 'not_run' : 'failed',
        failureStage: attemptStage,
        scriptInput,
        scriptOutput,
        error: error?.message || String(error),
        startedAtMs: attemptStartedAtMs,
        completedAtMs: attemptCompletedAtMs,
      });
      logger.info?.(`[McpLoop:${job.id}] attempt_failed`, {
        jobId: job.id,
        hookId: job.hookId,
        hookExecutionId: job.hookExecutionId,
        sessionId: job.sessionId,
        mcpServerId: job.mcpServerId,
        toolName: job.toolName,
        attemptCount,
        startedAtMs: attemptStartedAtMs,
        completedAtMs: attemptCompletedAtMs,
        durationMs: Math.max(0, attemptCompletedAtMs - attemptStartedAtMs),
        consecutiveErrorCount,
        willRetry: consecutiveErrorCount < maxConsecutiveErrors,
        failureStage: attemptStage,
        ...(hasAttemptResult ? { result: formatAttemptLogValue(attemptResult) } : {}),
        error: formatAttemptLogValue(error?.message || String(error)),
      });
      if (consecutiveErrorCount >= maxConsecutiveErrors) {
        return transitionTerminal(job, 'failed', {
          attemptCount,
          consecutiveErrorCount,
          error: error?.message || String(error),
        });
      }

      const nextPollAtMs = now() + job.pollIntervalMs;
      const update = requeueJob.run({
        id: job.id,
        attemptCount,
        consecutiveErrorCount,
        lastResultJson: serializeJson(job.lastResult),
        errorMessage: error?.message || String(error),
        nextPollAtMs,
      });
      const pendingJob = getJob(job.id);
      if (update.changes !== 1) return pendingJob;
      await notify('onProgress', pendingJob);
      return pendingJob;
    }
  }

  async function tick() {
    const available = Math.max(0, maxConcurrent - runningCount);
    if (available === 0) return [];
    const dueRows = selectDue.all(now(), available);
    const claimed = dueRows
      .filter((row) => claimJob.run(row.id).changes === 1)
      .map(mapJob);
    if (claimed.length === 0) return [];

    runningCount += claimed.length;
    try {
      return await Promise.all(claimed.map((job) => runClaimedJob(job)));
    } finally {
      runningCount -= claimed.length;
    }
  }

  async function enqueue({
    hook,
    action,
    executionId,
    tenantId = null,
    workspaceId = null,
    userId = null,
    sessionId,
    toolUseId,
    workspaceRoot,
    inputs,
    initialResult,
    runtimeContext = null,
  }) {
    const config = action.config || {};
    const configuredIdentity = config.mcpServerId && config.toolName
      ? { mcpServerId: config.mcpServerId, toolName: config.toolName }
      : null;
    const targetIdentity = configuredIdentity || await resolveTargetIdentity({ hook, action });
    const normalizedInitialResult = normalizeMcpLoopResult(initialResult);
    const initialEvaluationJob = {
      hookId: hook.id,
      hookExecutionId: executionId,
      actionId: action.id,
      userId: Number(userId) || null,
      tenantId: Number(tenantId) || null,
      workspaceId: Number(workspaceId) || null,
      sessionId: String(sessionId),
      workspaceRoot: String(workspaceRoot),
      inputs: isPlainObject(inputs) ? inputs : {},
      initialResult: normalizedInitialResult,
      terminationScript: typeof config.terminationScript === 'string' ? config.terminationScript : '',
      successWhen: config.successWhen,
      failureWhen: config.failureWhen,
      startedAtMs: now(),
    };
    const initialAttemptStartedAtMs = now();
    const initialScriptInput = buildTerminationScriptInput(
      initialEvaluationJob,
      normalizedInitialResult,
      0,
    );
    let initialEvaluation;
    try {
      initialEvaluation = await evaluateTermination(initialEvaluationJob, initialScriptInput);
    } catch (error) {
      const initialAttemptCompletedAtMs = now();
      trySaveAttempt({
        job: initialEvaluationJob,
        jobId: null,
        attemptCount: 0,
        scriptStatus: 'failed',
        failureStage: 'termination_script',
        scriptInput: initialScriptInput,
        error: error?.message || String(error),
        startedAtMs: initialAttemptStartedAtMs,
        completedAtMs: initialAttemptCompletedAtMs,
      });
      throw error;
    }
    const initialOutcome = initialEvaluation.outcome;
    if (initialOutcome !== 'running') {
      const initialAttemptCompletedAtMs = now();
      trySaveAttempt({
        job: initialEvaluationJob,
        jobId: null,
        attemptCount: 0,
        scriptStatus: 'completed',
        terminationOutcome: initialOutcome,
        scriptInput: initialScriptInput,
        scriptOutput: initialEvaluation.scriptOutput,
        startedAtMs: initialAttemptStartedAtMs,
        completedAtMs: initialAttemptCompletedAtMs,
      });
      return {
        scheduled: false,
        status: initialOutcome,
        initialResult: normalizedInitialResult,
      };
    }

    const startedAtMs = now();
    const id = createId();
    insertJob.run({
      id,
      hookId: hook.id,
      hookExecutionId: executionId,
      actionId: action.id,
      tenantId: Number(tenantId) || null,
      workspaceId: Number(workspaceId) || null,
      userId: Number(userId) || null,
      sessionId: String(sessionId),
      toolUseId: String(toolUseId),
      workspaceRoot: String(workspaceRoot),
      mcpServerId: String(targetIdentity.mcpServerId),
      toolName: String(targetIdentity.toolName),
      inputsJson: serializeJson(isPlainObject(inputs) ? inputs : {}),
      terminationScript: String(config.terminationScript || ''),
      successWhenJson: serializeJson(config.successWhen || {}),
      failureWhenJson: serializeJson(config.failureWhen),
      waitingLabel: String(config.waitingLabel || hook.name || '等待 MCP 循环完成').slice(0, 200),
      pollIntervalMs: toFiniteNumber(config.pollIntervalMs),
      perCallTimeoutMs: toFiniteNumber(config.perCallTimeoutMs),
      maxWaitMs: toFiniteNumber(config.maxWaitMs),
      initialResultJson: serializeJson(normalizedInitialResult),
      nextPollAtMs: startedAtMs + toFiniteNumber(config.pollIntervalMs),
      startedAtMs,
    });

    const job = database.prepare(`
      SELECT * FROM mcp_loop_jobs
      WHERE hook_execution_id = ? AND action_id = ?
    `).get(executionId, action.id);
    const mapped = mapJob(job);
    if (mapped && runtimeContext && typeof runtimeContext === 'object') {
      runtimeContexts.set(mapped.id, runtimeContext);
    }
    const initialAttemptCompletedAtMs = now();
    trySaveAttempt({
      job: initialEvaluationJob,
      jobId: mapped?.id || null,
      attemptCount: 0,
      scriptStatus: 'completed',
      terminationOutcome: initialOutcome,
      scriptInput: initialScriptInput,
      scriptOutput: initialEvaluation.scriptOutput,
      startedAtMs: initialAttemptStartedAtMs,
      completedAtMs: initialAttemptCompletedAtMs,
    });
    await notify('onStarted', mapped);
    return { scheduled: true, job: mapped };
  }

  async function cancel({ jobId, userId }) {
    const completedAtMs = now();
    const result = cancelJob.run(completedAtMs, String(jobId), Number(userId));
    if (result.changes !== 1) return { success: false, job: getJob(jobId) };
    const job = getJob(jobId);
    await notify('onTerminal', job);
    runtimeContexts.delete(String(jobId));
    return { success: true, job };
  }

  function start() {
    if (timer) return;
    database.prepare(`
      UPDATE mcp_loop_jobs
      SET status = 'queued', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'running'
    `).run();
    timer = setIntervalFn(() => {
      void tick().catch((error) => {
        logger.error?.('[McpLoop] scheduler tick failed:', error?.message || error);
      });
    }, schedulerIntervalMs);
    timer?.unref?.();
    void tick().catch(() => {});
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function setHandlers(nextHandlers = {}) {
    handlers = { ...handlers, ...nextHandlers };
  }

  function listActiveForSession(sessionId) {
    return database.prepare(`
      SELECT * FROM mcp_loop_jobs
      WHERE session_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC
    `).all(String(sessionId)).map(mapJob);
  }

  return {
    enqueue,
    tick,
    start,
    stop,
    cancel,
    getJob,
    listActiveForSession,
    setHandlers,
    isActiveStatus: (status) => ACTIVE_STATUSES.has(status),
    isTerminalStatus: (status) => TERMINAL_STATUSES.has(status),
  };
}

export const mcpLoopService = createMcpLoopService();
