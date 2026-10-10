import type { SubagentTrace } from '../subagent/types';

import type { ExecutionTask } from './types';

/** Preserve the invocation identity when an agent is resumed under the same ID. */
export function findExecutionTaskParentTrace(
  task: Pick<ExecutionTask, 'parentToolUseId' | 'parentAgentId' | 'traceId'>,
  traces: SubagentTrace[],
): SubagentTrace | null {
  if (task.parentToolUseId) {
    const exactTool = traces.find((trace) => trace.id === task.parentToolUseId
      || trace.sourceToolIds.includes(task.parentToolUseId!));
    if (exactTool) return exactTool;
  }
  if (task.traceId) {
    const exactTrace = traces.find((trace) => trace.id === task.traceId);
    if (exactTrace) return exactTrace;
  }
  if (!task.parentAgentId) return null;
  return traces.filter((trace) => trace.agentId === task.parentAgentId)
    .reduce<SubagentTrace | null>((latest, trace) => !latest
      || trace.startedAt.getTime() >= latest.startedAt.getTime() ? trace : latest, null);
}
