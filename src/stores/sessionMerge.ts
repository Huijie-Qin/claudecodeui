import type { NormalizedMessage } from './useSessionStore';

const OPTIMISTIC_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

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
  if (serverMessage.sessionId !== realtimeMessage.sessionId) return false;
  if (serverMessage.provider !== realtimeMessage.provider) return false;
  if (typeof serverMessage.content !== 'string') return false;
  if (serverMessage.content.trim() !== realtimeMessage.content?.trim()) return false;

  const serverTime = new Date(serverMessage.timestamp).getTime();
  const realtimeTime = new Date(realtimeMessage.timestamp).getTime();
  if (!Number.isFinite(serverTime) || !Number.isFinite(realtimeTime)) return false;

  return Math.abs(serverTime - realtimeTime) <= OPTIMISTIC_USER_DEDUPE_WINDOW_MS;
}

function getMessageTime(message: NormalizedMessage): number | null {
  const time = new Date(message.timestamp).getTime();
  return Number.isFinite(time) ? time : null;
}

function isStreamingPlaceholder(message: NormalizedMessage): boolean {
  return message.kind === 'stream_delta' && message.id === `__streaming_${message.sessionId}`;
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
 * Server messages take priority (they're the persisted source of truth).
 * Realtime messages that aren't yet in server stay (in-flight streaming).
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  const realtimeUnique = dropSupersededStreamingPlaceholders(dedupeRealtimeMessages(realtime));
  if (realtimeUnique.length === 0) return server;
  if (server.length === 0) return realtimeUnique;
  const serverIds = new Set(server.map(m => m.id));
  const extra = realtimeUnique.filter(m =>
    !serverIds.has(m.id) &&
    !server.some(serverMessage => isPersistedCopyOfOptimisticUserText(serverMessage, m))
  );
  if (extra.length === 0) return server;
  return extra.reduce(insertByTimestamp, server);
}
