const STREAM_STALL_PAUSE_POLL_MS = 5000;

export class StreamStalledError extends Error {
  constructor(provider, timeoutMs) {
    super(`${provider} stream stalled: no events received for ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = 'StreamStalledError';
    this.code = 'STREAM_STALLED';
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

export function readIteratorNextWithStallTimeout(iterator, {
  timeoutMs,
  provider,
  shouldPauseTimeout = () => false,
  subscribePauseChanges,
  onTimeout,
}) {
  if (!timeoutMs || timeoutMs <= 0) {
    return iterator.next();
  }

  let timer = null;
  let unsubscribe = null;
  let settled = false;
  const timeoutPromise = new Promise((_, reject) => {
    const fail = () => {
      if (shouldPauseTimeout()) return arm();
      const error = new StreamStalledError(provider, timeoutMs);
      onTimeout?.(error);
      reject(error);
    };

    const arm = () => {
      if (settled) return;
      if (timer !== null) clearTimeout(timer);
      // Human response time is not a stream stall. On resume, start a full
      // timeout; reusing the pause poll would interrupt Claude within 5s.
      timer = shouldPauseTimeout()
        ? setTimeout(arm, STREAM_STALL_PAUSE_POLL_MS)
        : setTimeout(fail, timeoutMs);
    };

    // Observe transitions as well as polling: an entire question/answer can
    // otherwise fit between checks just before the old deadline expires.
    unsubscribe = subscribePauseChanges?.(arm);
    arm();
  });

  return Promise.race([Promise.resolve().then(() => iterator.next()), timeoutPromise]).finally(() => {
    settled = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe?.();
  });
}

export function createPendingInteractionTracker() {
  const requestIds = new Set();
  const listeners = new Set();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    begin(requestId) {
      const wasPaused = requestIds.size > 0;
      requestIds.add(requestId);
      if (!wasPaused) notify();
    },
    end(requestId) {
      if (requestIds.delete(requestId) && requestIds.size === 0) notify();
    },
    isPaused() { return requestIds.size > 0; },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
