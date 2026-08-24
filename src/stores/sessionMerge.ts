import type { NormalizedMessage } from './useSessionStore';

const OPTIMISTIC_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const OPTIMISTIC_USER_CLOCK_SKEW_MS = 2_000;
const FINALIZED_STREAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const HOOK_ACTIVITY_STATUS_RANK: Record<string, number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
};

export function upsertRealtimeMessages(
  current: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const updated = [...current];
  for (const message of incoming) {
    const existingIndex = updated.findIndex((candidate) => candidate.id === message.id);
    if (existingIndex >= 0) {
      const existing = updated[existingIndex];
      if (existing.queueStatus === 'queued' && message.queueStatus === 'processing') {
        updated.splice(existingIndex, 1);
        updated.push(message);
      } else {
        updated[existingIndex] = message;
      }
    } else {
      updated.push(message);
    }
  }
  return updated;
}

function pinQueuedUserMessagesToEnd(messages: NormalizedMessage[]): NormalizedMessage[] {
  const queued = messages.filter(message =>
    message.kind === 'text' &&
    message.role === 'user' &&
    message.queueStatus === 'queued'
  );
  if (queued.length === 0) return messages;

  const queuedIds = new Set(queued.map(message => message.id));
  const settled = messages.filter(message => !queuedIds.has(message.id));
  return [...settled, ...queued];
}

function shouldUseRealtimeHookActivity(
  serverMessage: NormalizedMessage,
  realtimeMessage: NormalizedMessage,
): boolean {
  if (serverMessage.kind !== 'hook_activity' || realtimeMessage.kind !== 'hook_activity') return false;
  const serverRank = HOOK_ACTIVITY_STATUS_RANK[serverMessage.status || ''] ?? -1;
  const realtimeRank = HOOK_ACTIVITY_STATUS_RANK[realtimeMessage.status || ''] ?? -1;
  return realtimeRank >= serverRank;
}

function isRealtimeHookActivityAhead(
  serverMessage: NormalizedMessage,
  realtimeMessage: NormalizedMessage,
): boolean {
  if (serverMessage.kind !== 'hook_activity' || realtimeMessage.kind !== 'hook_activity') return false;
  const serverRank = HOOK_ACTIVITY_STATUS_RANK[serverMessage.status || ''] ?? -1;
  const realtimeRank = HOOK_ACTIVITY_STATUS_RANK[realtimeMessage.status || ''] ?? -1;
  return realtimeRank > serverRank;
}

function applySameIdRealtimeLifecycleUpdates(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
): NormalizedMessage[] {
  const realtimeById = new Map(realtime.map(message => [message.id, message]));
  let changed = false;
  const merged = server.map((serverMessage) => {
    const realtimeMessage = realtimeById.get(serverMessage.id);
    if (!realtimeMessage || !shouldUseRealtimeHookActivity(serverMessage, realtimeMessage)) {
      return serverMessage;
    }
    changed = true;
    return realtimeMessage;
  });
  return changed ? merged : server;
}

function isLocalOptimisticUserText(message: NormalizedMessage): boolean {
  return message.id.startsWith('local_') &&
    message.kind === 'text' &&
    message.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0;
}

function isPersistedCopyOfOptimisticUserText(
  serverMessage: NormalizedMessage,
  realtimeMessage: NormalizedMessage,
): boolean {
  if (!isLocalOptimisticUserText(realtimeMessage)) return false;
  if (serverMessage.kind !== 'text' || serverMessage.role !== 'user') return false;
  if (serverMessage.provider !== realtimeMessage.provider) return false;
  if (typeof serverMessage.content !== 'string') return false;
  if (serverMessage.content.trim() !== realtimeMessage.content?.trim()) return false;

  const sameSession = serverMessage.sessionId === realtimeMessage.sessionId;
  const pendingNewSessionPrompt = serverMessage.id.startsWith('user_');
  if (!sameSession && !pendingNewSessionPrompt) return false;

  const serverTime = new Date(serverMessage.timestamp).getTime();
  const realtimeTime = new Date(realtimeMessage.timestamp).getTime();
  if (!Number.isFinite(serverTime) || !Number.isFinite(realtimeTime)) return false;

  if (serverTime + OPTIMISTIC_USER_CLOCK_SKEW_MS < realtimeTime) return false;

  return Math.abs(serverTime - realtimeTime) <= OPTIMISTIC_USER_DEDUPE_WINDOW_MS;
}

