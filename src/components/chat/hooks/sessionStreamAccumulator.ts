export interface SessionStreamAccumulator {
  appendDelta(sessionId: string, delta: string): string;
  get(sessionId: string): string;
  finish(sessionId: string): string;
  clear(sessionId: string): void;
  clearAll(): void;
}

export function createSessionStreamAccumulator(): SessionStreamAccumulator {
  const streams = new Map<string, string>();

  return {
    appendDelta(sessionId, delta) {
      const next = `${streams.get(sessionId) || ''}${delta}`;
      streams.set(sessionId, next);
      return next;
    },

    get(sessionId) {
      return streams.get(sessionId) || '';
    },

    finish(sessionId) {
      const finalText = streams.get(sessionId) || '';
      streams.delete(sessionId);
      return finalText;
    },

    clear(sessionId) {
      streams.delete(sessionId);
    },

    clearAll() {
      streams.clear();
    },
  };
}
