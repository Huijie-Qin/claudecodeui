// A native MCP permission request (including a PreToolUse `ask`) must reach
// the user even when normal calls use bypassPermissions. Each approval covers
// only the displayed input for this invocation; it cannot save an allow rule.
export function resolveMcpToolConfirmation(decision, input) {
  if (!decision) return { behavior: 'deny', message: 'Tool interaction timed out' };
  if (decision.cancelled) return { behavior: 'deny', message: 'Tool interaction cancelled' };
  if (decision.allow !== true) {
    return { behavior: 'deny', message: decision.message || 'User declined tool interaction' };
  }
  return { behavior: 'allow', updatedInput: input };
}
