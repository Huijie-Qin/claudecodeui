import type { PendingPermissionRequest } from '../types/types';

import type { SubagentTrace } from './types';

type SubagentPermissionIdentity = {
  toolUseId?: string;
  agentId?: string;
};

export type RoutedSubagentPermissionRequest = {
  request: PendingPermissionRequest;
  trace: SubagentTrace;
};

export function applySubagentPermissionWaitingState(
  traces: SubagentTrace[],
  routedRequests: RoutedSubagentPermissionRequest[],
): SubagentTrace[] {
  const waitingTraceIds = new Set(routedRequests.map(({ trace }) => trace.id));

  return traces.map((trace) => {
    if (!waitingTraceIds.has(trace.id) || trace.status === 'error') {
      return trace;
    }

    // A resumed agent can receive a new question after an earlier generation
    // completed. Do not let that terminal snapshot leak into the waiting view.
    return {
      ...trace,
      status: 'waiting',
      result: undefined,
      completedAt: undefined,
    };
  });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function getSubagentPermissionIdentity(
  request: PendingPermissionRequest,
): SubagentPermissionIdentity {
  if (!request.context || typeof request.context !== 'object' || Array.isArray(request.context)) {
    return {};
  }

  const context = request.context as Record<string, unknown>;
  return {
    toolUseId: readString(context.toolUseId) || readString(context.toolUseID),
    agentId: readString(context.agentId) || readString(context.agentID),
  };
}

export function findSubagentTraceForPermissionRequest(
  traces: SubagentTrace[],
  request: PendingPermissionRequest,
): SubagentTrace | null {
  if (request.toolName !== 'AskUserQuestion') {
    return null;
  }

  const { toolUseId, agentId } = getSubagentPermissionIdentity(request);
  if (toolUseId) {
    const toolTrace = traces.find((trace) => (
      trace.activities.some((activity) => activity.toolId === toolUseId)
    ));
    if (toolTrace) return toolTrace;
  }

  if (!agentId) {
    return null;
  }

  // A resumed agent may reuse the same agent ID across several invocations.
  // Only an active generation is safe for an agent-ID fallback. If a resumed
  // generation has not appeared yet, keep the request unresolved rather than
  // mounting it on an older completed trace and later discarding form state.
  const matchingTraces = traces.filter((trace) => trace.agentId === agentId);
  return [...matchingTraces].reverse().find((trace) => (
    trace.status === 'running' || trace.status === 'waiting'
  )) || null;
}

export function partitionSubagentPermissionRequests(
  traces: SubagentTrace[],
  requests: PendingPermissionRequest[],
  selectedTraceId: string | null,
): {
  routed: RoutedSubagentPermissionRequest[];
  selectedTrace: SubagentTrace | null;
  selectedRequests: PendingPermissionRequest[];
  hidden: RoutedSubagentPermissionRequest[];
  unresolved: PendingPermissionRequest[];
  main: PendingPermissionRequest[];
} {
  const routed = requests.flatMap((request) => {
    const trace = findSubagentTraceForPermissionRequest(traces, request);
    return trace ? [{ request, trace }] : [];
  });
  const selectedTrace = traces.find((trace) => (
    trace.id === selectedTraceId ||
    (selectedTraceId !== null && trace.sourceToolIds.includes(selectedTraceId))
  )) || null;
  const selectedRequests = selectedTrace
    ? routed
        .filter(({ trace }) => trace.id === selectedTrace.id)
        .map(({ request }) => request)
    : [];
  const hidden = routed.filter(({ trace }) => trace.id !== selectedTrace?.id);
  const routedRequestIds = new Set(routed.map(({ request }) => request.requestId));
  const unresolved = requests.filter((request) => (
    !routedRequestIds.has(request.requestId) &&
    request.toolName === 'AskUserQuestion' &&
    Boolean(getSubagentPermissionIdentity(request).agentId)
  ));
  const unresolvedRequestIds = new Set(unresolved.map((request) => request.requestId));
  const main = requests.filter((request) => (
    !routedRequestIds.has(request.requestId) &&
    !unresolvedRequestIds.has(request.requestId)
  ));

  return { routed, selectedTrace, selectedRequests, hidden, unresolved, main };
}