function isFinalizedStreamingAssistantText(message: NormalizedMessage): boolean {
  return message.id.startsWith('text_') &&
    message.kind === 'text' &&
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0;
}

function isPersistedCopyOfFinalizedStream(
  serverMessage: NormalizedMessage,
  realtimeMessage: NormalizedMessage,
): boolean {
  if (!isFinalizedStreamingAssistantText(realtimeMessage)) return false;
  if (serverMessage.kind !== 'text' || serverMessage.role !== 'assistant') return false;
  if (serverMessage.sessionId !== realtimeMessage.sessionId) return false;
  if (serverMessage.provider !== realtimeMessage.provider) return false;
  if (serverMessage.content?.trim() !== realtimeMessage.content?.trim()) return false;

  const serverTime = getMessageTime(serverMessage);
  const realtimeTime = getMessageTime(realtimeMessage);
  if (serverTime === null || realtimeTime === null) return false;

  return Math.abs(serverTime - realtimeTime) <= FINALIZED_STREAM_DEDUPE_WINDOW_MS;
}

function isPersistedRealtimeCopy(
  serverMessage: NormalizedMessage,
  realtimeMessage: NormalizedMessage,
): boolean {
  return isPersistedCopyOfOptimisticUserText(serverMessage, realtimeMessage) ||
    isPersistedCopyOfFinalizedStream(serverMessage, realtimeMessage);
}

function dropPersistedRealtimeCopies(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
  serverIds: Set<string>,
): NormalizedMessage[] {
  const claimedServerIndexes = new Set<number>();
  const extra: NormalizedMessage[] = [];

  for (const realtimeMessage of realtime) {
    if (serverIds.has(realtimeMessage.id)) {
      continue;
    }

    let matchedServerIndex = -1;
    let closestTimeDelta = Number.POSITIVE_INFINITY;

    for (let serverIndex = 0; serverIndex < server.length; serverIndex++) {
      if (claimedServerIndexes.has(serverIndex)) {
        continue;
      }

      const serverMessage = server[serverIndex];
      if (!isPersistedCopyOfOptimisticUserText(serverMessage, realtimeMessage)) {
        continue;
      }

      const serverTime = new Date(serverMessage.timestamp).getTime();
      const realtimeTime = new Date(realtimeMessage.timestamp).getTime();
      const timeDelta = Math.abs(serverTime - realtimeTime);
      if (timeDelta < closestTimeDelta) {
        matchedServerIndex = serverIndex;
        closestTimeDelta = timeDelta;
      }
    }

    if (matchedServerIndex >= 0) {
      claimedServerIndexes.add(matchedServerIndex);
      continue;
    }

    extra.push(realtimeMessage);
  }

  return extra;
}

