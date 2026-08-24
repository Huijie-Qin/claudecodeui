const LOG_PREFIX = '[ScheduledTasks]';
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_ERROR_STACK_LENGTH = 4_000;
const LOG_LEVEL_PRIORITY = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
});

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function pruneUndefined(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined),
  );
}

function normalizeLogLevel(value) {
  const normalized = String(value || 'info').trim().toLowerCase();
  return Object.hasOwn(LOG_LEVEL_PRIORITY, normalized) ? normalized : 'info';
}

export function formatScheduledTaskError(error) {
  if (error instanceof Error) {
    return pruneUndefined({
      name: error.name || 'Error',
      message: truncate(error.message || String(error), MAX_ERROR_MESSAGE_LENGTH),
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack ? truncate(error.stack, MAX_ERROR_STACK_LENGTH) : undefined,
    });
  }

  return {
    name: 'Error',
    message: truncate(error == null ? 'Unknown error' : String(error), MAX_ERROR_MESSAGE_LENGTH),
  };
}

export function createScheduledTaskLogger({
  sink = console,
  now = () => new Date(),
  processId = process.pid,
  level = process.env.SCHEDULED_TASK_LOG_LEVEL,
  onEntry = null,
} = {}) {
  const configuredLevel = normalizeLogLevel(level);
  const threshold = LOG_LEVEL_PRIORITY[configuredLevel];

  function write(logLevel, event, details = {}) {
    if (LOG_LEVEL_PRIORITY[logLevel] > threshold) return null;

    const payload = pruneUndefined({
      timestamp: now().toISOString(),
      level: logLevel,
      event,
      processId,
      ...details,
    });
    const output = JSON.stringify(payload);
    const method = typeof sink[logLevel] === 'function'
      ? sink[logLevel]
      : sink.log;
    method.call(sink, LOG_PREFIX, output);
    if (typeof onEntry === 'function') {
      try {
        onEntry(payload);
      } catch (error) {
        const persistenceError = {
          timestamp: now().toISOString(),
          level: 'error',
          event: 'log_persistence_failed',
          processId,
          sourceEvent: event,
          error: formatScheduledTaskError(error),
        };
        const errorMethod = typeof sink.error === 'function' ? sink.error : sink.log;
        errorMethod.call(sink, LOG_PREFIX, JSON.stringify(persistenceError));
      }
    }
    return payload;
  }

  return {
    debug: (event, details) => write('debug', event, details),
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
  };
}

export const scheduledTaskLogger = createScheduledTaskLogger();
