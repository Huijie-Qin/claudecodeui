/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type {
  ChatMessage,
  HookActivityStatus,
  HookFollowupActivityDetails,
  SubagentChildTool,
} from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';
import { isClaudeInternalUserContent } from '../utils/internalMessages';
import {
  isTaskNotificationError,
  isTaskNotificationTerminal,
  parseTaskNotification,
} from '../utils/taskNotifications';

type TimestampValue = string | number | Date;

const getMessageIdentity = (msg: NormalizedMessage): Pick<ChatMessage, 'id' | 'messageId' | 'rowid' | 'sequence'> => ({
  id: msg.id,
  messageId: msg.id,
  rowid: msg.rowid,
  sequence: msg.sequence,
});

function timestampToMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  return null;
}

function asTimestampValue(value: unknown): TimestampValue | undefined {
  return timestampToMs(value) !== null && (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value instanceof Date
  )
    ? value
    : undefined;
}

function readTimestampField(value: unknown): TimestampValue | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return asTimestampValue(record.timestamp) ||
    asTimestampValue(record.completedAt) ||
    asTimestampValue(record.completed_at) ||
    asTimestampValue(record.endTime) ||
    asTimestampValue(record.endedAt);
}

function findNextTimestamp(messages: NormalizedMessage[], currentIndex: number, afterTimestamp: unknown): string | undefined {
  const afterMs = timestampToMs(afterTimestamp);
  if (afterMs === null) {
    return undefined;
  }

  for (let index = currentIndex + 1; index < messages.length; index++) {
    const candidate = messages[index];
    if (!candidate) {
      continue;
    }
    const candidateMs = timestampToMs(candidate.timestamp);
    if (candidateMs !== null && candidateMs >= afterMs) {
      return candidate.timestamp;
    }
  }

  return undefined;
}

function isClaudeSkillToolUse(message: NormalizedMessage | undefined): boolean {
  return Boolean(
    message?.provider === 'claude' &&
    message.kind === 'tool_use' &&
    typeof message.toolName === 'string' &&
    message.toolName.toLowerCase().includes('skill'),
  );
}

function normalizeHookActivityStatus(status: unknown): HookActivityStatus {
  return ['queued', 'running', 'succeeded', 'failed'].includes(String(status || ''))
    ? status as HookActivityStatus
    : 'running';
}

function hookActivityIdentity(message: NormalizedMessage): string {
  return message.jobId || message.id;
}

function hookExecutionActivityPrefix(message: NormalizedMessage): string | null {
  const identity = hookActivityIdentity(message);
  return identity.endsWith('_execution')
    ? identity.slice(0, -'_execution'.length)
    : null;
}

function toHookFollowupDetails(
  message: NormalizedMessage,
  recoveryMessages: NormalizedMessage[] = [],
): HookFollowupActivityDetails {
  return {
    jobId: message.jobId,
    executionId: message.executionId,
    actionId: message.actionId,
    actionType: message.actionType,
    skillName: message.skillName,
    summary: message.summary,
    queuePosition: message.queuePosition,
    status: normalizeHookActivityStatus(message.status),
    error: message.error,
    timestamp: message.timestamp,
    messages: recoveryMessages.length > 0
      ? normalizedToChatMessages(recoveryMessages)
      : undefined,
  };
}

function isSubagentToolName(toolName: unknown): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }
  const normalizedName = toolName.trim().toLowerCase();
  return normalizedName === 'task' || normalizedName === 'agent';
}