function getMessageTime(message: NormalizedMessage): number | null {
  const time = new Date(message.timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

function isStreamingPlaceholder(message: NormalizedMessage): boolean {
  return message.kind === 'stream_delta' && message.id.startsWith('__streaming_');
}

function isAssistantText(message: NormalizedMessage): boolean {
  return message.kind === 'text' && message.role === 'assistant';
}

function isSupersedingAssistantText(
  message: NormalizedMessage,
  streamingPlaceholder: NormalizedMessage,
): boolean {
  if (!isAssistantText(message)) return false;
  if (message.sessionId !== streamingPlaceholder.sessionId) return false;
  if (message.provider !== streamingPlaceholder.provider) return false;

  const messageTime = getMessageTime(message);
  const streamTime = getMessageTime(streamingPlaceholder);
  if (messageTime === null || streamTime === null) return true;

  return messageTime >= streamTime;
}

function dropSupersededStreamingPlaceholders(messages: NormalizedMessage[]): NormalizedMessage[] {
  const filtered = messages.filter((message) => {
    if (!isStreamingPlaceholder(message)) return true;
    return !messages.some(candidate => isSupersedingAssistantText(candidate, message));
  });

  return filtered.length === messages.length ? messages : filtered;
}

function insertByTimestamp(
  messages: NormalizedMessage[],
  message: NormalizedMessage,
): NormalizedMessage[] {
  const messageTime = getMessageTime(message);
  if (messageTime === null) {
    return [...messages, message];
  }

  const insertIndex = messages.findIndex((existing) => {
    const existingTime = getMessageTime(existing);
    return existingTime !== null && existingTime > messageTime;
  });

  if (insertIndex === -1) {
    return [...messages, message];
  }

  return [
    ...messages.slice(0, insertIndex),
    message,
    ...messages.slice(insertIndex),
  ];
}

function getRealtimeDedupeKey(message: NormalizedMessage): string {
  if (isLocalOptimisticUserText(message)) {
    return [
      'optimistic-user',
      message.sessionId,
      message.provider,
      message.timestamp,
      message.content?.trim(),
    ].join(':');
  }

  return `id:${message.id}`;
}

function dedupeRealtimeMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set<string>();
  const deduped: NormalizedMessage[] = [];

  for (const message of messages) {
    const key = getRealtimeDedupeKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(message);
  }

  return deduped;
}

/**
 * Compute merged messages: server + realtime, deduped by id.
 * Persisted messages normally take priority. Same-id Hook activity lifecycle
 * updates are the exception: a newer realtime state must remain visible while
 * the asynchronously persisted copy is still queued or running.
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  const realtimeUnique = dropSupersededStreamingPlaceholders(dedupeRealtimeMessages(realtime));
  if (realtimeUnique.length === 0) return server;
  if (server.length === 0) return pinQueuedUserMessagesToEnd(realtimeUnique);
  const serverWithLifecycleUpdates = applySameIdRealtimeLifecycleUpdates(server, realtimeUnique);
  const serverIds = new Set(serverWithLifecycleUpdates.map(m => m.id));
  const extra = dropPersistedRealtimeCopies(serverWithLifecycleUpdates, realtimeUnique, serverIds);
  if (extra.length === 0) return serverWithLifecycleUpdates;
  return pinQueuedUserMessagesToEnd(extra.reduce(insertByTimestamp, serverWithLifecycleUpdates));
}

/**
 * Remove only realtime messages that are already represented in a freshly
 * fetched server history. Messages that have not been persisted yet must stay
 * visible; clearing the whole realtime buffer here races the provider's JSONL
 * write at the end of a stream.
 */
export function reconcileRealtimeAfterServerRefresh(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtime.length === 0 || server.length === 0) return realtime;

  const serverIds = new Set(server.map(message => message.id));
  const claimedServerIndexes = new Set<number>();

  return realtime.filter((realtimeMessage) => {
    if (serverIds.has(realtimeMessage.id)) {
      const serverMessage = server.find(message => message.id === realtimeMessage.id);
      return Boolean(serverMessage && isRealtimeHookActivityAhead(serverMessage, realtimeMessage));
    }

    for (let serverIndex = 0; serverIndex < server.length; serverIndex++) {
      if (claimedServerIndexes.has(serverIndex)) continue;
      if (!isPersistedRealtimeCopy(server[serverIndex], realtimeMessage)) continue;

      claimedServerIndexes.add(serverIndex);
      return false;
    }

    return true;
  });
}
