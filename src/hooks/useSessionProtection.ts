import { useCallback, useState } from 'react';

export type ProcessingSessions = Map<string, number>;

const isTemporarySessionId = (sessionId: string) => sessionId.startsWith('new-session-');

export function replaceTemporaryActiveSessionIds(
  sessions: Set<string>,
  realSessionId?: string | null,
) {
  if (!realSessionId) {
    return sessions;
  }

  const next = new Set<string>();
  let foundTemporarySession = false;

  for (const sessionId of sessions) {
    if (isTemporarySessionId(sessionId)) {
      foundTemporarySession = true;
    } else {
      next.add(sessionId);
    }
  }

  if (!foundTemporarySession) {
    return sessions;
  }

  next.add(realSessionId);
  return next;
}

export function replaceTemporaryProcessingSessions(
  sessions: ProcessingSessions,
  realSessionId?: string | null,
) {
  if (!realSessionId) {
    return sessions;
  }

  const next = new Map<string, number>();
  let transferredStartedAt: number | null = null;

  for (const [sessionId, startedAt] of sessions) {
    if (isTemporarySessionId(sessionId)) {
      transferredStartedAt =
        transferredStartedAt === null ? startedAt : Math.min(transferredStartedAt, startedAt);
    } else {
      next.set(sessionId, startedAt);
    }
  }

  if (transferredStartedAt === null) {
    return sessions;
  }

  if (!next.has(realSessionId)) {
    next.set(realSessionId, transferredStartedAt);
  }

  return next;
}

export function useSessionProtection() {
  const [activeSessions, setActiveSessions] = useState<Set<string>>(new Set());
  const [processingSessions, setProcessingSessions] = useState<ProcessingSessions>(new Map());

  const markSessionAsActive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const markSessionAsInactive = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const markSessionAsProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const next = new Map(prev);
      if (!next.has(sessionId)) {
        next.set(sessionId, Date.now());
      }
      return next;
    });
  }, []);

  const markSessionAsNotProcessing = useCallback((sessionId?: string | null) => {
    if (!sessionId) {
      return;
    }

    setProcessingSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const replaceTemporarySession = useCallback((realSessionId?: string | null) => {
    setActiveSessions((prev) => replaceTemporaryActiveSessionIds(prev, realSessionId));
    setProcessingSessions((prev) => replaceTemporaryProcessingSessions(prev, realSessionId));
  }, []);

  return {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  };
}
