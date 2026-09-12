const MAX_TIMER_MS = 2_147_483_000;

export function subagentHookTimeoutSeconds(hook) {
  if (hook.includeSubagents === false || hook.eventName !== 'PostToolUse') return 60;
  const loopBudget = (hook.postActions || []).reduce((total, action) => (
    action.type === 'mcp_loop_run'
      ? total + Math.max(0, Number(action.config?.maxWaitMs) || 2_700_000)
      : total
  ), 0);
  return Math.ceil(Math.min(MAX_TIMER_MS, 60_000 + loopBudget) / 1000);
}
