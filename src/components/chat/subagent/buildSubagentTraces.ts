import type {
  ChatMessage,
  SubagentChildTool,
  TaskNotificationDetails,
  ToolResult,
} from '../types/types';
import {
  isTaskNotificationError,
  isTaskNotificationTerminal,
} from '../utils/taskNotifications';

import type {
  SubagentActivity,
  SubagentActivityStatus,
  SubagentTrace,
  SubagentTraceStatus,
} from './types';

type TraceCandidate = {
  index: number;
  isAlias: boolean;
  message: ChatMessage;
  toolId: string;
};

type TraceGroup = {
  id: string;
  firstIndex: number;
  candidates: TraceCandidate[];
};

type ParsedToolInput = Record<string, unknown>;

function parseToolInput(value: unknown): ParsedToolInput | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ParsedToolInput;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ParsedToolInput
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readInputString(input: ParsedToolInput | null, ...keys: string[]): string | undefined {
  if (!input) {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(input[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function toDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function minDate(values: Array<Date | undefined>): Date {
  let earliest: Date | undefined;
  for (const value of values) {
    if (value && (!earliest || value.getTime() < earliest.getTime())) {
      earliest = value;
    }
  }
  return earliest || new Date(0);
}

function maxDate(values: Array<Date | undefined>): Date | undefined {
  let latest: Date | undefined;
  for (const value of values) {
    if (value && (!latest || value.getTime() > latest.getTime())) {
      latest = value;
    }
  }
  return latest;
}

function activityStatus(toolResult: ToolResult | null): SubagentActivityStatus {
  if (toolResult?.isError) {
    return 'error';
  }
  return toolResult ? 'completed' : 'running';
}

function filename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function summarizeActivity(tool: SubagentChildTool): string {
  const input = parseToolInput(tool.toolInput);
  const normalizedToolName = tool.toolName.trim().toLowerCase();
  let detail: string | undefined;

  if (['read', 'write', 'edit', 'applypatch'].includes(normalizedToolName)) {
    const path = readInputString(input, 'file_path', 'filePath', 'path');
    detail = path ? filename(path) : undefined;
  } else if (normalizedToolName === 'grep' || normalizedToolName === 'glob') {
    detail = readInputString(input, 'pattern', 'query');
  } else if (normalizedToolName === 'bash') {
    const command = readInputString(input, 'command');
    detail = command && command.length > 80 ? `${command.slice(0, 77)}...` : command;
  } else if (normalizedToolName === 'task' || normalizedToolName === 'agent') {
    detail = readInputString(input, 'description', 'subagent_type', 'subagentType');
  } else if (normalizedToolName === 'taskoutput') {
    detail = readInputString(input, 'task_id', 'taskId');
  } else if (normalizedToolName === 'webfetch') {
    detail = readInputString(input, 'url');
  } else if (normalizedToolName === 'websearch') {
    detail = readInputString(input, 'query');
  } else {
    detail = readInputString(input, 'description', 'name');
  }

  return detail ? `${tool.toolName} ${detail}` : tool.toolName;
}

function candidateTaskStatus(candidate: TraceCandidate): string | undefined {
  return readString(candidate.message.taskNotification?.status) ||
    readString(candidate.message.taskStatus);
}

function isWaitingStatus(status: string | undefined): boolean {
  if (!status) {
    return false;
  }
  return ['pending', 'queued', 'waiting'].includes(
    status.trim().toLowerCase().replace(/[\s-]+/g, '_'),
  );
}

function resolveTraceStatus(
  candidates: TraceCandidate[],
  primary: TraceCandidate,
  taskStatus: string | undefined,
): SubagentTraceStatus {
  const primaryState = primary.message.subagentState;
  if (primaryState && !primaryState.isComplete) {
    return isWaitingStatus(taskStatus) ? 'waiting' : 'running';
  }

  const statusCandidates = primaryState ? [primary] : candidates;
  const hasError = statusCandidates.some(({ message }) => (
    Boolean(message.toolResult?.isError) ||
    Boolean(message.taskNotification && isTaskNotificationError(message.taskNotification.status))
  )) || Boolean(primaryState?.isComplete && taskStatus && isTaskNotificationError(taskStatus));

  if (hasError) {
    return 'error';
  }

  const isComplete = statusCandidates.some(({ message }) => Boolean(message.subagentState?.isComplete)) ||
    Boolean(taskStatus && isTaskNotificationTerminal(taskStatus));
  if (isComplete) {
    return 'completed';
  }

  return isWaitingStatus(taskStatus) ? 'waiting' : 'running';
}

function candidateCompletedAt(candidate: TraceCandidate): Date | undefined {
  const { message } = candidate;
  return toDate(message.toolCompletedAt) ||
    toDate(message.toolResult?.timestamp);
}

function pickPrimary(candidates: TraceCandidate[]): TraceCandidate {
  const owners = candidates.filter((candidate) => !candidate.isAlias);
  const pool = owners.length > 0 ? owners : candidates;
  return pool[pool.length - 1] as TraceCandidate;
}

function orderedWithPrimaryFirst(
  candidates: TraceCandidate[],
  primary: TraceCandidate,
): TraceCandidate[] {
  return [primary, ...candidates.filter((candidate) => candidate !== primary)];
}

function firstInputValue(
  candidates: TraceCandidate[],
  primary: TraceCandidate,
  keys: string[],
): string | undefined {
  for (const candidate of orderedWithPrimaryFirst(candidates, primary)) {
    const value = readInputString(parseToolInput(candidate.message.toolInput), ...keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstTaskStatus(
  candidates: TraceCandidate[],
  primary: TraceCandidate,
): string | undefined {
  for (const candidate of orderedWithPrimaryFirst(candidates, primary)) {
    const status = candidateTaskStatus(candidate);
    if (status) {
      return status;
    }
  }
  return undefined;
}

function firstAgentId(
  candidates: TraceCandidate[],
  primary: TraceCandidate,
): string | undefined {
  for (const candidate of orderedWithPrimaryFirst(candidates, primary)) {
    const stateAgentId = readString(candidate.message.subagentState?.agentId);
    if (stateAgentId) {
      return stateAgentId;
    }
    const notificationTaskId = readString(candidate.message.taskNotification?.taskId);
    if (notificationTaskId) {
      return notificationTaskId;
    }
    const toolResult = parseToolInput(candidate.message.toolResult?.toolUseResult);
    const resultAgentId = readInputString(toolResult, 'agentId', 'agent_id', 'taskId', 'task_id');
    if (resultAgentId) {
      return resultAgentId;
    }
    const toolInput = parseToolInput(candidate.message.toolInput);
    const resumedAgentId = readInputString(toolInput, 'resume', 'resumeId', 'resume_id');
    if (resumedAgentId) {
      return resumedAgentId;
    }
  }
  return undefined;
}

function buildActivities(candidates: TraceCandidate[]): SubagentActivity[] {
  type IndexedActivity = SubagentActivity & { encounterIndex: number };

  const byToolId = new Map<string, IndexedActivity>();
  let encounterIndex = 0;

  for (const candidate of candidates) {
    for (const tool of candidate.message.subagentState?.childTools || []) {
      if (!tool?.toolId) {
        continue;
      }

      const existing = byToolId.get(tool.toolId);
      const toolResult = tool.toolResult || null;
      const timestamp = toDate(tool.timestamp) ||
        toDate(candidate.message.timestamp) ||
        new Date(0);

      if (!existing) {
        byToolId.set(tool.toolId, {
          id: tool.toolId,
          toolId: tool.toolId,
          toolName: tool.toolName || 'UnknownTool',
          toolInput: tool.toolInput,
          toolResult,
          timestamp,
          status: activityStatus(toolResult),
          summary: summarizeActivity(tool),
          encounterIndex,
        });
        encounterIndex += 1;
        continue;
      }

      // A later render of the same tool normally carries its result. Preserve
      // the original position while enriching the activity in place.
      if (!existing.toolResult && toolResult) {
        existing.toolResult = toolResult;
        existing.status = activityStatus(toolResult);
      }
      if (existing.toolName === 'UnknownTool' && tool.toolName) {
        existing.toolName = tool.toolName;
        existing.summary = summarizeActivity(tool);
      }
    }
  }

  return [...byToolId.values()]
    .sort((left, right) => (
      left.timestamp.getTime() - right.timestamp.getTime() ||
      left.encounterIndex - right.encounterIndex
    ))
    .map(({ encounterIndex: _encounterIndex, ...activity }) => activity);
}

function buildMessages(candidates: TraceCandidate[]): ChatMessage[] {
  const messages: Array<{ index: number; message: ChatMessage }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    for (const message of candidate.message.subagentState?.messages || []) {
      const identity = String(
        message.id || message.messageId || message.toolId || message.timestamp,
      );
      if (seen.has(identity)) continue;
      seen.add(identity);
      messages.push({ index: messages.length, message });
    }
  }

  return messages
    .sort((left, right) => (
      (toDate(left.message.timestamp)?.getTime() || 0) -
        (toDate(right.message.timestamp)?.getTime() || 0) ||
      left.index - right.index
    ))
    .map(({ message }) => message);
}

function buildTrace(group: TraceGroup): SubagentTrace {
  const candidates = [...group.candidates].sort((left, right) => left.index - right.index);
  const primary = pickPrimary(candidates);
  const description = firstInputValue(candidates, primary, ['description']) || 'Running task';
  const agentType = firstInputValue(candidates, primary, ['subagent_type', 'subagentType']) || 'Agent';
  const prompt = firstInputValue(candidates, primary, ['prompt']) || '';
  const primaryTaskStatus = candidateTaskStatus(primary);
  const taskStatus = primaryTaskStatus || (
    primary.message.subagentState?.isComplete
      ? firstTaskStatus(candidates, primary)
      : undefined
  );
  const status = resolveTraceStatus(candidates, primary, taskStatus);
  const agentId = firstAgentId(candidates, primary);
  const activities = buildActivities(candidates);
  const messages = buildMessages(candidates);
  const completedAt = status === 'completed' || status === 'error'
    ? maxDate(candidates.map(candidateCompletedAt))
    : undefined;

  const usage: TaskNotificationDetails['usage'] = {};
  for (const candidate of [...orderedWithPrimaryFirst(candidates, primary)].reverse()) {
    Object.assign(usage, candidate.message.taskNotification?.usage || {});
  }

  let result: unknown;
  if (status === 'completed' || status === 'error') {
    for (const candidate of orderedWithPrimaryFirst(candidates, primary)) {
      if (candidate.message.taskNotification?.result !== undefined) {
        result = candidate.message.taskNotification.result;
        break;
      }
      if (candidate.message.toolResult?.content !== undefined) {
        result = candidate.message.toolResult.content;
        break;
      }
    }
  }

  const trace: SubagentTrace = {
    id: group.id,
    sourceToolIds: orderedWithPrimaryFirst(candidates, primary)
      .map((candidate) => candidate.toolId)
      .filter((toolId, index, values) => values.indexOf(toolId) === index),
    title: `Subagent / ${agentType}: ${description}`,
    description,
    agentType,
    prompt,
    status,
    startedAt: minDate(candidates.map(({ message }) => toDate(message.timestamp))),
    activities,
    messages,
    usage,
  };

  if (agentId) {
    trace.agentId = agentId;
  }
  if (completedAt) {
    trace.completedAt = completedAt;
  }
  if (result !== undefined) {
    trace.result = result;
  }
  if (taskStatus) {
    trace.taskStatus = taskStatus;
  }

  return trace;
}

/**
 * Build the side-panel view model from the already-normalized chat messages.
 * Legacy Task cards that point at an Agent details owner collapse into one
 * trace, while unrelated (including concurrently running) agents stay apart.
 */
export function buildSubagentTraces(messages: ChatMessage[]): SubagentTrace[] {
  const groups = new Map<string, TraceGroup>();

  messages.forEach((message, index) => {
    if (!message.isSubagentContainer || !readString(message.toolId)) {
      return;
    }

    const toolId = message.toolId as string;
    const detailsOwnerToolId = readString(message.subagentState?.detailsOwnerToolId);
    const id = detailsOwnerToolId || toolId;
    const group = groups.get(id) || {
      id,
      firstIndex: index,
      candidates: [],
    };
    group.candidates.push({
      index,
      isAlias: Boolean(detailsOwnerToolId),
      message,
      toolId,
    });
    groups.set(id, group);
  });

  return [...groups.values()]
    .map(buildTrace)
    .sort((left, right) => {
      const timeDifference = left.startedAt.getTime() - right.startedAt.getTime();
      if (timeDifference !== 0) {
        return timeDifference;
      }
      return (groups.get(left.id)?.firstIndex || 0) - (groups.get(right.id)?.firstIndex || 0);
    });
}
