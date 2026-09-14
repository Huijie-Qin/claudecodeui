import type { HookExecution } from './types';

export function getHookExecutionAgent(execution: {
  eventName: string;
  agentId?: string | null;
  agentType?: string | null;
  input?: unknown;
}) {
  const input = execution.input && typeof execution.input === 'object'
    ? execution.input as Record<string, unknown>
    : {};
  const id = execution.agentId || (typeof input.agent_id === 'string' ? input.agent_id : null);
  const type = execution.agentType || (typeof input.agent_type === 'string' ? input.agent_type : null);
  const isSubagent = Boolean(id) || execution.eventName === 'SubagentStart' || execution.eventName === 'SubagentStop';
  return { id, type, isSubagent, label: isSubagent ? `子代理${type ? ` · ${type}` : ''}` : '主代理' };
}

export type HookExecutionGroup = {
  key: string;
  exact: boolean;
  sessionId: string | null;
  eventName: string;
  toolUseId: string | null;
  toolName: string | null;
  executions: HookExecution[];
  conflicts: Array<'updated_input' | 'permission_decision' | 'fail_open_side_effect'>;
};

export function groupHookExecutions(executions: HookExecution[]): HookExecutionGroup[] {
  const groups = new Map<string, HookExecutionGroup>();
  for (const execution of executions) {
    const exact = Boolean(execution.toolUseId);
    const key = exact
      ? `${execution.sessionId || 'no-session'}:${getHookExecutionAgent(execution).id || 'main'}:${execution.eventName}:${execution.toolUseId}`
      : `execution:${execution.id}`;
    const group = groups.get(key) || {
      key,
      exact,
      sessionId: execution.sessionId,
      eventName: execution.eventName,
      toolUseId: execution.toolUseId,
      toolName: execution.toolName,
      executions: [],
      conflicts: [],
    };
    group.executions.push(execution);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    group.executions.sort((left, right) => (
      (left.startedAtMs || 0) - (right.startedAtMs || 0)
      || left.id.localeCompare(right.id)
    ));
    const conflicts: HookExecutionGroup['conflicts'] = [];
    if (group.executions.filter((item) => item.diagnostics.updatedInput).length > 1) {
      conflicts.push('updated_input');
    }
    if (new Set(group.executions
      .map((item) => item.diagnostics.permissionDecision)
      .filter(Boolean)).size > 1) {
      conflicts.push('permission_decision');
    }
    if (group.executions.some((item) => item.diagnostics.failOpen)
        && group.executions.some((item) => item.diagnostics.actionCount > 0)) {
      conflicts.push('fail_open_side_effect');
    }
    return { ...group, conflicts };
  }).sort((left, right) => {
    const leftTime = Math.max(...left.executions.map((item) => item.startedAtMs || 0));
    const rightTime = Math.max(...right.executions.map((item) => item.startedAtMs || 0));
    return rightTime - leftTime;
  });
}

export function likelyWinningUpdatedInput(group: HookExecutionGroup): HookExecution | null {
  const writers = group.executions.filter((item) => item.diagnostics.updatedInput);
  if (writers.length < 2) return null;
  return [...writers].sort((left, right) => (
    (right.completedAtMs || 0) - (left.completedAtMs || 0)
  ))[0] || null;
}

export function paginationWindow(currentPage: number, totalPages: number, size = 5): number[] {
  if (totalPages <= 0 || size <= 0) return [];
  const normalizedSize = Math.min(Math.floor(size), totalPages);
  const normalizedPage = Math.min(Math.max(Math.floor(currentPage), 1), totalPages);
  let start = normalizedPage - Math.floor(normalizedSize / 2);
  start = Math.max(1, Math.min(start, totalPages - normalizedSize + 1));
  return Array.from({ length: normalizedSize }, (_, index) => start + index);
}
