import type { PendingPermissionRequest } from '../types/types';

type MessageWithSessionIds = {
  sessionId?: unknown;
  session_id?: unknown;
};

type PermissionRequestRoutingArgs = {
  messageSessionId: string | null;
  activeViewSessionId: string | null;
  selectedSessionId: string | null;
};

export function shouldKeepPendingPermissionRequest(
  request: PendingPermissionRequest,
  selectedSessionId: string | null,
) {
  if (selectedSessionId) {
    return request.sessionId === selectedSessionId;
  }

  return !request.sessionId;
}

export function normalizeRealtimeSessionId(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function getExplicitRealtimeSessionId(message: MessageWithSessionIds) {
  return normalizeRealtimeSessionId(message.sessionId) || normalizeRealtimeSessionId(message.session_id);
}

export function resolvePermissionRequestRouting({
  messageSessionId,
  activeViewSessionId,
  selectedSessionId,
}: PermissionRequestRoutingArgs): { shouldSurface: boolean; sessionId: string | null } {
  if (messageSessionId) {
    return {
      shouldSurface: Boolean(activeViewSessionId && messageSessionId === activeViewSessionId),
      sessionId: messageSessionId,
    };
  }

  if (selectedSessionId) {
    return { shouldSurface: false, sessionId: null };
  }

  return { shouldSurface: true, sessionId: activeViewSessionId };
}
