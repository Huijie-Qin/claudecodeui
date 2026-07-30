import { multitenancyDb } from '../database/multitenancy-db.js';

function generateUserPromptMessageId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const TRANSIENT_MESSAGE_KINDS = new Set(['stream_delta', 'stream_end']);
const CLAUDE_INTERNAL_CONTENT_PREFIXES = [
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
          const jsonlHistory = await providerSessions.fetchHistory(provider, providerSessionId, {
            projectName: ownedSession.workspace_slug || '',
            projectPath: ownedSession.workspace_path || '',
            runtimeHomePath: runtime.runtime_home_path,
            limit: scheduledSession || dbHistory.total === 0 ? limit : null,
            offset: scheduledSession || dbHistory.total === 0 ? offset : 0,
          });
          if (jsonlHistory.total > 0) {
            if (scheduledSession || dbHistory.total === 0) {
              return jsonlHistory;
            }

            return mergeLegacyClaudeHistory({
              dbMessages: dbHistory.messages,
              jsonlMessages: jsonlHistory.messages,
              limit,
              offset,
            });
          }
        }

        // Transitional fallback for legacy sessions whose runtime home or JSONL
        // was removed before runtime-aware history was introduced.
        return paginateHistory(dbHistory.messages, limit, offset);
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
  // Claude Code already persists the canonical transcript in runtime JSONL.
  if (provider === 'claude') {
    return 0;
  }

  if (
    !runtimeId ||
    !options.tenantId ||
    !options.workspaceId ||
    !options.userId ||
    !Array.isArray(messages) ||
    messages.length === 0
  ) {
    return 0;
  }

  const persistableMessages = messages.filter(isPersistableMessage);
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
