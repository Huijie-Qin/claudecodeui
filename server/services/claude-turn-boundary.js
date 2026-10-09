function ensureQueuedTurns(session) {
  if (!Array.isArray(session.queuedTurns)) {
    session.queuedTurns = [];
  }
  return session.queuedTurns;
}

export function enqueueClaudeFollowupTurn(session, turn) {
  if (!session || !turn || typeof turn.content !== 'string' || !turn.content.trim()) {
    throw new Error('An active Claude session and non-empty follow-up content are required');
  }

  const queuedTurns = ensureQueuedTurns(session);
  queuedTurns.push({ ...turn });
  return queuedTurns.length;
}

export function captureClaudeStopHookBoundary(inputQueue, event) {
  if (event?.hook_event_name !== 'Stop' || event.agent_id) return null;

  const inputRevision = inputQueue.inputRevision;
  return {
    inputRevision,
    // Stop runs before the current query's result decrements its count. Any
    // extra query, or an input added while a Hook awaited work, invalidates it.
    isCurrent: () => inputQueue.pendingQueryTurns <= 1
      && inputQueue.inputRevision === inputRevision,
  };
}

export function completeClaudeTurnBoundary(session) {
  if (!session) {
    return { nextTurn: null, remainingTurns: 0, closeErrors: [] };
  }

  const queuedTurns = ensureQueuedTurns(session);
  const closeErrors = [];
  let nextTurn = null;
  while (queuedTurns.length > 0) {
    const candidate = queuedTurns.shift();
    if (candidate.isCurrent?.() !== false) {
      nextTurn = candidate;
      break;
    }
    try {
      candidate.onDiscard?.();
    } catch (error) {
      closeErrors.push(error);
    }
  }

  try {
    session.inputQueue?.close?.();
  } catch (error) {
    closeErrors.push(error);
  }

  try {
    session.instance?.close?.();
  } catch (error) {
    closeErrors.push(error);
  }

  session.status = nextTurn ? 'transitioning' : 'idle';
  return {
    nextTurn,
    remainingTurns: queuedTurns.length,
    closeErrors,
  };
}
