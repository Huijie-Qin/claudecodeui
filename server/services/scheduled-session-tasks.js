import { db } from '../database/db.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { spawnCursor } from '../cursor-cli.js';
import { queryCodex } from '../openai-codex.js';
import { spawnGemini } from '../gemini-cli.js';
import { multitenancyDb } from '../database/multitenancy-db.js';

import { getNextCronRunAt, getNextCronRunAtWithStart, normalizeCronExpression } from './cron-schedule.js';
import {
  buildScheduledTaskRunSessionSummary,
  normalizeScheduledTaskSessionMode,
  resolveScheduledTaskPrompts,
  resolveScheduledTaskResumeSession,
  sanitizeScheduledTaskEvent,
} from './scheduled-task-execution.js';
import { applyWorkspaceOwnership } from './workspace-ownership.js';

const VALID_PROVIDERS = new Set(['claude', 'codex', 'cursor', 'gemini']);
const VALID_SCHEDULE_TYPES = new Set(['interval', 'cron']);
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_DUE_TASKS_PER_TICK = 10;
const PENDING_SESSION_PREFIX = 'scheduled-task-';
const PENDING_PROVIDER_SESSION_PREFIX = 'pending:';

function requirePositiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} must be a positive integer`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${fieldName} is required`);
    error.statusCode = 400;
    throw error;
  }
  return value.trim();
}

