export interface SessionStreamSnapshot {
  id: string;
  sessionId: string;
  content: string;
  timestamp: string;
  parentToolUseId?: string;
}

export interface SessionStreamAccumulator {
  appendDelta(sessionId: string, delta: string, timestamp?: string, parentToolUseId?: string): string;
  get(sessionId: string, parentToolUseId?: string): string;
  getSnapshot(sessionId: string, parentToolUseId?: string): SessionStreamSnapshot | null;
  drainSnapshots(): SessionStreamSnapshot[];
  finishSnapshot(sessionId: string, parentToolUseId?: string): SessionStreamSnapshot | null;
  finishSessionSnapshots(sessionId: string): SessionStreamSnapshot[];
  finish(sessionId: string, parentToolUseId?: string): string;
  clear(sessionId: string, parentToolUseId?: string): void;
  clearSession(sessionId: string): void;
  clearAll(): void;
}

export function createSessionStreamAccumulator(): SessionStreamAccumulator {
  const streams = new Map<string, SessionStreamSnapshot>();
  const streamSequence = new Map<string, number>();

  const scopeKey = (sessionId: string, parentToolUseId?: string) => (
    `${sessionId}\u0000${parentToolUseId || ''}`
  );

  const createStream = (
    sessionId: string,
    timestamp?: string,
    parentToolUseId?: string,
  ): SessionStreamSnapshot => {
    const key = scopeKey(sessionId, parentToolUseId);
    const nextSequence = (streamSequence.get(key) || 0) + 1;
    streamSequence.set(key, nextSequence);
    return {
      id: parentToolUseId
        ? `__streaming_${sessionId}_${parentToolUseId}_${nextSequence}`
        : `__streaming_${sessionId}_${nextSequence}`,
      sessionId,
      content: '',
      timestamp: timestamp || new Date().toISOString(),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    };
  };

  return {
    appendDelta(sessionId, delta, timestamp, parentToolUseId) {
      const key = scopeKey(sessionId, parentToolUseId);
      const current = streams.get(key) || createStream(sessionId, timestamp, parentToolUseId);
      const next = {
        ...current,
        content: `${current.content}${delta}`,
      };
      streams.set(key, next);
      return next.content;
    },

    get(sessionId, parentToolUseId) {
      return streams.get(scopeKey(sessionId, parentToolUseId))?.content || '';
    },

    getSnapshot(sessionId, parentToolUseId) {
      return streams.get(scopeKey(sessionId, parentToolUseId)) || null;
    },

    drainSnapshots() {
      const snapshots = Array.from(streams.values());
      streams.clear();
      return snapshots;
    },

    finishSnapshot(sessionId, parentToolUseId) {
      const key = scopeKey(sessionId, parentToolUseId);
      const finalStream = streams.get(key) || null;
      streams.delete(key);
      return finalStream;
    },

    finishSessionSnapshots(sessionId) {
      const snapshots = [...streams.entries()]
        .filter(([, snapshot]) => snapshot.sessionId === sessionId)
        .map(([key, snapshot]) => {
          streams.delete(key);
          return snapshot;
        });
      return snapshots;
    },

    finish(sessionId, parentToolUseId) {
      const key = scopeKey(sessionId, parentToolUseId);
      const finalText = streams.get(key)?.content || '';
      streams.delete(key);
      return finalText;
    },

    clear(sessionId, parentToolUseId) {
      streams.delete(scopeKey(sessionId, parentToolUseId));
    },

    clearSession(sessionId) {
      for (const [key, snapshot] of streams) {
        if (snapshot.sessionId === sessionId) streams.delete(key);
      }
    },

    clearAll() {
      streams.clear();
      streamSequence.clear();
    },
  };
}
