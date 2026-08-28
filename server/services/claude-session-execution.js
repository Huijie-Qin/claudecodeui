function normalizeExecutionKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildClaudeSessionExecutionKey(options = {}) {
  const sessionId = normalizeExecutionKey(options.sessionId);
  if (!sessionId) return null;

  return [
    options.tenantId ?? 'tenant',
    options.workspaceId ?? 'workspace',
    options.userId ?? 'user',
    sessionId,
  ].join(':');
}

export function createClaudeSessionExecutionQueue() {
  const tails = new Map();

  return {
    async run(key, operation) {
      if (typeof operation !== 'function') {
        throw new TypeError('operation must be a function');
      }

      const normalizedKey = normalizeExecutionKey(key);
      if (!normalizedKey) {
        return operation();
      }

      const previousTail = tails.get(normalizedKey) || Promise.resolve();
      let releaseCurrent;
      const currentGate = new Promise((resolve) => {
        releaseCurrent = resolve;
      });
      const currentTail = previousTail
        .catch(() => undefined)
        .then(() => currentGate);
      tails.set(normalizedKey, currentTail);

      await previousTail.catch(() => undefined);
      try {
        return await operation();
      } finally {
        releaseCurrent();
        if (tails.get(normalizedKey) === currentTail) {
          tails.delete(normalizedKey);
        }
      }
    },

    hasPending(key) {
      const normalizedKey = normalizeExecutionKey(key);
      return Boolean(normalizedKey && tails.has(normalizedKey));
    },
  };
}
