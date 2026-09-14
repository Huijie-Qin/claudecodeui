import type { HookActivityDetails, HookFollowupActivityDetails } from '../types/types';

/** Adapt inline loop progress to the existing post-action UI, without creating
 * a persisted follow-up or scheduling a recovery turn in the main session. */
export function getHookDisplayFollowups(
  activity: HookActivityDetails | undefined,
  timestamp: HookFollowupActivityDetails['timestamp'],
): HookFollowupActivityDetails[] {
  const followups = activity?.followups || [];
  if (activity?.activityKind !== 'execution' || !activity.actionTypes?.includes('mcp_loop_run')) return followups;
  if (!activity.loopJobId && !activity.loopStatus && activity.loopResult === undefined) return followups;
  if (followups.some((followup) => followup.actionType === 'mcp_loop_run'
    && (!activity.loopJobId || followup.loopJobId === activity.loopJobId))) return followups;

  return [...followups, {
    jobId: activity.loopJobId || `${activity.executionId || activity.jobId || activity.hookId || 'hook'}_loop`,
    executionId: activity.executionId,
    actionType: 'mcp_loop_run',
    status: activity.status,
    loopJobId: activity.loopJobId,
    loopStatus: activity.loopStatus,
    loopAttemptCount: activity.loopAttemptCount,
    loopStartedAtMs: activity.loopStartedAtMs,
    loopNextPollAtMs: activity.loopNextPollAtMs,
    loopTargetTool: activity.loopTargetTool,
    loopToolUseId: activity.loopToolUseId,
    loopResult: activity.loopResult,
    timestamp: activity.loopStartedAtMs ?? timestamp,
  }];
}

export function getHookFollowupDisplayStatus(followup: HookFollowupActivityDetails) {
  if (followup.actionType === 'mcp_loop_run'
    && (followup.loopStatus === 'cancelled' || followup.loopStatus === 'timed_out' || followup.loopStatus === 'failed')) {
    return followup.loopStatus;
  }
  // A main-agent follow-up can still be running while delivering a successful
  // loop result. Keep its recovery status rather than marking it done early.
  return followup.status;
}
