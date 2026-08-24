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

export function completeClaudeTurnBoundary(session) {
  if (!session) {
    return { nextTurn: null, remainingTurns: 0, closeErrors: [] };
  }

  const queuedTurns = ensureQueuedTurns(session);
  const nextTurn = queuedTurns.shift() || null;
  const closeErrors = [];

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
