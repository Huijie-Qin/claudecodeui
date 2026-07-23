const VALID_SESSION_MODES = new Set(['new', 'merge']);
const SCHEDULED_TASK_TIME_ZONE = 'Asia/Shanghai';

export function resolveScheduledTaskProviderPrompt(prompt) {
  return prompt;
}

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
  const storedSessionMode = sessionMode == null || String(sessionMode).trim() === ''
    ? 'merge'
    : sessionMode;
  if (
    normalizeScheduledTaskSessionMode(storedSessionMode) !== 'merge'
    || !normalizedSessionId
    || !isResumable(normalizedSessionId)
    || !canResume(normalizedSessionId)
  ) {
    return null;
  }
  return normalizedSessionId;
}

export function formatScheduledTaskSessionTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('runStartedAt must be a valid date');
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULED_TASK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export function buildScheduledTaskRunSessionSummary({ taskName, sessionMode, runStartedAt }) {
  const storedSessionMode = sessionMode == null || String(sessionMode).trim() === ''
    ? 'merge'
    : normalizeScheduledTaskSessionMode(sessionMode);
  if (storedSessionMode === 'merge') {
    return taskName;
  }
  return `${taskName} - ${formatScheduledTaskSessionTime(runStartedAt)}`;
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
