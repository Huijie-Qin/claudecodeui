const VALID_SESSION_MODES = new Set(['new', 'merge']);

export function normalizeScheduledTaskSessionMode(sessionMode) {
  const normalized = String(sessionMode || 'new').trim().toLowerCase();
  if (!VALID_SESSION_MODES.has(normalized)) {
    const error = new Error('sessionMode must be one of new, merge');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

export function resolveScheduledTaskResumeSession({
  sessionMode,
  sessionId,
  isResumable = () => true,
  canResume = () => true,
}) {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (
    normalizeScheduledTaskSessionMode(sessionMode) !== 'merge'
    || !normalizedSessionId
    || !isResumable(normalizedSessionId)
    || !canResume(normalizedSessionId)
  ) {
    return null;
  }
  return normalizedSessionId;
}

export function sanitizeScheduledTaskEvent({ data, displayPrompt, modelPrompt }) {
  if (
    !data
    || data.role !== 'user'
    || typeof data.content !== 'string'
    || typeof displayPrompt !== 'string'
    || typeof modelPrompt !== 'string'
    || data.content.trim() !== modelPrompt.trim()
  ) {
    return data;
  }

  return { ...data, content: displayPrompt };
}