function isTaskOutputToolName(toolName: unknown): boolean {
  return typeof toolName === 'string' && toolName.trim().toLowerCase() === 'taskoutput';
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readNestedStringField(
  value: unknown,
  fieldNames: Set<string>,
  depth = 0,
): string | undefined {
  if (depth > 5 || value == null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return readNestedStringField(JSON.parse(trimmed), fieldNames, depth + 1);
    } catch {
      for (const fieldName of fieldNames) {
        const escapedName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = trimmed.match(new RegExp(`<${escapedName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedName}\\s*>`, 'i'));
        if (match?.[1]?.trim()) {
          return decodeHtmlEntities(match[1].trim());
        }
      }
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedValue = readNestedStringField(item, fieldNames, depth + 1);
      if (nestedValue) {
        return nestedValue;
      }
    }
    return undefined;
  }

  const record = readObject(value);
  if (!record) {
    return undefined;
  }

  for (const [name, fieldValue] of Object.entries(record)) {
    if (fieldNames.has(name) && (typeof fieldValue === 'string' || typeof fieldValue === 'number')) {
      const normalizedValue = String(fieldValue).trim();
      if (normalizedValue) {
        return normalizedValue;
      }
    }
  }

  for (const nestedValue of Object.values(record)) {
    const match = readNestedStringField(nestedValue, fieldNames, depth + 1);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function readSubagentTaskId(value: unknown): string | undefined {
  return readNestedStringField(
    value,
    new Set(['agentId', 'agent_id', 'taskId', 'task_id', 'resume', 'resumeId', 'resume_id']),
  );
}

function readToolResultStatus(value: unknown): string | undefined {
  const xmlStatus = readNestedStringField(value, new Set(['status']));
  if (xmlStatus) {
    return xmlStatus;
  }
  const record = readObject(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.status === 'string') {
    return record.status;
  }
  return readToolResultStatus(record.toolUseResult);
}

function readTaskOutputResult(value: unknown): { status?: string; result?: string } {
  const status = readToolResultStatus(value);
  const explicitResult = readNestedStringField(
    value,
    new Set(['output', 'result', 'last_assistant_message']),
  );
  const plainTextResult = typeof value === 'string' &&
    !/<(?:retrieval_status|task_id|task_type|status)\b/i.test(value)
    ? value.trim() || undefined
    : undefined;
  return {
    status,
    result: explicitResult || plainTextResult,
  };
}

function readTaskNotificationMessage(msg: NormalizedMessage): ChatMessage['taskNotification'] | null {
  if (msg.kind === 'text' && msg.role === 'user' && msg.content) {
    return parseTaskNotification(msg.content);
  }
  if (msg.kind !== 'task_notification') {
    return null;
  }

  return {
    taskId: msg.taskId,
    toolUseId: msg.toolUseId,
    outputFile: msg.outputFile,
    status: msg.status || 'completed',
    summary: msg.summary || '',
    result: msg.result,
    usage: msg.usage || {},
    extraFields: {},
    raw: msg.content || '',
  };
}

/**
 * Convert NormalizedMessage[] from the session store into ChatMessage[]
 * that the existing UI components expect.
 *
 * Internal/system content (e.g. <system-reminder>, <command-name>) is already
 * filtered server-side by the Claude provider module.
 */
export function normalizedToChatMessages(messages: NormalizedMessage[]): ChatMessage[] {
  const converted: ChatMessage[] = [];

  const hookExecutionMessages = messages.filter((message) => (
    message.kind === 'hook_activity' && message.activityKind === 'execution'
  ));
  const hookExecutionByExecutionId = new Map<string, NormalizedMessage>();
  const hookExecutionPrefixes = hookExecutionMessages
    .map((message) => ({ message, prefix: hookExecutionActivityPrefix(message) }))
    .filter((entry): entry is { message: NormalizedMessage; prefix: string } => Boolean(entry.prefix));
  const hookFollowupsByExecutionMessageId = new Map<string, NormalizedMessage[]>();
  const groupedHookFollowupIds = new Set<string>();
  const hookRecoveryMessagesByActivityId = new Map<string, NormalizedMessage[]>();
  const hookRecoveryExecutionMessageByActivityId = new Map<string, NormalizedMessage>();
  const groupedHookRecoveryMessageIds = new Set<string>();

  for (const message of hookExecutionMessages) {
    if (message.executionId) {
      hookExecutionByExecutionId.set(message.executionId, message);
    }
  }

  for (const message of messages) {
    if (message.kind !== 'hook_activity' || message.activityKind === 'execution') {
      continue;
    }
    const identity = hookActivityIdentity(message);
    const executionMessage = (
      (message.executionId ? hookExecutionByExecutionId.get(message.executionId) : undefined) ||
      hookExecutionPrefixes.find(({ prefix }) => identity.startsWith(`${prefix}_`))?.message
    );
    if (!executionMessage) {
      continue;
    }
    const followups = hookFollowupsByExecutionMessageId.get(executionMessage.id) || [];
    followups.push(message);
    hookFollowupsByExecutionMessageId.set(executionMessage.id, followups);
    groupedHookFollowupIds.add(message.id);
  }

  const groupedHookFollowupsByActivityId = new Map(
    messages
      .filter((message) => groupedHookFollowupIds.has(message.id))
      .map((message) => [hookActivityIdentity(message), message]),
  );
  for (const message of messages) {
    if (!message.hookActivityId) {
      continue;
    }
    const groupedFollowup = groupedHookFollowupsByActivityId.get(message.hookActivityId);
    const recoveredExecution = groupedFollowup
      ? null
      : hookExecutionPrefixes.find(({ prefix }) => (
        message.hookActivityId?.startsWith(`${prefix}_`)
      ))?.message || null;
    if (!groupedFollowup && !recoveredExecution) {
      continue;
    }
    if (recoveredExecution) {
      hookRecoveryExecutionMessageByActivityId.set(message.hookActivityId, recoveredExecution);
    }
    const recoveryMessages = hookRecoveryMessagesByActivityId.get(message.hookActivityId) || [];
    recoveryMessages.push(message);
    hookRecoveryMessagesByActivityId.set(message.hookActivityId, recoveryMessages);
    groupedHookRecoveryMessageIds.add(message.id);
  }

  const renderableLegacyRecoveryKinds = new Set([
    'text',
    'thinking',
    'tool_use',
    'tool_result',
    'error',
  ]);
  for (const executionMessage of hookExecutionMessages) {
    const alreadyHasFollowup = (hookFollowupsByExecutionMessageId.get(executionMessage.id) || []).length > 0
      || [...hookRecoveryExecutionMessageByActivityId.values()].some((message) => (
        message.id === executionMessage.id
      ));
    if (alreadyHasFollowup || !executionMessage.actionTypes?.includes('invoke_skill')) {
      continue;
    }
    const executionIndex = messages.findIndex((message) => message.id === executionMessage.id);
    const executionTime = timestampToMs(executionMessage.timestamp);
    if (executionIndex === -1 || executionTime === null) {
      continue;
    }
    const recoveryMessages: NormalizedMessage[] = [];
    for (let index = executionIndex + 1; index < messages.length; index++) {
      const candidate = messages[index];
      if (candidate.kind === 'text' && candidate.role === 'user') {
        break;
      }
      if (
        groupedHookRecoveryMessageIds.has(candidate.id)
        || candidate.kind === 'hook_activity'
        || candidate.provider !== 'claude'
        || !renderableLegacyRecoveryKinds.has(candidate.kind)
        || (timestampToMs(candidate.timestamp) ?? Number.NEGATIVE_INFINITY) <= executionTime
      ) {
        continue;
      }
      recoveryMessages.push(candidate);
    }
    if (recoveryMessages.length === 0) {
      continue;
    }
    const executionPrefix = hookExecutionActivityPrefix(executionMessage) || executionMessage.id;
    const legacyActivityId = `${executionPrefix}_legacy-recovery`;
    hookRecoveryExecutionMessageByActivityId.set(legacyActivityId, executionMessage);
    hookRecoveryMessagesByActivityId.set(legacyActivityId, recoveryMessages);
    recoveryMessages.forEach((message) => groupedHookRecoveryMessageIds.add(message.id));
  }

  // First pass: collect tool results for attachment
  const toolResultMap = new Map<string, NormalizedMessage>();
  for (const msg of messages) {
    if (msg.kind === 'tool_result' && msg.toolId) {
      toolResultMap.set(msg.toolId, msg);
    }
  }

  const subagentToolIds = new Set(
    messages
      .filter((msg) => msg.kind === 'tool_use' && msg.toolId && isSubagentToolName(msg.toolName))
      .map((msg) => msg.toolId as string),
  );
  type SubagentToolCandidate = {
    index: number;
    message: NormalizedMessage;
    toolId: string;
  };
  const subagentToolMessageById = new Map<string, NormalizedMessage>();
  const subagentToolIndexById = new Map<string, number>();
  const subagentToolCandidatesByTaskId = new Map<string, SubagentToolCandidate[]>();

  const registerSubagentToolCandidate = (
    taskId: string | undefined,
    message: NormalizedMessage,
    index: number,
  ) => {
    if (!taskId || !message.toolId) {
      return;
    }
    const candidates = subagentToolCandidatesByTaskId.get(taskId) || [];
    if (!candidates.some((candidate) => candidate.toolId === message.toolId)) {
      candidates.push({ index, message, toolId: message.toolId });
      candidates.sort((left, right) => left.index - right.index);
      subagentToolCandidatesByTaskId.set(taskId, candidates);
    }
  };

  messages.forEach((msg, index) => {
    if (msg.kind !== 'tool_use' || !msg.toolId || !isSubagentToolName(msg.toolName)) {
      return;
    }
    subagentToolMessageById.set(msg.toolId, msg);
    subagentToolIndexById.set(msg.toolId, index);
    const mappedToolResult = toolResultMap.get(msg.toolId);
    const inlineToolResult = msg.toolResult as
      | (NonNullable<NormalizedMessage['toolResult']> & Record<string, unknown>)
      | undefined;
    const taskId = readSubagentTaskId(
      (inlineToolResult as any)?.toolUseResult ||
      (mappedToolResult as any)?.toolUseResult ||
      inlineToolResult ||
      mappedToolResult,
    ) || readSubagentTaskId(msg.toolInput);
    registerSubagentToolCandidate(taskId, msg, index);
  });

  // A task notification can be the first place an invocation's task ID is
  // exposed. Register that exact relationship before resolving task-id-only
  // TaskOutput and later lifecycle events.
  messages.forEach((msg, index) => {
    const notification = readTaskNotificationMessage(msg);
    if (!notification?.taskId || !notification.toolUseId) {
      return;
    }
    const toolMessage = subagentToolMessageById.get(notification.toolUseId);
    if (toolMessage) {
      registerSubagentToolCandidate(
        notification.taskId,
        toolMessage,
        subagentToolIndexById.get(notification.toolUseId) ?? index,
      );
    }
  });

  // Claude can emit both the legacy Task call and the current Agent call for
  // the same agentId. Pair them one-to-one so a reused task ID does not make
  // every historical Task invocation alias the newest Agent generation.
  const subagentDetailsOwnerByAliasToolId = new Map<string, string>();
  for (const candidates of subagentToolCandidatesByTaskId.values()) {
    const taskCandidates = candidates.filter(({ message }) => (
      message.toolName?.trim().toLowerCase() === 'task'
    ));
    const agentCandidates = candidates.filter(({ message }) => (
      message.toolName?.trim().toLowerCase() === 'agent'
    ));
    const unmatchedAgentToolIds = new Set(agentCandidates.map((candidate) => candidate.toolId));

    // Match newest-to-oldest. If one side of an older generation is missing,
    // an old Task must not steal the Agent emitted for the current generation.
    for (const taskCandidate of [...taskCandidates].reverse()) {
      let closestAgent: SubagentToolCandidate | undefined;
      for (const agentCandidate of agentCandidates) {
        if (!unmatchedAgentToolIds.has(agentCandidate.toolId)) {
          continue;
        }
        if (
          !closestAgent ||
          Math.abs(agentCandidate.index - taskCandidate.index) < Math.abs(closestAgent.index - taskCandidate.index)
        ) {
          closestAgent = agentCandidate;
        }
      }
      if (closestAgent) {
        subagentDetailsOwnerByAliasToolId.set(taskCandidate.toolId, closestAgent.toolId);
        unmatchedAgentToolIds.delete(closestAgent.toolId);
      }
    }
  }

  const canonicalSubagentToolIdAt = (toolId: string, eventIndex: number): string => {
    const detailsOwnerToolId = subagentDetailsOwnerByAliasToolId.get(toolId);
    if (!detailsOwnerToolId) {
      return toolId;
    }
    const ownerIndex = subagentToolIndexById.get(detailsOwnerToolId);
    return ownerIndex !== undefined && ownerIndex <= eventIndex
      ? detailsOwnerToolId
      : toolId;
  };

  const resolveSubagentToolIdAt = ({
    eventIndex,
    taskId,
    toolUseId,
  }: {
    eventIndex: number;
    taskId?: string;
    toolUseId?: string;
  }): string | undefined => {
    // Explicit toolUseId wins over a newer invocation sharing the task ID.
    if (toolUseId && subagentToolIds.has(toolUseId)) {
      return canonicalSubagentToolIdAt(toolUseId, eventIndex);
    }
    if (!taskId) {
      return undefined;
    }
    const candidates = subagentToolCandidatesByTaskId.get(taskId) || [];
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index];
      if (candidate && candidate.index <= eventIndex) {
        return canonicalSubagentToolIdAt(candidate.toolId, eventIndex);
      }
    }
    return undefined;
  };

  type SubagentChildToolRecord = {
    index: number;
    toolUse: NormalizedMessage;
    toolResult: NormalizedMessage | null;
  };
  const subagentChildToolsByParentToolId = new Map<string, SubagentChildToolRecord[]>();
  const associatedSubagentChildToolIds = new Set<string>();

  for (const [index, msg] of messages.entries()) {
    if (
      msg.kind !== 'tool_use' ||
      !msg.toolId ||
      !msg.parentToolUseId ||
      isTaskOutputToolName(msg.toolName) ||
      !subagentToolIds.has(msg.parentToolUseId)
    ) {
      continue;
    }
    const detailsParentToolId = canonicalSubagentToolIdAt(msg.parentToolUseId, index);
    const records = subagentChildToolsByParentToolId.get(detailsParentToolId) || [];
    records.push({
      index,
      toolUse: msg,
      toolResult: toolResultMap.get(msg.toolId) || null,
    });
    subagentChildToolsByParentToolId.set(detailsParentToolId, records);
    associatedSubagentChildToolIds.add(msg.toolId);
  }

  const historicalSubagentToolsByParentToolId = new Map<string, any[]>();
  for (const [toolId, msg] of subagentToolMessageById) {
    const mappedToolResult = toolResultMap.get(toolId);
    const historicalTools = [msg.subagentTools, mappedToolResult?.subagentTools]
      .filter((tools): tools is any[] => Array.isArray(tools) && tools.length > 0)
      .flat();
    if (historicalTools.length === 0) {
      continue;
    }
    const detailsParentToolId = subagentDetailsOwnerByAliasToolId.get(toolId) || toolId;
    const records = historicalSubagentToolsByParentToolId.get(detailsParentToolId) || [];
    records.push(...historicalTools);
    historicalSubagentToolsByParentToolId.set(detailsParentToolId, records);
  }

  const taskNotificationsByToolId = new Map<string, {
    index: number;
    notification: NonNullable<ChatMessage['taskNotification']>;
    timestamp: TimestampValue;
  }>();

  for (const [index, msg] of messages.entries()) {
    const notification = readTaskNotificationMessage(msg);
    if (!notification) {
      continue;
    }
    const parentToolId = resolveSubagentToolIdAt({
      eventIndex: index,
      taskId: notification.taskId,
      toolUseId: notification.toolUseId,
    });
    if (parentToolId) {
      taskNotificationsByToolId.set(parentToolId, {
        index,
        notification,
        timestamp: msg.timestamp,
      });
    }
  }

  type TaskOutputRecord = {
    index: number;
    toolUse: NormalizedMessage;
    toolResult: NormalizedMessage | null;
    parsedResult: ReturnType<typeof readTaskOutputResult>;
  };
  const taskOutputsByParentToolId = new Map<string, TaskOutputRecord[]>();
  const associatedTaskOutputToolIds = new Set<string>();

  for (const [index, msg] of messages.entries()) {
    if (msg.kind !== 'tool_use' || !msg.toolId || !isTaskOutputToolName(msg.toolName)) {
      continue;
    }
    const taskId = readNestedStringField(msg.toolInput, new Set(['task_id', 'taskId']));
    const parentToolId = resolveSubagentToolIdAt({ eventIndex: index, taskId });
    if (!parentToolId) {
      continue;
    }
    const taskOutputResult = toolResultMap.get(msg.toolId) || null;
    const records = taskOutputsByParentToolId.get(parentToolId) || [];
    records.push({
      index,
      toolUse: msg,
      toolResult: taskOutputResult,
      parsedResult: readTaskOutputResult(taskOutputResult?.content),
    });
    taskOutputsByParentToolId.set(parentToolId, records);
    associatedTaskOutputToolIds.add(msg.toolId);
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];
    if (groupedHookRecoveryMessageIds.has(msg.id)) {
      continue;
    }

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          const taskNotification = parseTaskNotification(content);
          if (taskNotification) {
            const parentToolId = resolveSubagentToolIdAt({
              eventIndex: messageIndex,
              taskId: taskNotification.taskId,
              toolUseId: taskNotification.toolUseId,
            });
            if (parentToolId) {
              continue;
            }
            converted.push({
              ...getMessageIdentity(msg),
              type: 'assistant',
              content: taskNotification.summary ||
                taskNotification.result ||
                'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotification.status,
              taskNotification,
            });
          } else {
            if (
              msg.provider === 'claude' &&
              (
                isClaudeInternalUserContent(content) ||
                isClaudeSkillToolUse(messages[messageIndex - 1])
              )
            ) {
              continue;
            }

            converted.push({
              ...getMessageIdentity(msg),
              type: 'user',
              content: unescapeWithMathProtection(decodeHtmlEntities(content)),
              timestamp: msg.timestamp,
              clientMessageId: msg.clientMessageId,
              queueStatus: msg.queueStatus,
              queuePosition: msg.queuePosition,
            });
          }
        } else {
          let text = decodeHtmlEntities(content);
          text = unescapeWithMathProtection(text);
          text = formatUsageLimitText(text);
          converted.push({
            ...getMessageIdentity(msg),
            type: 'assistant',
            content: text,
            timestamp: msg.timestamp,
          });
        }
        break;
      }

      case 'tool_use': {
        if (
          msg.toolId &&
          (
            associatedSubagentChildToolIds.has(msg.toolId) ||
            associatedTaskOutputToolIds.has(msg.toolId)
          )
        ) {
          break;
        }
        const mappedToolResult = msg.toolId ? toolResultMap.get(msg.toolId) : null;
        const inlineToolResult = msg.toolResult as (NonNullable<NormalizedMessage['toolResult']> & Record<string, unknown>) | undefined;
        const tr = inlineToolResult || mappedToolResult;
        const explicitCompletedAt = mappedToolResult?.timestamp ||
          readTimestampField(inlineToolResult) ||
          readTimestampField((tr as any)?.toolUseResult);
        const isSubagentContainer = isSubagentToolName(msg.toolName);
        const detailsOwnerToolId = msg.toolId
          ? subagentDetailsOwnerByAliasToolId.get(msg.toolId)
          : undefined;
        const isSubagentDetailsAlias = Boolean(detailsOwnerToolId);
        const notificationRecord = msg.toolId
          ? taskNotificationsByToolId.get(msg.toolId)
          : undefined;
        const taskNotification = notificationRecord?.notification;
        const taskNotificationIsTerminal = taskNotification
          ? isTaskNotificationTerminal(taskNotification.status)
          : false;
        const taskOutputRecords = msg.toolId
          ? [...(taskOutputsByParentToolId.get(msg.toolId) || [])]
            .sort((left, right) => left.index - right.index)
          : [];
        const latestTaskOutput = taskOutputRecords[taskOutputRecords.length - 1];
        const latestTaskOutputIsTerminal = Boolean(
          latestTaskOutput?.parsedResult.status &&
          isTaskNotificationTerminal(latestTaskOutput.parsedResult.status),
        );
        const taskOutputSequence = taskOutputRecords.map((record, index) => {
          const status = record.parsedResult.status;
          const result = record.parsedResult.result;
          const label = `TaskOutput ${index + 1}${status ? ` (${status})` : ''}`;
          return result ? `${label}\n${result}` : label;
        });
        const toolInputRecord = readObject(msg.toolInput);
        const toolResultStatus = readToolResultStatus(
          (tr as any)?.toolUseResult || inlineToolResult || tr,
        );
        const isBackgroundSubagent = isSubagentContainer && (
          toolInputRecord?.run_in_background === true ||
          toolResultStatus === 'async_launched'
        );
        const subagentAgentId = isSubagentContainer
          ? taskNotification?.taskId ||
            readSubagentTaskId((tr as any)?.toolUseResult) ||
            readSubagentTaskId(inlineToolResult) ||
            readSubagentTaskId(mappedToolResult) ||
            readSubagentTaskId(msg.toolInput)
          : undefined;
        const realtimeChildToolRecords = isSubagentContainer && !isSubagentDetailsAlias && msg.toolId
          ? subagentChildToolsByParentToolId.get(msg.toolId) || []
          : [];
        const historicalChildTools = isSubagentContainer && !isSubagentDetailsAlias && msg.toolId
          ? historicalSubagentToolsByParentToolId.get(msg.toolId) || []
          : [];
        const latestChildActivityIndex = realtimeChildToolRecords.reduce(
          (latest, record) => Math.max(latest, record.index),
          -1,
        );
        const latestLifecycleIndex = Math.max(
          notificationRecord?.index ?? -1,
          latestTaskOutput?.index ?? -1,
        );
        const latestHistoricalChildTime = historicalChildTools.reduce<number | null>(
          (latest, tool) => {
            const timestamp = timestampToMs(tool?.timestamp);
            return timestamp === null || (latest !== null && timestamp <= latest)
              ? latest
              : timestamp;
          },
          null,
        );
        const lifecycleTimes = [
          timestampToMs(notificationRecord?.timestamp),
          timestampToMs(latestTaskOutput?.toolResult?.timestamp),
          timestampToMs(latestTaskOutput?.toolUse.timestamp),
        ].filter((timestamp): timestamp is number => timestamp !== null);
        const latestLifecycleTime = lifecycleTimes.length > 0
          ? Math.max(...lifecycleTimes)
          : null;
        const hasNewerHistoricalActivity = latestHistoricalChildTime !== null &&
          latestLifecycleTime !== null &&
          latestHistoricalChildTime > latestLifecycleTime;
        const hasNewerChildActivity = latestChildActivityIndex > latestLifecycleIndex ||
          hasNewerHistoricalActivity;
        const notificationIsLatestLifecycle = Boolean(
          notificationRecord &&
          notificationRecord.index >= (latestTaskOutput?.index ?? -1),
        );
        const taskOutputIsLatestLifecycle = Boolean(
          latestTaskOutput &&
          latestTaskOutput.index > (notificationRecord?.index ?? -1),
        );
        const completionSource = hasNewerChildActivity
          ? null
          : notificationIsLatestLifecycle && taskNotificationIsTerminal
            ? 'task_notification'
            : taskOutputIsLatestLifecycle && latestTaskOutputIsTerminal
              ? 'task_output'
              : !notificationIsLatestLifecycle &&
                  !taskOutputIsLatestLifecycle &&
                  Boolean(tr) &&
                  (!isBackgroundSubagent || Boolean(tr?.isError))
                ? 'tool_result'
                : null;
        const isSubagentComplete = isSubagentContainer
          ? completionSource !== null
          : Boolean(tr);
        const toolCompletedAt = (
          completionSource === 'task_notification'
            ? notificationRecord?.timestamp
            : completionSource === 'task_output'
              ? latestTaskOutput?.toolResult?.timestamp
              : explicitCompletedAt
        ) || (
          isSubagentComplete && tr
            ? findNextTimestamp(messages, messageIndex, msg.timestamp)
            : undefined
        );

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        const existingChildToolIds = new Set<string>();
        for (const tool of historicalChildTools) {
          if (!tool?.toolId || existingChildToolIds.has(tool.toolId)) {
            continue;
          }
          childTools.push({
            toolId: tool.toolId,
            toolName: tool.toolName,
            toolInput: tool.toolInput,
            toolResult: tool.toolResult || null,
            timestamp: new Date(tool.timestamp || Date.now()),
          });
          existingChildToolIds.add(tool.toolId);
        }
        if (isSubagentContainer && !isSubagentDetailsAlias) {
          for (const childToolRecord of realtimeChildToolRecords) {
            if (!childToolRecord.toolUse.toolId || existingChildToolIds.has(childToolRecord.toolUse.toolId)) {
              continue;
            }
            childTools.push({
              toolId: childToolRecord.toolUse.toolId,
              toolName: childToolRecord.toolUse.toolName || 'UnknownTool',
              toolInput: childToolRecord.toolUse.toolInput,
              toolResult: childToolRecord.toolResult
                ? {
                    content: childToolRecord.toolResult.content,
                    isError: Boolean(childToolRecord.toolResult.isError),
                  }
                : null,
              timestamp: new Date(childToolRecord.toolUse.timestamp),
            });
            existingChildToolIds.add(childToolRecord.toolUse.toolId);
          }
          for (const taskOutputRecord of taskOutputRecords) {
            if (!taskOutputRecord.toolUse.toolId || existingChildToolIds.has(taskOutputRecord.toolUse.toolId)) {
              continue;
            }
            childTools.push({
              toolId: taskOutputRecord.toolUse.toolId,
              toolName: taskOutputRecord.toolUse.toolName || 'TaskOutput',
              toolInput: taskOutputRecord.toolUse.toolInput,
              toolResult: taskOutputRecord.toolResult
                ? {
                    content: taskOutputRecord.parsedResult.result,
                    isError: Boolean(taskOutputRecord.toolResult.isError),
                    taskOutputStatus: taskOutputRecord.parsedResult.status,
                  }
                : null,
              timestamp: new Date(taskOutputRecord.toolUse.timestamp),
            });
            existingChildToolIds.add(taskOutputRecord.toolUse.toolId);
          }
          childTools.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
        }

        const toolResult = isSubagentContainer && completionSource === 'task_notification' && taskNotification
          ? {
              content: taskNotification.result ||
                taskNotification.summary ||
                'Background task finished',
              isError: isTaskNotificationError(taskNotification.status),
              toolUseResult: (tr as any)?.toolUseResult,
              timestamp: toolCompletedAt,
              resultSource: 'task_notification',
            }
          : isSubagentContainer && completionSource === 'task_output' && latestTaskOutput
            ? {
                content: taskOutputSequence.join('\n\n'),
                isError: isTaskNotificationError(latestTaskOutput.parsedResult.status || ''),
                toolUseResult: (tr as any)?.toolUseResult,
                timestamp: toolCompletedAt,
                resultSource: 'task_output',
              }
          : tr && (!isSubagentContainer || isSubagentComplete)
            ? {
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
                isError: Boolean(tr.isError),
                toolUseResult: (tr as any).toolUseResult,
                timestamp: toolCompletedAt,
              }
            : null;

        converted.push({
          ...getMessageIdentity(msg),
          type: 'assistant',
          content: '',
          timestamp: msg.timestamp,
          isToolUse: true,
          toolName: msg.toolName,
          toolInput: typeof msg.toolInput === 'string' ? msg.toolInput : JSON.stringify(msg.toolInput ?? '', null, 2),
          toolId: msg.toolId,
          toolResult,
          toolCompletedAt,
          isSubagentContainer,
          taskNotification,
          subagentState: isSubagentContainer
            ? {
                agentId: subagentAgentId,
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: isSubagentComplete,
                detailsOwnerToolId,
              }
            : undefined,
        });
        break;
      }

      case 'thinking':
        if (msg.content?.trim()) {
          converted.push({
            ...getMessageIdentity(msg),
            type: 'assistant',
            content: unescapeWithMathProtection(msg.content),
            timestamp: msg.timestamp,
            isThinking: true,
          });
        }
        break;

      case 'error':
        converted.push({
          ...getMessageIdentity(msg),
          type: 'error',
          content: msg.content || 'Unknown error',
          diagnostics: msg.diagnostics as ChatMessage['diagnostics'],
          timestamp: msg.timestamp,
        });
        break;

      case 'interactive_prompt':
        converted.push({
          ...getMessageIdentity(msg),
          type: 'assistant',
          content: msg.content || '',
          timestamp: msg.timestamp,
          isInteractivePrompt: true,
        });
        break;

      case 'task_notification':
        if (resolveSubagentToolIdAt({
          eventIndex: messageIndex,
          taskId: msg.taskId,
          toolUseId: msg.toolUseId,
        })) {
          break;
        }
        converted.push({
          ...getMessageIdentity(msg),
          type: 'assistant',
          content: msg.summary || 'Background task update',
          timestamp: msg.timestamp,
          isTaskNotification: true,
          taskStatus: msg.status || 'completed',
        });
        break;

      case 'hook_activity': {
        if (groupedHookFollowupIds.has(msg.id)) {
          break;
        }
        const status = normalizeHookActivityStatus(msg.status);
        const persistedFollowups = msg.activityKind === 'execution'
          ? (hookFollowupsByExecutionMessageId.get(msg.id) || []).map((followup) => (
            toHookFollowupDetails(
              followup,
              hookRecoveryMessagesByActivityId.get(hookActivityIdentity(followup)),
            )
          ))
          : undefined;
        const recoveredFollowups = msg.activityKind === 'execution'
          ? [...hookRecoveryExecutionMessageByActivityId.entries()]
            .filter(([, executionMessage]) => executionMessage.id === msg.id)
            .map(([activityId]) => {
              const recoveryMessages = hookRecoveryMessagesByActivityId.get(activityId) || [];
              const executionPrefix = hookExecutionActivityPrefix(msg);
              const actionTypes = msg.actionTypes || [];
              const actionType = actionTypes.includes('invoke_skill')
                ? 'invoke_skill'
                : actionTypes.includes('send_agent_message')
                  ? 'send_agent_message'
                  : undefined;
              return {
                jobId: activityId,
                executionId: msg.executionId,
                actionId: executionPrefix && activityId.startsWith(`${executionPrefix}_`)
                  ? activityId.slice(executionPrefix.length + 1)
                  : undefined,
                actionType,
                status,
                timestamp: recoveryMessages[0]?.timestamp || msg.timestamp,
                messages: normalizedToChatMessages(recoveryMessages),
              } satisfies HookFollowupActivityDetails;
            })
          : [];
        const followups = msg.activityKind === 'execution'
          ? [...(persistedFollowups || []), ...recoveredFollowups]
          : undefined;
        converted.push({
          ...getMessageIdentity(msg),
          type: 'hook',
          content: msg.summary || msg.hookName || msg.skillName || '',
          timestamp: msg.timestamp,
          isHookActivity: true,
          hookActivity: {
            jobId: msg.jobId,
            executionId: msg.executionId,
            hookId: msg.hookId,
            hookName: msg.hookName,
            activityKind: msg.activityKind,
            actionId: msg.actionId,
            actionType: msg.actionType,
            eventName: msg.eventName,
            actionTypes: msg.actionTypes,
            ...(msg.actionResults && msg.actionResults.length > 0
              ? { actionResults: msg.actionResults }
              : {}),
            hasScript: msg.hasScript,
            skillName: msg.skillName,
            summary: msg.summary,
            queuePosition: msg.queuePosition,
            status,
            error: msg.error,
            followups,
          },
        });
        break;
      }

      case 'stream_delta':
        if (msg.content) {
          converted.push({
            ...getMessageIdentity(msg),
            type: 'assistant',
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: true,
          });
        }
        break;

      // stream_end, complete, status, permission_*, session_created
      // are control events — not rendered as messages
      case 'stream_end':
      case 'complete':
      case 'status':
      case 'permission_request':
      case 'permission_cancelled':
      case 'session_created':
        // Skip — these are handled by useChatRealtimeHandlers
        break;

      // tool_result is handled via attachment to tool_use above
      case 'tool_result':
        break;

      default:
        break;
    }
  }

  return converted;
}
