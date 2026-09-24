import type { HookActivityDetails, HookActivityStatus, HookFollowupActivityDetails } from '../types/types';

type HookDisplayStatus = HookActivityStatus | 'timed_out' | 'cancelled' | 'unconfirmed';

export type HookExecutionDisplayState = {
  status: HookDisplayStatus;
  phase?: 'loop_queued' | 'loop_running' | 'agent_continuing' | 'loop_resume_unconfirmed';
};

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
    loopResumeStatus: activity.loopResumeStatus,
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
  if (followup.actionType === 'mcp_loop_run') {
    if (followup.loopResumeStatus === 'unconfirmed' && followup.loopStatus === 'succeeded') {
      return 'unconfirmed';
    }
    if (followup.loopStatus === 'cancelled' || followup.loopStatus === 'timed_out' || followup.loopStatus === 'failed') {
      return followup.loopStatus;
    }
    if (followup.status === 'failed') return 'failed';
    if (followup.loopStatus === 'running') return 'running';
    if (followup.loopStatus === 'queued' && followup.status !== 'running') return 'queued';
  }
  // A main-agent follow-up can still be running while delivering a successful
  // loop result. Keep its recovery status rather than marking it done early.
  return followup.status;
}

/** A Hook can finish scheduling an MCP loop while its loop keeps polling.
 * Keep the persisted execution status intact and aggregate only for display. */
export function getHookExecutionDisplayState(
  activity: HookActivityDetails,
  followups: HookFollowupActivityDetails[],
): HookExecutionDisplayState {
  const loop = followups.find((followup) => followup.actionType === 'mcp_loop_run');
  if (!loop) return { status: activity.status };

  const followupStatus = getHookFollowupDisplayStatus(loop);
  if (activity.status === 'failed' && loop.loopStatus === 'succeeded') return { status: 'failed' };
  if (loop.loopResumeStatus === 'unconfirmed'
    && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(loop.loopStatus || '')) {
    return { status: followupStatus, phase: 'loop_resume_unconfirmed' };
  }
  if (activity.status === 'failed') return { status: 'failed' };
  if (followupStatus === 'failed' || followupStatus === 'timed_out' || followupStatus === 'cancelled') {
    return { status: followupStatus };
  }
  if (loop.loopStatus === 'succeeded') {
    return followupStatus === 'succeeded'
      ? { status: activity.status }
      : { status: 'running', phase: 'agent_continuing' };
  }
  if (loop.loopStatus === 'queued' || (!loop.loopStatus && followupStatus === 'queued')) {
    return { status: 'running', phase: 'loop_queued' };
  }
  if (loop.loopStatus === 'running' || followupStatus === 'running') {
    return { status: 'running', phase: 'loop_running' };
  }
  return { status: followupStatus === 'succeeded' ? activity.status : followupStatus };
}
