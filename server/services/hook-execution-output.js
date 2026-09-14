const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|(?:api|auth|user|access|private)[_-]?key/i;

// Stored audit values are already redacted at execution time. Apply a second
// read-side pass for older records; never expose the input, environment or code.
export function redactHookExecutionOutput(value, depth = 0) {
  if (depth > 20) return '[depth limit]';
  if (Array.isArray(value)) return value.map((entry) => redactHookExecutionOutput(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, SENSITIVE_KEY.test(key) ? '[redacted]' : redactHookExecutionOutput(entry, depth + 1),
    ]));
  }
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return JSON.stringify(redactHookExecutionOutput(parsed, depth + 1));
  } catch { /* Plain text, not a JSON-encoded result. */ }
  return value
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/((?:[\w-]*(?:password|secret|token|credential)|(?:api|auth|user|access|private)[_-]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]');
}

export function userHookExecutionOutput(execution) {
  const { id, hookId, hookName, hookVersion, eventName, status, durationMs, startedAtMs, completedAtMs } = execution;
  return {
    id, hookId, hookName, hookVersion, eventName, status, durationMs, startedAtMs, completedAtMs,
    scriptOutput: redactHookExecutionOutput(execution.scriptOutput),
    response: redactHookExecutionOutput(execution.response),
    errorMessage: redactHookExecutionOutput(execution.errorMessage),
  };
}
