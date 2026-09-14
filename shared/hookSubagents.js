/** Events with an equivalent callback in the child agent's own execution. */
export const SUBAGENT_INHERITABLE_EVENTS = Object.freeze([
  'Stop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);

export function canIncludeSubagents(eventName) {
  return SUBAGENT_INHERITABLE_EVENTS.includes(eventName);
}

// Previously all tool callbacks were registered session-wide, but Stop was
// never mirrored to SubagentStop. Keep immutable legacy versions behaving so.
export function getIncludeSubagentsDefault(eventName) {
  return canIncludeSubagents(eventName) && eventName !== 'Stop';
}

export function resolveIncludeSubagents(hook) {
  if (!canIncludeSubagents(hook?.eventName)) return false;
  return typeof hook.includeSubagents === 'boolean'
    ? hook.includeSubagents
    : getIncludeSubagentsDefault(hook.eventName);
}
