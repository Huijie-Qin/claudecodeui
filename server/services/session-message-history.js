import { multitenancyDb } from '../database/multitenancy-db.js';

function generateUserPromptMessageId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const TRANSIENT_MESSAGE_KINDS = new Set(['stream_delta', 'stream_end']);
const SCHEDULED_PROMPT_DEDUP_WINDOW_MS = 60_000;
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

function readSessionMetadata(ownedSession) {
  const metadata = ownedSession?.metadata_json;
  if (metadata && typeof metadata === 'object') {
    return metadata;
  }
  if (typeof metadata !== 'string' || !metadata.trim()) {
    return {};
  }
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

function isScheduledTaskSession(ownedSession) {
  const scheduledTaskId = Number(readSessionMetadata(ownedSession).scheduledTaskId);
  return Number.isInteger(scheduledTaskId) && scheduledTaskId > 0;
}

function readMessageTimestamp(message) {
  const timestamp = new Date(message?.timestamp || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isMatchingUserPrompt(message, candidate) {
  if (
    message?.kind !== 'text'
    || message?.role !== 'user'
    || candidate?.kind !== 'text'
    || candidate?.role !== 'user'
    || String(message.content || '').trim() !== String(candidate.content || '').trim()
  ) {
    return false;
  }

  const messageTimestamp = readMessageTimestamp(message);
  const candidateTimestamp = readMessageTimestamp(candidate);
  return (
    messageTimestamp > 0
    && candidateTimestamp > 0
    && Math.abs(messageTimestamp - candidateTimestamp) <= SCHEDULED_PROMPT_DEDUP_WINDOW_MS
  );
}

function mergeScheduledTaskPrompts(jsonlMessages, databaseMessages) {
  const merged = Array.isArray(jsonlMessages) ? [...jsonlMessages] : [];
  const fallbackPrompts = Array.isArray(databaseMessages)
    ? databaseMessages.filter((message) => message?.kind === 'text' && message?.role === 'user')
    : [];

  for (const prompt of fallbackPrompts) {
    if (!merged.some((message) => isMatchingUserPrompt(message, prompt))) {
      merged.push(prompt);
    }
  }

  return merged
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const timestampDelta = readMessageTimestamp(left.message) - readMessageTimestamp(right.message);
      return timestampDelta || left.index - right.index;
    })
    .map(({ message }) => message);
}

function paginateMessages(messages, limit, offset) {
  const total = messages.length;
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  if (limit == null) {
    return {
      messages,
      total,
      hasMore: false,
      offset: 0,
      limit: null,
    };
  }

  const normalizedLimit = Math.max(0, Number(limit) || 0);
  const startIndex = Math.max(0, total - normalizedOffset - normalizedLimit);
  const endIndex = Math.max(0, total - normalizedOffset);
  return {
    messages: messages.slice(startIndex, endIndex),
    total,
    hasMore: startIndex > 0,
    offset: normalizedOffset,
    limit: normalizedLimit,
  };
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
        const runtimeLookup = {
          tenantId,
          userId,
          workspaceId: ownedSession.workspace_id,
          provider,
          providerSessionId,
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
          const scheduledTaskSession = isScheduledTaskSession(ownedSession);
          const jsonlHistory = await providerSessions.fetchHistory(provider, providerSessionId, {
            projectName: ownedSession.workspace_slug || '',
            projectPath: ownedSession.workspace_path || '',
            runtimeHomePath: runtime.runtime_home_path,
            limit: scheduledTaskSession ? null : limit,
            offset: scheduledTaskSession ? 0 : offset,
          });
          if (jsonlHistory.total > 0) {
            if (scheduledTaskSession) {
              const databaseHistory = multitenancy.sessionMessages.listMessages({
                tenantId,
                userId,
                workspaceId: ownedSession.workspace_id,
                provider,
                providerSessionId,
                limit: null,
                offset: 0,
              });
              const mergedMessages = mergeScheduledTaskPrompts(
                jsonlHistory.messages,
                databaseHistory.messages,
              );
              return paginateMessages(mergedMessages, limit, offset);
            }
            return jsonlHistory;
          }
        }

        // Transitional fallback for legacy sessions whose runtime home or JSONL
        // was removed before runtime-aware history was introduced.
        return multitenancy.sessionMessages.listMessages({
          tenantId,
          userId,
          workspaceId: ownedSession.workspace_id,
          provider,
          providerSessionId,
          limit,
          offset,
        });
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
  allowClaudeMessages = false,
}) {
  // Claude Code already persists the canonical transcript in runtime JSONL.
  // Only callers with an explicit fallback need a second durable message.
  if (provider === 'claude' && !allowClaudeMessages) {
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
    allowClaudeMessages: provider === 'claude' && options.backgroundTask === true,
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
