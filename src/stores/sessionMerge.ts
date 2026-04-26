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

/**
 * Compute merged messages: server + realtime, deduped by id.
 * Server messages take priority (they're the persisted source of truth).
 * Realtime messages that aren't yet in server stay (in-flight streaming).
 */
export function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) return server;
  if (server.length === 0) return realtime;
  const serverIds = new Set(server.map(m => m.id));
  const extra = realtime.filter(m =>
    !serverIds.has(m.id) &&
    !server.some(serverMessage => isPersistedCopyOfOptimisticUserText(serverMessage, m))
  );
  if (extra.length === 0) return server;
  return [...server, ...extra];
}