function normalizeProvider(provider) {
  const normalized = String(provider || 'claude').trim().toLowerCase();
  if (!VALID_PROVIDERS.has(normalized)) {
    const error = new Error('provider must be one of claude, codex, cursor, gemini');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeScheduleType(scheduleType) {
  const normalized = String(scheduleType || 'interval').trim().toLowerCase();
  if (!VALID_SCHEDULE_TYPES.has(normalized)) {
    const error = new Error('scheduleType must be one of interval, cron');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeDate(value, fieldName) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${fieldName} must be a valid date`);
    error.statusCode = 400;
    throw error;
  }
  return date.toISOString();
}

function serializeOptionalJson(value, fieldName) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    const error = new Error(`${fieldName} must be JSON serializable`);
    error.statusCode = 400;
    throw error;
  }
}

function parseOptionalJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapTaskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    provider: row.provider,
    name: row.name,
    prompt: row.prompt,
    scheduleType: row.schedule_type || 'interval',
    scheduleCron: row.schedule_cron || null,
    intervalMinutes: row.interval_minutes,
    scheduleStartAt: row.schedule_start_at || row.next_run_at,
    nextRunAt: row.next_run_at,
    enabled: Boolean(row.enabled),
    model: row.model,
    permissionMode: row.permission_mode,
    toolsSettings: parseOptionalJson(row.tools_settings_json),
    sessionMode: row.session_mode || 'new',
    lastRunAt: row.last_run_at,
    lastSessionId: row.last_session_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function addIntervalFromNow(intervalMinutes) {
  return new Date(Date.now() + intervalMinutes * 60_000).toISOString();
}

function normalizeTaskSchedule({
  scheduleType = null,
  scheduleCron = null,
  intervalMinutes,
  nextRunAt,
  startAfterAt,
  minNextRunAt = null,
}) {
  const inferredScheduleType = scheduleType == null || scheduleType === ''
    ? (scheduleCron ? 'cron' : 'interval')
    : scheduleType;
  const normalizedScheduleType = normalizeScheduleType(inferredScheduleType);
  if (normalizedScheduleType === 'cron') {
    const normalizedCron = normalizeCronExpression(scheduleCron);
    const scheduleStartAt = normalizeDate(startAfterAt || nextRunAt || new Date().toISOString(), 'startAfterAt');
    const startAfterDate = new Date(scheduleStartAt);
    return {
      scheduleType: 'cron',
      scheduleCron: normalizedCron,
      intervalMinutes: intervalMinutes == null ? 60 : requirePositiveInteger(intervalMinutes, 'intervalMinutes'),
      scheduleStartAt,
      nextRunAt: getNextCronRunAtWithStart(normalizedCron, startAfterDate, {
        notBeforeDate: minNextRunAt,
      }).toISOString(),
    };
  }

  const normalizedNextRunAt = normalizeDate(nextRunAt, 'nextRunAt');
  return {
    scheduleType: 'interval',
    scheduleCron: null,
    intervalMinutes: requirePositiveInteger(intervalMinutes, 'intervalMinutes'),
    scheduleStartAt: normalizedNextRunAt,
    nextRunAt: normalizedNextRunAt,
  };
}

function computeNextRunAtAfterClaim(row) {
  if ((row.schedule_type || 'interval') === 'cron' && row.schedule_cron) {
    return getNextCronRunAt(row.schedule_cron, new Date()).toISOString();
  }

  return addIntervalFromNow(row.interval_minutes);
}

function isPendingScheduledSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(PENDING_SESSION_PREFIX);
}

function isPendingProviderSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(PENDING_PROVIDER_SESSION_PREFIX);
}

function isResumableSessionId(sessionId) {
  return Boolean(
    typeof sessionId === 'string'
    && sessionId.trim()
    && !isPendingScheduledSessionId(sessionId)
    && !isPendingProviderSessionId(sessionId),
  );
}

class ScheduledTaskWriter {
  constructor({ task, clients }) {
    this.task = task;
    this.clients = clients;
    this.userId = task.user_id;
    this.tenantId = task.tenant_id;
    this.sessionId = null;
    this.observedSessionId = null;
    this.lastError = null;
    this.displayPrompt = null;
    this.modelPrompt = null;
    this.isWebSocketWriter = true;
    this.isScheduledTaskWriter = true;
    this.isBackgroundTaskWriter = true;
  }

  observeSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return;
    const normalizedSessionId = sessionId.trim();
    this.observedSessionId = normalizedSessionId;
    if (isResumableSessionId(normalizedSessionId)) {
      this.sessionId = normalizedSessionId;
    }
  }

  send(data) {
    if (data?.sessionId || data?.newSessionId || data?.actualSessionId) {
      this.observeSessionId(data.sessionId || data.newSessionId || data.actualSessionId);
    }
    if (data?.kind === 'error') {
      this.lastError = data.content || data.message || data.text || 'Scheduled task failed';
    }

    if (!this.clients) return;

    const payload = JSON.stringify({
      ...this.toVisibleData(data),
      scheduledTaskId: this.task.id,
      scheduledTaskName: this.task.name,
      scheduledTaskPreviousSessionId: this.task.last_session_id || null,
    });

    this.clients.forEach((client) => {
      if (
        client.readyState === 1 &&
        client.userId === this.userId &&
        (!client.tenantId || client.tenantId === this.tenantId)
      ) {
        client.send(payload);
      }
    });
  }

  setPromptDisplay({ displayPrompt, modelPrompt }) {
    this.displayPrompt = typeof displayPrompt === 'string' ? displayPrompt : null;
    this.modelPrompt = typeof modelPrompt === 'string' ? modelPrompt : null;
  }

  toVisibleData(data) {
    return sanitizeScheduledTaskEvent({
      data,
      displayPrompt: this.displayPrompt,
      modelPrompt: this.modelPrompt,
    });
  }

  setSessionId(sessionId) {
    this.observeSessionId(sessionId);
  }

  getSessionId() {
    return this.sessionId;
  }

  getObservedSessionId() {
    return this.observedSessionId;
  }

  getLastError() {
    return this.lastError;
  }

  clearLastError() {
    this.lastError = null;
  }
}

function hasBoundClaudeRuntime(task, sessionId) {
  if (task.provider !== 'claude' || !isResumableSessionId(sessionId)) {
    return true;
  }

  if (typeof multitenancyDb.runtimes?.findByProviderSession !== 'function') {
    return true;
  }

  try {
    return Boolean(multitenancyDb.runtimes.findByProviderSession({
      tenantId: task.tenant_id,
      workspaceId: task.workspace_id,
      userId: task.user_id,
      provider: 'claude',
      providerSessionId: sessionId,
    }));
  } catch (error) {
    console.warn(`[ScheduledTasks] Failed to verify Claude runtime for task ${task.id}:`, error?.message || error);
    return false;
  }
}

function createScheduledTaskOptions(task) {
  const toolsSettings = parseOptionalJson(task.tools_settings_json) || {};
  const boundSessionId = typeof task.last_session_id === 'string' && task.last_session_id.trim()
    ? task.last_session_id.trim()
    : null;
  const resumableSessionId = resolveScheduledTaskResumeSession({
    sessionMode: task.session_mode || 'new',
    sessionId: boundSessionId,
    isResumable: isResumableSessionId,
    canResume: (candidateSessionId) => hasBoundClaudeRuntime(task, candidateSessionId),
  });
  const baseOptions = {
    tenantId: task.tenant_id,
    workspaceId: task.workspace_id,
    userId: task.user_id,
    projectName: task.workspace_slug,
    projectPath: task.workspace_path,
    cwd: task.workspace_path,
    sessionId: resumableSessionId || undefined,
    resume: Boolean(resumableSessionId),
    sessionSummary: task.run_session_summary || task.name,
    sessionMetadata: {
      scheduledTaskId: task.id,
      scheduledTaskRunAt: task.run_started_at || null,
    },
    model: task.model || undefined,
    permissionMode: task.permission_mode || undefined,
    toolsSettings,
    backgroundTask: true,
    scheduledTaskId: task.id,
    displayCommand: task.prompt,
  };

  if (task.provider === 'cursor') {
    baseOptions.skipPermissions = Boolean(toolsSettings.skipPermissions);
  }

  return baseOptions;
}

function isInvalidClaudeResumeError(errorMessage) {
  return /--resume requires a valid session ID/i.test(String(errorMessage || ''));
}

async function runProviderTask(task, writer) {
  const options = createScheduledTaskOptions(task);
  const { displayPrompt, modelPrompt } = await resolveScheduledTaskPrompts({
    provider: task.provider,
    prompt: task.prompt,
    workspacePath: task.workspace_path,
  });
  writer.setPromptDisplay?.({ displayPrompt, modelPrompt });

  if (task.provider === 'cursor') {
    await spawnCursor(modelPrompt, options, writer);
  } else if (task.provider === 'codex') {
    await queryCodex(modelPrompt, options, writer);
  } else if (task.provider === 'gemini') {
    await spawnGemini(modelPrompt, options, writer);
  } else {
    await queryClaudeSDK(modelPrompt, options, writer);
    if (options.resume && isInvalidClaudeResumeError(writer.getLastError?.())) {
      console.warn(
        `[ScheduledTasks] Task ${task.id} could not resume Claude session ${options.sessionId}; retrying with a new session`,
      );
      writer.clearLastError?.();
      await queryClaudeSDK(modelPrompt, {
        ...options,
        sessionId: undefined,
        resume: false,
      }, writer);
    }
  }
}

export function createScheduledSessionTaskService({ clients = null, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const activeRuns = new Set();
  let timer = null;

  const service = {
    list({ tenantId, userId, workspaceId = null }) {
      const params = [requirePositiveInteger(tenantId, 'tenantId'), requirePositiveInteger(userId, 'userId')];
      const workspaceClause = workspaceId ? 'AND workspace_id = ?' : '';
      if (workspaceId) params.push(requirePositiveInteger(workspaceId, 'workspaceId'));

      return db.prepare(`
        SELECT *
        FROM scheduled_session_tasks
        WHERE tenant_id = ?
          AND user_id = ?
          ${workspaceClause}
        ORDER BY enabled DESC, next_run_at ASC, updated_at DESC
      `).all(...params).map(mapTaskRow);
    },

    getOwned({ tenantId, userId, taskId }) {
      return mapTaskRow(db.prepare(`
        SELECT *
        FROM scheduled_session_tasks
        WHERE tenant_id = ?
          AND user_id = ?
          AND id = ?
      `).get(
        requirePositiveInteger(tenantId, 'tenantId'),
        requirePositiveInteger(userId, 'userId'),
        requirePositiveInteger(taskId, 'taskId'),
      ));
    },

    create({
      tenantId,
      workspaceId,
      userId,
      provider,
      name,
      prompt,
      scheduleType = 'interval',
      scheduleCron = null,
      intervalMinutes,
      nextRunAt,
      startAfterAt = null,
      enabled = true,
      model = null,
      permissionMode = null,
      toolsSettings = null,
      sessionMode = 'new',
      sessionId = null,
    }) {
      if (sessionId) {
        const error = new Error('Scheduled tasks can only be created from a new session');
        error.statusCode = 400;
        throw error;
      }

      const normalizedTenantId = requirePositiveInteger(tenantId, 'tenantId');
      const normalizedWorkspaceId = requirePositiveInteger(workspaceId, 'workspaceId');
      const normalizedUserId = requirePositiveInteger(userId, 'userId');
      const normalizedProvider = normalizeProvider(provider);
      const normalizedName = requireNonEmptyString(name, 'name');
      const normalizedPrompt = requireNonEmptyString(prompt, 'prompt');
      const normalizedSchedule = normalizeTaskSchedule({
        scheduleType,
        scheduleCron,
        intervalMinutes,
        nextRunAt,
        startAfterAt,
      });
      const normalizedSessionMode = normalizeScheduledTaskSessionMode(sessionMode);

      const result = db.prepare(`
        INSERT INTO scheduled_session_tasks (
          tenant_id,
          workspace_id,
          user_id,
          provider,
          name,
          prompt,
          schedule_type,
          schedule_cron,
          interval_minutes,
          schedule_start_at,
          next_run_at,
          enabled,
          model,
          permission_mode,
          tools_settings_json,
          session_mode,
          last_session_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedTenantId,
        normalizedWorkspaceId,
        normalizedUserId,
        normalizedProvider,
        normalizedName,
        normalizedPrompt,
        normalizedSchedule.scheduleType,
        normalizedSchedule.scheduleCron,
        normalizedSchedule.intervalMinutes,
        normalizedSchedule.scheduleStartAt,
        normalizedSchedule.nextRunAt,
        enabled ? 1 : 0,
        model ? String(model).trim() : null,
        permissionMode ? String(permissionMode).trim() : null,
        serializeOptionalJson(toolsSettings, 'toolsSettings'),
        normalizedSessionMode,
        null,
      );

      const taskId = Number(result.lastInsertRowid);
      return service.getOwned({ tenantId: normalizedTenantId, userId: normalizedUserId, taskId });
    },

    update({ tenantId, userId, taskId, patch }) {
      const existing = service.getOwned({ tenantId, userId, taskId });
      if (!existing) {
        const error = new Error('Scheduled task not found');
        error.statusCode = 404;
        throw error;
      }

      const hasSchedulePatch = [
        'scheduleType',
        'scheduleCron',
        'intervalMinutes',
        'nextRunAt',
        'startAfterAt',
      ].some((key) => patch[key] !== undefined);

      const normalizedSchedule = hasSchedulePatch
        ? normalizeTaskSchedule({
            scheduleType: patch.scheduleType !== undefined ? patch.scheduleType : existing.scheduleType,
            scheduleCron: patch.scheduleCron !== undefined ? patch.scheduleCron : existing.scheduleCron,
            intervalMinutes: patch.intervalMinutes !== undefined ? patch.intervalMinutes : existing.intervalMinutes,
            nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : existing.nextRunAt,
            startAfterAt: patch.startAfterAt !== undefined ? patch.startAfterAt : existing.scheduleStartAt,
            minNextRunAt: new Date(),
          })
        : {
            scheduleType: existing.scheduleType || 'interval',
            scheduleCron: existing.scheduleCron || null,
            intervalMinutes: existing.intervalMinutes,
            scheduleStartAt: existing.scheduleStartAt || existing.nextRunAt,
            nextRunAt: existing.nextRunAt,
          };

      const next = {
        provider: patch.provider !== undefined ? normalizeProvider(patch.provider) : existing.provider,
        name: patch.name !== undefined ? requireNonEmptyString(patch.name, 'name') : existing.name,
        prompt: patch.prompt !== undefined ? requireNonEmptyString(patch.prompt, 'prompt') : existing.prompt,
        scheduleType: normalizedSchedule.scheduleType,
        scheduleCron: normalizedSchedule.scheduleCron,
        intervalMinutes: normalizedSchedule.intervalMinutes,
        scheduleStartAt: normalizedSchedule.scheduleStartAt,
        nextRunAt: normalizedSchedule.nextRunAt,
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
        model: patch.model !== undefined && patch.model !== null && String(patch.model).trim()
          ? String(patch.model).trim()
          : (patch.model === null ? null : existing.model),
        permissionMode: patch.permissionMode !== undefined && patch.permissionMode !== null && String(patch.permissionMode).trim()
          ? String(patch.permissionMode).trim()
          : (patch.permissionMode === null ? null : existing.permissionMode),
        toolsSettings: patch.toolsSettings !== undefined ? patch.toolsSettings : existing.toolsSettings,
        sessionMode: patch.sessionMode !== undefined
          ? normalizeScheduledTaskSessionMode(patch.sessionMode)
          : existing.sessionMode,
      };

      db.prepare(`
        UPDATE scheduled_session_tasks
        SET provider = ?,
            name = ?,
            prompt = ?,
            schedule_type = ?,
            schedule_cron = ?,
            interval_minutes = ?,
            schedule_start_at = ?,
            next_run_at = ?,
            enabled = ?,
            model = ?,
            permission_mode = ?,
            tools_settings_json = ?,
            session_mode = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?
          AND user_id = ?
          AND id = ?
      `).run(
        next.provider,
        next.name,
        next.prompt,
        next.scheduleType,
        next.scheduleCron,
        next.intervalMinutes,
        next.scheduleStartAt,
        next.nextRunAt,
        next.enabled ? 1 : 0,
        next.model,
        next.permissionMode,
        serializeOptionalJson(next.toolsSettings, 'toolsSettings'),
        next.sessionMode,
        requirePositiveInteger(tenantId, 'tenantId'),
        requirePositiveInteger(userId, 'userId'),
        requirePositiveInteger(taskId, 'taskId'),
      );

      return service.getOwned({ tenantId, userId, taskId });
    },

    remove({ tenantId, userId, taskId }) {
      const result = db.prepare(`
        DELETE FROM scheduled_session_tasks
        WHERE tenant_id = ?
          AND user_id = ?
          AND id = ?
      `).run(
        requirePositiveInteger(tenantId, 'tenantId'),
        requirePositiveInteger(userId, 'userId'),
        requirePositiveInteger(taskId, 'taskId'),
      );
      return result.changes > 0;
    },

    markRunResult({
      taskId,
      sessionId = null,
      observedSessionId = null,
      error = null,
      sessionSummary = null,
      runStartedAt = null,
    }) {
      const task = db.prepare(`
        SELECT *
        FROM scheduled_session_tasks
        WHERE id = ?
      `).get(requirePositiveInteger(taskId, 'taskId'));
      const previousSessionId = task?.last_session_id;
      const normalizedSessionId = isResumableSessionId(sessionId) ? sessionId.trim() : null;
      const nonResumableObservedSessionId = observedSessionId && !isResumableSessionId(observedSessionId)
        ? observedSessionId.trim()
        : null;

      db.prepare(`
        UPDATE scheduled_session_tasks
        SET last_run_at = ?,
            last_session_id = COALESCE(?, last_session_id),
            last_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(new Date().toISOString(), normalizedSessionId, error, requirePositiveInteger(taskId, 'taskId'));

      if (
        normalizedSessionId &&
        previousSessionId &&
        (isPendingScheduledSessionId(previousSessionId) || isPendingProviderSessionId(previousSessionId)) &&
        previousSessionId !== normalizedSessionId
      ) {
        multitenancyDb.sessions.markDeleted({
          tenantId: task.tenant_id,
          workspaceId: task.workspace_id,
          userId: task.user_id,
          provider: task.provider,
          providerSessionId: previousSessionId,
        });
      }

      if (nonResumableObservedSessionId && isPendingProviderSessionId(nonResumableObservedSessionId) && task) {
        multitenancyDb.sessions.markDeleted({
          tenantId: task.tenant_id,
          workspaceId: task.workspace_id,
          userId: task.user_id,
          provider: task.provider,
          providerSessionId: nonResumableObservedSessionId,
        });
      }

      if (normalizedSessionId && task) {
        multitenancyDb.sessions.upsertSession({
          tenantId: task.tenant_id,
          workspaceId: task.workspace_id,
          userId: task.user_id,
          provider: task.provider,
          providerSessionId: normalizedSessionId,
          summary: sessionSummary || task.name,
          status: error ? 'failed' : 'completed',
          metadata: {
            scheduledTaskId: task.id,
            scheduledTaskRunAt: runStartedAt,
          },
        });
      }
    },

    claimDueTasks(limit = MAX_DUE_TASKS_PER_TICK) {
      const now = new Date().toISOString();
      const rows = db.prepare(`
        SELECT
          t.*,
          w.slug AS workspace_slug,
          w.path AS workspace_path,
          w.status AS workspace_status
        FROM scheduled_session_tasks t
        JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.enabled = 1
          AND t.next_run_at <= ?
        ORDER BY t.next_run_at ASC, t.id ASC
        LIMIT ?
      `).all(now, limit);

      for (const row of rows) {
        db.prepare(`
          UPDATE scheduled_session_tasks
          SET next_run_at = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(computeNextRunAtAfterClaim(row), row.id);
      }

      return rows;
    },

    async runTask(task) {
      if (activeRuns.has(task.id)) return;
      activeRuns.add(task.id);
      const runStartedAt = new Date().toISOString();
      const runSessionSummary = buildScheduledTaskRunSessionSummary({
        taskName: task.name,
        sessionMode: task.session_mode,
        runStartedAt,
      });
      const currentRun = {
        ...task,
        run_started_at: runStartedAt,
        run_session_summary: runSessionSummary,
      };
      const writer = new ScheduledTaskWriter({ task: currentRun, clients });
      try {
        if (currentRun.workspace_status !== 'active') {
          throw new Error('Workspace is not active');
        }
        await runProviderTask(currentRun, writer);
        service.markRunResult({
          taskId: currentRun.id,
          sessionId: writer.getSessionId(),
          observedSessionId: writer.getObservedSessionId(),
          error: writer.getLastError(),
          sessionSummary: runSessionSummary,
          runStartedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ScheduledTasks] Task ${task.id} failed:`, message);
        service.markRunResult({
          taskId: currentRun.id,
          sessionId: writer.getSessionId(),
          observedSessionId: writer.getObservedSessionId(),
          error: message,
          sessionSummary: runSessionSummary,
          runStartedAt,
        });
      } finally {
        if (task.provider !== 'claude' && task.workspace_path) {
          await applyWorkspaceOwnership({
            workspaceRoot: task.workspace_path,
            targetPaths: [task.workspace_path],
            recursive: true,
            includeParents: false,
            reason: 'scheduled_provider_task_completed',
            context: {
              provider: task.provider,
              workspaceId: task.workspace_id,
              scheduledTaskId: task.id,
            },
          }).catch((error) => {
            console.error('[workspace-ownership] Failed after scheduled provider task:', error);
          });
        }
        activeRuns.delete(task.id);
      }
    },

    async tick() {
      const dueTasks = service.claimDueTasks();
      await Promise.all(dueTasks.map((task) => service.runTask(task)));
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        service.tick().catch((error) => {
          console.error('[ScheduledTasks] Tick failed:', error);
        });
      }, pollIntervalMs);
      service.tick().catch((error) => {
        console.error('[ScheduledTasks] Initial tick failed:', error);
      });
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };

  return service;
}
