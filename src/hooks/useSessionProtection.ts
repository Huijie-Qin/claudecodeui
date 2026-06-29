import { useCallback, useState } from 'react';

export type ProcessingSessions = Map<string, number>;

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
    if (!realSessionId) {
      return;
    }

    setActiveSessions((prev) => {
      const next = new Set<string>();
      for (const sessionId of prev) {
        if (!sessionId.startsWith('new-session-')) {
          next.add(sessionId);
        }
      }
      next.add(realSessionId);
      return next;
    });

    setProcessingSessions((prev) => {
      const next = new Map<string, number>();
      let transferredStartedAt: number | null = null;

      for (const [sessionId, startedAt] of prev) {
        if (sessionId.startsWith('new-session-')) {
          transferredStartedAt =
            transferredStartedAt === null ? startedAt : Math.min(transferredStartedAt, startedAt);
        } else {
          next.set(sessionId, startedAt);
        }
      }

      if (transferredStartedAt !== null && !next.has(realSessionId)) {
        next.set(realSessionId, transferredStartedAt);
      }

      return next;
    });
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
