export interface SessionStreamSnapshot {
  id: string;
  sessionId: string;
  content: string;
  timestamp: string;
}

export interface SessionStreamAccumulator {
  appendDelta(sessionId: string, delta: string, timestamp?: string): string;
  get(sessionId: string): string;
  getSnapshot(sessionId: string): SessionStreamSnapshot | null;
  finishSnapshot(sessionId: string): SessionStreamSnapshot | null;
  finish(sessionId: string): string;
  clear(sessionId: string): void;
  clearAll(): void;
}

export function createSessionStreamAccumulator(): SessionStreamAccumulator {
  const streams = new Map<string, SessionStreamSnapshot>();
  const streamSequence = new Map<string, number>();

  const createStream = (sessionId: string, timestamp?: string): SessionStreamSnapshot => {
    const nextSequence = (streamSequence.get(sessionId) || 0) + 1;
    streamSequence.set(sessionId, nextSequence);
    return {
      id: `__streaming_${sessionId}_${nextSequence}`,
      sessionId,
      content: '',
      timestamp: timestamp || new Date().toISOString(),
    };
  };

  return {
    appendDelta(sessionId, delta, timestamp) {
      const current = streams.get(sessionId) || createStream(sessionId, timestamp);
      const next = {
        ...current,
        content: `${current.content}${delta}`,
      };
      streams.set(sessionId, next);
      return next.content;
    },

    get(sessionId) {
      return streams.get(sessionId)?.content || '';
    },

    getSnapshot(sessionId) {
      return streams.get(sessionId) || null;
    },

    finishSnapshot(sessionId) {
      const finalStream = streams.get(sessionId) || null;
      streams.delete(sessionId);
      return finalStream;
    },

    finish(sessionId) {
      const finalText = streams.get(sessionId)?.content || '';
      streams.delete(sessionId);
      return finalText;
    },

    clear(sessionId) {
      streams.delete(sessionId);
    },

    clearAll() {
      streams.clear();
      streamSequence.clear();
    },
  };
}
