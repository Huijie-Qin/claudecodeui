import { multitenancyDb } from '../database/multitenancy-db.js';

import { hookConfigService } from './hook-configs.js';

function generateUserPromptMessageId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const TRANSIENT_MESSAGE_KINDS = new Set(['stream_delta', 'stream_end']);
const CLAUDE_SYNTHETIC_MESSAGE_KINDS = new Set(['hook_activity']);
const SCHEDULED_SKILL_MATCH_WINDOW_MS = 60_000;
const SLASH_INVOCATION_PATTERN = /^\/[^\s/]+(?:\s[\s\S]*)?$/;
const CLAUDE_INTERNAL_CONTENT_PREFIXES = [
  '<ccui-hook-recovery',
  '<ccui-mcp-loop-result',
  '<local-command-caveat>',
  'Base directory for this skill:',
];

function hasHiddenMessageFlag(message) {
  return (
    message?.isMeta === true ||
    message?.is_meta === true ||
    message?.isSidechain === true ||
    message?.is_sidechain === true ||
    message?.message?.isMeta === true ||
    message?.message?.is_meta === true ||
    message?.message?.isSidechain === true ||
    message?.message?.is_sidechain === true
  );
}

function getMessageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.text === 'string') return message.text;
  return '';
}

function isClaudeInternalContent(message) {
  if (message?.provider !== 'claude' && message?.providerName !== 'claude') {
    return false;
  }

  const content = getMessageContent(message).trimStart();
  return CLAUDE_INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

function isPersistableMessage(message) {
  return (
    !TRANSIENT_MESSAGE_KINDS.has(message?.kind) &&
    !hasHiddenMessageFlag(message) &&
    !isClaudeInternalContent(message)
  );
}

function isScheduledSession(ownedSession) {
  if (typeof ownedSession?.metadata_json !== 'string' || !ownedSession.metadata_json.trim()) {
    return false;
  }

  try {
    return Boolean(JSON.parse(ownedSession.metadata_json)?.scheduledTaskId);
  } catch {
    return false;
  }
}

function getMessageTimestampMs(message) {
  const value = message?.timestamp;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isClaudeSyntheticMessage(message) {
  return CLAUDE_SYNTHETIC_MESSAGE_KINDS.has(message?.kind)
    || (message?.kind === 'task_notification' && message?.syntheticSubagentStop === true)
    || (message?.origin === 'hook' && message?.mcpLoopReplacement === true);
}

function getUserHookActivityVisibility(
  hookConfigs,
  userId,
  hookId,
  visibilityByHookId,
  workspaceId = null,
  tenantId = null,
) {
  if (typeof hookConfigs?.getUserHookChatVisibility !== 'function') return true;
  if (visibilityByHookId.has(hookId)) return visibilityByHookId.get(hookId);
  let visible = true;
  try {
    visible = hookConfigs.getUserHookChatVisibility({
      userId,
      hookId,
      workspaceId,
      tenantId,
    }) !== false;
  } catch {
    // Visibility preferences should never make the session history unavailable.
    visible = true;
  }
  visibilityByHookId.set(hookId, visible);
  return visible;
}

function isHookActivityVisible(
  message,
  hookConfigs,
  userId,
  visibilityByHookId,
  workspaceId = null,
  tenantId = null,
) {
  if (!isClaudeSyntheticMessage(message) || !message?.hookId) return true;
  const hookId = String(message.hookId);
  return getUserHookActivityVisibility(
    hookConfigs,
    userId,
    hookId,
    visibilityByHookId,
    workspaceId,
    tenantId,
  );
}

function getHookActivityIdentity(message) {
  if (typeof message?.jobId === 'string' && message.jobId) return message.jobId;
  if (typeof message?.id === 'string' && message.id) return message.id;
  return null;
}

function omitHiddenHookRecoveryMessages(
  messages,
  hiddenHookActivityIds,
  hiddenHookExecutionPrefixes,
) {
  if (!hiddenHookActivityIds.size && !hiddenHookExecutionPrefixes.size) return messages;
  return messages.filter((message) => {
    if (typeof message?.hookActivityId !== 'string') return true;
    return !hiddenHookActivityIds.has(message.hookActivityId)
      && ![...hiddenHookExecutionPrefixes].some((prefix) => message.hookActivityId.startsWith(prefix));
  });
}

function mergeClaudeSyntheticMessages(transcriptMessages, syntheticMessages) {
  const mergedById = new Map();
  const combined = [
    ...(Array.isArray(transcriptMessages) ? transcriptMessages : []),
    ...(Array.isArray(syntheticMessages) ? syntheticMessages : []),
  ];

  combined.forEach((message, index) => {
    const key = typeof message?.id === 'string' && message.id
      ? message.id
      : `message-without-id-${index}`;
    const existing = mergedById.get(key)?.message;
    const mergedMessage = existing
      ? {
        ...existing,
        ...message,
        ...(message?.actionResults === undefined && existing?.actionResults !== undefined
          ? { actionResults: existing.actionResults }
          : {}),
      }
      : message;
    mergedById.set(key, { message: mergedMessage, index });
  });

  return [...mergedById.values()]
    .sort((left, right) => {
      const leftTimestamp = getMessageTimestampMs(left.message);
      const rightTimestamp = getMessageTimestampMs(right.message);
      if (leftTimestamp === null && rightTimestamp === null) return left.index - right.index;
      if (leftTimestamp === null) return 1;
      if (rightTimestamp === null) return -1;
      return leftTimestamp - rightTimestamp || left.index - right.index;
    })
    .map(({ message }) => message);
}

function buildHistoricalHookActionResults(hook, execution, records = []) {
  const actions = execution?.actions;
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return [];
  const availableRecords = [...records];

  return (hook?.postActions || []).flatMap((action) => {
    if (!['call_mcp_tool', 'write_record'].includes(action?.type)) return [];
    if (!Object.prototype.hasOwnProperty.call(actions, action.id)) return [];
    const output = actions[action.id]?.output;
    const result = {
      actionId: action.id,
      actionType: action.type,
      output,
    };
    if (action.type === 'write_record' && output?.recorded === true) {
      const recordIndex = availableRecords.findIndex((record) => (
        (typeof output.id === 'string' && record.id === output.id)
        || (
          typeof output.type === 'string'
          && record.type === output.type
        )
      ));
      if (recordIndex >= 0) {
        const [record] = availableRecords.splice(recordIndex, 1);
        result.record = {
          id: record.id,
          type: record.type,
          data: record.data,
          createdAt: record.createdAt,
        };
      } else if (typeof output.id === 'string') {
        result.record = {
          id: output.id,
          type: output.type,
          data: output.data,
        };
      }
    }
    return [result];
  });
}

function listHistoricalHookActivities({
  hookConfigs,
  providerSessionId,
  userId,
  workspaceId,
  tenantId,
  hiddenHookExecutionPrefixes,
}) {
  if (!providerSessionId || typeof hookConfigs?.listAllExecutions !== 'function') return [];

  try {
    const hooks = new Map();
    const visibilityByHookId = new Map();
    return hookConfigs.listAllExecutions({
      sessionId: providerSessionId,
      userId,
      limit: 200,
      summary: false,
    }).flatMap((execution) => {
      let hook = hooks.get(execution.hookId);
      if (hook === undefined) {
        hook = typeof hookConfigs.getHook === 'function' ? hookConfigs.getHook(execution.hookId) : null;
        hooks.set(execution.hookId, hook || null);
      }
      if (!getUserHookActivityVisibility(
        hookConfigs,
        userId,
        execution.hookId,
        visibilityByHookId,
        workspaceId,
        tenantId,
      )) {
        hiddenHookExecutionPrefixes.add(`hook_activity_${execution.id}_`);
        return [];
      }
      const startedAt = Number(execution.startedAtMs) > 0
        ? new Date(Number(execution.startedAtMs))
        : new Date(execution.startedAt);
      const timestamp = Number.isFinite(startedAt.getTime())
        ? startedAt.toISOString()
        : new Date(0).toISOString();
      const records = typeof hookConfigs.listExecutionDataRecords === 'function'
        ? hookConfigs.listExecutionDataRecords(execution.id)
        : [];
      const actionResults = buildHistoricalHookActionResults(hook, execution, records);
      return [{
        id: `hook_activity_${execution.id}_execution`,
        sessionId: providerSessionId,
        timestamp,
        provider: 'claude',
        kind: 'hook_activity',
        origin: 'hook',
        activityKind: 'execution',
        status: ['running', 'succeeded', 'failed'].includes(execution.status)
          ? execution.status
          : 'failed',
        jobId: `hook_activity_${execution.id}_execution`,
        executionId: execution.id,
        hookId: execution.hookId,
        hookName: execution.hookName || hook?.name || null,
        eventName: execution.eventName || hook?.eventName || null,
        actionTypes: [...new Set((hook?.postActions || []).map((action) => action.type).filter(Boolean))],
        ...(actionResults.length > 0 ? { actionResults } : {}),
        hasScript: Boolean(hook?.extensionLogic?.code?.trim()),
        summary: String(hook?.description || '').slice(0, 8000),
      }];
    });
  } catch (error) {
    console.warn('[SessionHistory] Failed to restore Hook execution activities:', error?.message || error);
    return [];
  }
}

function isScheduledSlashInvocation(message) {
  const content = getMessageContent(message).trim();
  return (
    message?.kind === 'text'
    && message?.role === 'user'
    && SLASH_INVOCATION_PATTERN.test(content)
  );
}

function isScheduledUserText(message) {
  const content = getMessageContent(message).trimStart();
  return (
    message?.kind === 'text'
    && message?.role === 'user'
    && !/^<task-notification\b/i.test(content)
  );
}

function findScheduledInvocationMatch(jsonlMessages, invocation, matchedIndexes) {
  const invocationTimestamp = getMessageTimestampMs(invocation);
  if (invocationTimestamp === null) {
    return -1;
  }

  const invocationContent = getMessageContent(invocation).trim();
  const candidates = jsonlMessages
    .map((message, index) => ({
      index,
      message,
      timestamp: getMessageTimestampMs(message),
    }))
    .filter(({ index, message, timestamp }) => (
      !matchedIndexes.has(index)
      && timestamp !== null
      && isScheduledUserText(message)
      && Math.abs(timestamp - invocationTimestamp) <= SCHEDULED_SKILL_MATCH_WINDOW_MS
    ))
    .sort((left, right) => {
      const leftExact = getMessageContent(left.message).trim() === invocationContent;
      const rightExact = getMessageContent(right.message).trim() === invocationContent;
      if (leftExact !== rightExact) {
        return leftExact ? -1 : 1;
      }
      return Math.abs(left.timestamp - invocationTimestamp)
        - Math.abs(right.timestamp - invocationTimestamp);
    });

  return candidates[0]?.index ?? -1;
}

function mergeLegacyScheduledSkillInvocations(jsonlMessages, dbMessages) {
  const normalizedJsonlMessages = Array.isArray(jsonlMessages) ? jsonlMessages : [];
  const invocations = Array.isArray(dbMessages)
    ? dbMessages.filter(isScheduledSlashInvocation)
    : [];
  const matchedIndexes = new Set();
  const replacedIndexes = new Set();
  const fallbackInvocations = [];

  for (const invocation of invocations) {
    const matchIndex = findScheduledInvocationMatch(
      normalizedJsonlMessages,
      invocation,
      matchedIndexes,
    );
    if (matchIndex === -1) {
      fallbackInvocations.push(invocation);
      continue;
    }

    matchedIndexes.add(matchIndex);
    const matchedContent = getMessageContent(normalizedJsonlMessages[matchIndex]).trim();
    if (matchedContent !== getMessageContent(invocation).trim()) {
      replacedIndexes.add(matchIndex);
      fallbackInvocations.push(invocation);
    }
  }

  return [
    ...normalizedJsonlMessages.filter((_, index) => !replacedIndexes.has(index)),
    ...fallbackInvocations,
  ]
    .map((message, index) => ({
      message,
      index,
      timestamp: getMessageTimestampMs(message),
    }))
    .sort((left, right) => {
      if (left.timestamp === null && right.timestamp === null) {
        return left.index - right.index;
      }
      if (left.timestamp === null) return 1;
      if (right.timestamp === null) return -1;
      return left.timestamp - right.timestamp || left.index - right.index;
    })
    .map(({ message }) => message);
}

function paginateHistory(messages, limit, offset) {
  const normalizedOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const normalizedLimit = limit == null
    ? null
    : (Number.isInteger(limit) && limit >= 0 ? limit : null);
  const total = messages.length;

  if (
    total === 0
    || normalizedOffset >= total
    || normalizedLimit === 0
  ) {
    return {
      messages: [],
      total,
      hasMore: normalizedLimit === 0 && normalizedOffset < total,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  if (normalizedLimit === null) {
    return {
      messages,
      total,
      hasMore: false,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }

  const startIndex = Math.max(0, total - normalizedOffset - normalizedLimit);
  return {
    messages: messages.slice(startIndex, startIndex + normalizedLimit),
    total,
    hasMore: startIndex > 0,
    offset: normalizedOffset,
    limit: normalizedLimit,
  };
}

function mergeLegacyClaudeHistory({
  dbMessages,
  jsonlMessages,
  limit,
  offset,
}) {
  const legacyCutoff = dbMessages.reduce((latest, message) => {
    const timestamp = getMessageTimestampMs(message);
    return timestamp === null ? latest : Math.max(latest, timestamp);
  }, Number.NEGATIVE_INFINITY);

  if (!Number.isFinite(legacyCutoff)) {
    console.warn(
      '[SessionHistory] Legacy Claude DB messages have no valid timestamp; '
      + 'using the DB history to avoid duplicate or expanded JSONL messages',
    );
    return paginateHistory(dbMessages, limit, offset);
  }

  const newJsonlMessages = jsonlMessages.filter((message) => {
    const timestamp = getMessageTimestampMs(message);
    return timestamp !== null && timestamp > legacyCutoff;
  });

  return paginateHistory([...dbMessages, ...newJsonlMessages], limit, offset);
}

export function shouldSuppressLiveUserTextMessage(message, writer) {
  const content = getMessageContent(message).trimStart();
  const isTaskNotification = /^<task-notification\b/i.test(content);

  return (
    message?.kind === 'text'
    && message?.role === 'user'
    && writer?.isBackgroundTaskWriter !== true
    && !isTaskNotification
  );
}

export function createSessionMessageHistoryService({
  multitenancy = multitenancyDb,
  providerSessions = null,
  hookConfigs = hookConfigService,
} = {}) {
  return {
    async fetchHistory({
      tenantId,
      userId,
      provider,
      providerSessionId,
      ownedSession,
      limit = null,
      offset = 0,
    }) {
      if (provider === 'claude') {
        const historyLookup = {
          tenantId,
          userId,
          workspaceId: ownedSession.workspace_id,
          provider,
          providerSessionId,
        };
        const dbHistory = multitenancy.sessionMessages.listMessages({
          ...historyLookup,
          limit: null,
          offset: 0,
        });
        const hiddenHookExecutionPrefixes = new Set();
        const historicalHookActivities = listHistoricalHookActivities({
          hookConfigs,
          providerSessionId,
          userId,
          workspaceId: ownedSession.workspace_id,
          tenantId,
          hiddenHookExecutionPrefixes,
        });
        const visibilityByHookId = new Map();
        const hiddenHookActivityIds = new Set();
        const persistedHookActivities = dbHistory.messages.filter(isClaudeSyntheticMessage);
        const visiblePersistedHookActivities = persistedHookActivities.filter((message) => {
          const visible = isHookActivityVisible(
            message,
            hookConfigs,
            userId,
            visibilityByHookId,
            ownedSession.workspace_id,
            tenantId,
          );
          if (!visible) {
            const identity = getHookActivityIdentity(message);
            if (identity) hiddenHookActivityIds.add(identity);
          }
          return visible;
        });
        const syntheticMessages = mergeClaudeSyntheticMessages(
          visiblePersistedHookActivities,
          historicalHookActivities,
        );
        const transcriptDbMessages = dbHistory.messages.filter((message) => !isClaudeSyntheticMessage(message));
        const runtimeLookup = {
          ...historyLookup,
        };
        const runtime = multitenancy.runtimes?.findByProviderSession?.(runtimeLookup)
          || multitenancy.runtimes?.findByOwner?.({
            tenantId,
            userId,
            workspaceId: ownedSession.workspace_id,
            provider,
            workspaceHostPath: ownedSession.workspace_path || undefined,
          });

        if (runtime?.runtime_home_path && providerSessions) {
          const scheduledSession = isScheduledSession(ownedSession);
          const legacyScheduledSkillInvocations = scheduledSession
            ? transcriptDbMessages.filter(isScheduledSlashInvocation)
            : [];
          const shouldMergeScheduledSkills = legacyScheduledSkillInvocations.length > 0;
          const needsFullJsonlHistory = hiddenHookActivityIds.size > 0
            || hiddenHookExecutionPrefixes.size > 0
            || syntheticMessages.length > 0
            || shouldMergeScheduledSkills
            || (!scheduledSession && transcriptDbMessages.length > 0);
          const jsonlHistory = await providerSessions.fetchHistory(provider, providerSessionId, {
            projectName: ownedSession.workspace_slug || '',
            projectPath: ownedSession.workspace_path || '',
            runtimeHomePath: runtime.runtime_home_path,
            limit: (
              !needsFullJsonlHistory
              && (scheduledSession || transcriptDbMessages.length === 0)
            ) ? limit : null,
            offset: (
              !needsFullJsonlHistory
              && (scheduledSession || transcriptDbMessages.length === 0)
            ) ? offset : 0,
          });
          if (jsonlHistory.total > 0) {
            const visibleJsonlMessages = omitHiddenHookRecoveryMessages(
              jsonlHistory.messages,
              hiddenHookActivityIds,
              hiddenHookExecutionPrefixes,
            );
            let transcriptHistory;
            if (shouldMergeScheduledSkills) {
              transcriptHistory = mergeLegacyScheduledSkillInvocations(
                visibleJsonlMessages,
                legacyScheduledSkillInvocations,
              );
            } else if (scheduledSession || transcriptDbMessages.length === 0) {
              if (syntheticMessages.length === 0) {
                return hiddenHookActivityIds.size > 0 || hiddenHookExecutionPrefixes.size > 0
                  ? paginateHistory(visibleJsonlMessages, limit, offset)
                  : jsonlHistory;
              }
              transcriptHistory = visibleJsonlMessages;
            } else {
              const mergedLegacyHistory = mergeLegacyClaudeHistory({
                dbMessages: transcriptDbMessages,
                jsonlMessages: visibleJsonlMessages,
                limit: syntheticMessages.length > 0 ? null : limit,
                offset: syntheticMessages.length > 0 ? 0 : offset,
              });
              if (syntheticMessages.length === 0) {
                return mergedLegacyHistory;
              }
              transcriptHistory = mergedLegacyHistory.messages;
            }

            if (syntheticMessages.length === 0) {
              return paginateHistory(transcriptHistory, limit, offset);
            }
            return paginateHistory(
              mergeClaudeSyntheticMessages(transcriptHistory, syntheticMessages),
              limit,
              offset,
            );
          }
        }

        // Transitional fallback for legacy sessions whose runtime home or JSONL
        // was removed before runtime-aware history was introduced.
        return paginateHistory(
          mergeClaudeSyntheticMessages(transcriptDbMessages, syntheticMessages),
          limit,
          offset,
        );
      }

      const dbHistory = multitenancy.sessionMessages.listMessages({
        tenantId,
        userId,
        workspaceId: ownedSession.workspace_id,
        provider,
        providerSessionId,
        limit,
        offset,
      });

      if (dbHistory.total > 0) {
        return dbHistory;
      }

      if (!providerSessions) {
        throw new Error('providerSessions is required when DB history is empty');
      }

      return providerSessions.fetchHistory(provider, providerSessionId, {
        projectName: ownedSession.workspace_slug || '',
        projectPath: ownedSession.workspace_path || '',
        workspaceId: ownedSession.workspace_id,
        limit,
        offset,
      });
    },
  };
}

export function persistNormalizedMessages({
  multitenancy = multitenancyDb,
  options = {},
  provider,
  providerSessionId,
  runtimeId,
  messages,
}) {
  // Claude Code persists its canonical transcript in runtime JSONL. Synthetic
  // CCUI-only events still need the database so they survive a page refresh.
  const candidateMessages = provider === 'claude'
    ? messages?.filter(isClaudeSyntheticMessage)
    : messages;

  if (
    !runtimeId ||
    !options.tenantId ||
    !options.workspaceId ||
    !options.userId ||
    !Array.isArray(candidateMessages) ||
    candidateMessages.length === 0
  ) {
    return 0;
  }

  const persistableMessages = candidateMessages.filter(isPersistableMessage);
  if (persistableMessages.length === 0) {
    return 0;
  }

  return multitenancy.sessionMessages.upsertMessages({
    tenantId: options.tenantId,
    userId: options.userId,
    workspaceId: options.workspaceId,
    runtimeId,
    provider,
    providerSessionId,
    messages: persistableMessages,
  });
}

export function persistUserPromptMessage({
  multitenancy = multitenancyDb,
  options = {},
  provider,
  providerSessionId = null,
  runtimeId,
  command,
  timestamp = new Date().toISOString(),
  messageId = null,
}) {
  if (typeof command !== 'string' || command.length === 0) {
    return 0;
  }

  const message = {
    id: messageId || generateUserPromptMessageId(),
    sessionId: providerSessionId,
    timestamp,
    provider,
    kind: 'text',
    role: 'user',
    content: command,
  };

  return persistNormalizedMessages({
    multitenancy,
    options,
    provider,
    providerSessionId,
    runtimeId,
    messages: [message],
  });
}

export function bindRuntimeMessagesToProviderSession({
  multitenancy = multitenancyDb,
  runtimeId,
  providerSessionId,
  fromProviderSessionId = null,
}) {
  if (!runtimeId || !providerSessionId) return 0;
  return multitenancy.sessionMessages.bindProviderSession({
    runtimeId,
    providerSessionId,
    fromProviderSessionId,
  });
}

export const sessionMessageHistoryService = createSessionMessageHistoryService();
