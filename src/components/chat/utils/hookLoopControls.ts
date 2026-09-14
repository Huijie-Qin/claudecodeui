import type { HookActivityDetails } from '../types/types';

/** The persisted loop job ID, never the Hook execution or parent session ID. */
export function getCancellableHookLoopJobId(activity?: HookActivityDetails): string | undefined {
  if (!activity?.loopJobId || !['queued', 'running'].includes(activity.status)) return undefined;
  if (activity.loopStatus && !['queued', 'running'].includes(activity.loopStatus)) return undefined;
  if (activity.activityKind === 'execution') {
    return activity.agentId && activity.actionTypes?.includes('mcp_loop_run')
      ? activity.loopJobId : undefined;
  }
  return activity.actionType === 'mcp_loop_run' ? activity.loopJobId : undefined;
}
