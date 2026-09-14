export function getHookProcessVisibility({
  isExecution, hasPostActions, showScriptPreference, hasExecutionContext,
}: {
  isExecution: boolean;
  hasPostActions: boolean;
  showScriptPreference: boolean;
  hasExecutionContext: boolean;
}) {
  const showScript = isExecution && showScriptPreference && hasExecutionContext;
  const showPostActions = isExecution && hasPostActions;
  return { showProcess: showScript || showPostActions, showScript, showPostActions };
}
