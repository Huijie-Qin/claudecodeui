import crypto from 'node:crypto';
import path from 'node:path';

import { db } from '../database/db.js';
import { MCP_LOOP_JOB_SCHEMA_SQL } from '../database/hook-config-schema.js';

import { callHookMcpTool, normalizeToolOutput } from './hook-mcp-client.js';
import { hookMcpCatalogService } from './hook-mcp-catalog.js';

const DEFAULT_SCHEDULER_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 3;
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

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

async function resolveDefaultTarget(job) {
  const resource = hookMcpCatalogService.listToolResources().find((tool) => (
    tool.mcpServerId === job.mcpServerId
    && (tool.name === job.toolName || tool.toolName === job.toolName)
  ));
  if (!resource) {
    throw new Error(`MCP loop target ${job.toolName} is unavailable`);
  }

  const mcpRoot = path.join(job.workspaceRoot, '.cloudcli', 'hook-config', 'mcp');
  const runtime = await hookMcpCatalogService.getRuntimeConfig({
    serverIds: [job.mcpServerId],
    hostDirectory: mcpRoot,
    commandDirectory: mcpRoot,
    runtimeMode: 'local',
  });
  return {
    qualifiedToolName: `mcp__${resource.runtimeAlias}__${resource.toolName}`,
    mcpServers: runtime.mcpServers,
    cwd: job.workspaceRoot,
  };
}

async function callDefaultTarget(job) {
  const target = await resolveDefaultTarget(job);
  return callHookMcpTool({
    ...target,
    input: job.inputs,
    timeoutMs: job.perCallTimeoutMs,
  });
}

export function createMcpLoopService({
  database = db,
  callTarget = callDefaultTarget,
  now = () => Date.now(),
  createId = () => crypto.randomUUID(),
  schedulerIntervalMs = DEFAULT_SCHEDULER_INTERVAL_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxConsecutiveErrors = DEFAULT_MAX_CONSECUTIVE_ERRORS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logger = console,
} = {}) {
  database.exec(MCP_LOOP_JOB_SCHEMA_SQL);
  let timer = null;
  let runningCount = 0;
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
      success_when_json, failure_when_json, waiting_label,
      poll_interval_ms, per_call_timeout_ms, max_wait_ms,
      status, attempt_count, consecutive_error_count,
      initial_result_json, last_result_json, error_message,
      next_poll_at_ms, started_at_ms, completed_at_ms, updated_at
    ) VALUES (
      @id, @hookId, @hookExecutionId, @actionId,
      @tenantId, @workspaceId, @userId, @sessionId, @toolUseId,
      @workspaceRoot, @mcpServerId, @toolName, @inputsJson,
      @successWhenJson, @failureWhenJson, @waitingLabel,
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
    return terminalJob;
  }

  async function runClaimedJob(job) {
    const currentTime = now();
    if (currentTime - job.startedAtMs >= job.maxWaitMs) {
      return transitionTerminal(job, 'timed_out', {
        error: `MCP loop timed out after ${job.maxWaitMs} ms`,
      });
    }

    const attemptCount = job.attemptCount + 1;
    try {
      const result = normalizeMcpLoopResult(await callTarget(job));
      const outcome = evaluateMcpLoopResult(result, job);
      if (outcome !== 'running') {
        return transitionTerminal(job, outcome, {
          result,
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
        lastResultJson: serializeJson(result),
        errorMessage: null,
        nextPollAtMs,
      });
      const pendingJob = getJob(job.id);
      if (update.changes !== 1) return pendingJob;
      await notify('onProgress', pendingJob);
      return pendingJob;
    } catch (error) {
      const consecutiveErrorCount = job.consecutiveErrorCount + 1;
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
  }) {
    const config = action.config || {};
    const normalizedInitialResult = normalizeMcpLoopResult(initialResult);
    const initialOutcome = evaluateMcpLoopResult(normalizedInitialResult, config);
    if (initialOutcome !== 'running') {
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
      mcpServerId: String(config.mcpServerId),
      toolName: String(config.toolName),
      inputsJson: serializeJson(isPlainObject(inputs) ? inputs : {}),
      successWhenJson: serializeJson(config.successWhen),
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
    await notify('onStarted', mapped);
    return { scheduled: true, job: mapped };
  }

  async function cancel({ jobId, userId }) {
    const completedAtMs = now();
    const result = cancelJob.run(completedAtMs, String(jobId), Number(userId));
    if (result.changes !== 1) return { success: false, job: getJob(jobId) };
    const job = getJob(jobId);
    await notify('onTerminal', job);
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
