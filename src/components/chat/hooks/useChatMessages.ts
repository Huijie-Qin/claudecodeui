/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
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
    new Set(['agentId', 'agent_id', 'taskId', 'task_id']),
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
  const subagentToolIdByTaskId = new Map<string, string>();
  const subagentToolMessageById = new Map<string, NormalizedMessage>();
  const subagentToolCandidatesByTaskId = new Map<string, NormalizedMessage[]>();

  for (const msg of messages) {
    if (msg.kind !== 'tool_use' || !msg.toolId || !isSubagentToolName(msg.toolName)) {
      continue;
    }
    subagentToolMessageById.set(msg.toolId, msg);
    const mappedToolResult = toolResultMap.get(msg.toolId);
    const inlineToolResult = msg.toolResult as
      | (NonNullable<NormalizedMessage['toolResult']> & Record<string, unknown>)
      | undefined;
    const taskId = readSubagentTaskId(
      (inlineToolResult as any)?.toolUseResult ||
      (mappedToolResult as any)?.toolUseResult ||
      inlineToolResult ||
      mappedToolResult,
    );
    if (taskId) {
      const candidates = subagentToolCandidatesByTaskId.get(taskId) || [];
      candidates.push(msg);
      subagentToolCandidatesByTaskId.set(taskId, candidates);
    }
  }

  // Claude can emit both the legacy Task call and the current Agent call for
  // the same agentId. Keep the Task invocation visible, but make Agent the
  // single owner of execution details so child tools/results are not repeated.
  const subagentDetailsOwnerByAliasToolId = new Map<string, string>();
  for (const [taskId, candidates] of subagentToolCandidatesByTaskId) {
    let detailsOwner = candidates[candidates.length - 1];
    const hasTaskCandidate = candidates.some((candidate) => (
      candidate.toolName?.trim().toLowerCase() === 'task'
    ));
    const agentCandidates = candidates.filter((candidate) => (
      candidate.toolName?.trim().toLowerCase() === 'agent'
    ));
    if (hasTaskCandidate && agentCandidates.length > 0) {
      detailsOwner = agentCandidates[agentCandidates.length - 1];
      for (const candidate of candidates) {
        if (
          candidate.toolId &&
          candidate.toolId !== detailsOwner?.toolId &&
          candidate.toolName?.trim().toLowerCase() === 'task'
        ) {
          subagentDetailsOwnerByAliasToolId.set(candidate.toolId, detailsOwner.toolId as string);
        }
      }
    }
    if (detailsOwner?.toolId) {
      subagentToolIdByTaskId.set(taskId, detailsOwner.toolId);
    }
  }

  type SubagentChildToolRecord = {
    toolUse: NormalizedMessage;
    toolResult: NormalizedMessage | null;
  };
  const subagentChildToolsByParentToolId = new Map<string, SubagentChildToolRecord[]>();
  const associatedSubagentChildToolIds = new Set<string>();

  for (const msg of messages) {
    if (
      msg.kind !== 'tool_use' ||
      !msg.toolId ||
      !msg.parentToolUseId ||
      isTaskOutputToolName(msg.toolName) ||
      !subagentToolIds.has(msg.parentToolUseId)
    ) {
      continue;
    }
    const detailsParentToolId = subagentDetailsOwnerByAliasToolId.get(msg.parentToolUseId) ||
      msg.parentToolUseId;
    const records = subagentChildToolsByParentToolId.get(detailsParentToolId) || [];
    records.push({
      toolUse: msg,
      toolResult: toolResultMap.get(msg.toolId) || null,
    });
    subagentChildToolsByParentToolId.set(detailsParentToolId, records);
    associatedSubagentChildToolIds.add(msg.toolId);
  }

  const historicalSubagentToolsByParentToolId = new Map<string, any[]>();
  for (const [toolId, msg] of subagentToolMessageById) {
    if (!Array.isArray(msg.subagentTools) || msg.subagentTools.length === 0) {
      continue;
    }
    const detailsParentToolId = subagentDetailsOwnerByAliasToolId.get(toolId) || toolId;
    const records = historicalSubagentToolsByParentToolId.get(detailsParentToolId) || [];
    records.push(...msg.subagentTools);
    historicalSubagentToolsByParentToolId.set(detailsParentToolId, records);
  }

  const taskNotificationsByToolId = new Map<string, {
    notification: NonNullable<ChatMessage['taskNotification']>;
    timestamp: TimestampValue;
  }>();

  for (const msg of messages) {
    const notification = readTaskNotificationMessage(msg);
    if (!notification) {
      continue;
    }
    const parentToolId = notification.toolUseId && subagentToolIds.has(notification.toolUseId)
      ? subagentDetailsOwnerByAliasToolId.get(notification.toolUseId) || notification.toolUseId
      : notification.taskId
        ? subagentToolIdByTaskId.get(notification.taskId)
        : undefined;
    if (parentToolId) {
      taskNotificationsByToolId.set(parentToolId, {
        notification,
        timestamp: msg.timestamp,
      });
      if (notification.taskId) {
        subagentToolIdByTaskId.set(notification.taskId, parentToolId);
      }
    }
  }

  type TaskOutputRecord = {
    toolUse: NormalizedMessage;
    toolResult: NormalizedMessage | null;
    parsedResult: ReturnType<typeof readTaskOutputResult>;
  };
  const taskOutputsByParentToolId = new Map<string, TaskOutputRecord[]>();
  const associatedTaskOutputToolIds = new Set<string>();

  for (const msg of messages) {
    if (msg.kind !== 'tool_use' || !msg.toolId || !isTaskOutputToolName(msg.toolName)) {
      continue;
    }
    const taskId = readNestedStringField(msg.toolInput, new Set(['task_id', 'taskId']));
    const parentToolId = taskId ? subagentToolIdByTaskId.get(taskId) : undefined;
    if (!parentToolId) {
      continue;
    }
    const taskOutputResult = toolResultMap.get(msg.toolId) || null;
    const records = taskOutputsByParentToolId.get(parentToolId) || [];
    records.push({
      toolUse: msg,
      toolResult: taskOutputResult,
      parsedResult: readTaskOutputResult(taskOutputResult?.content),
    });
    taskOutputsByParentToolId.set(parentToolId, records);
    associatedTaskOutputToolIds.add(msg.toolId);
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          const taskNotification = parseTaskNotification(content);
          if (taskNotification) {
            const parentToolId = taskNotification.toolUseId && subagentToolIds.has(taskNotification.toolUseId)
              ? taskNotification.toolUseId
              : taskNotification.taskId
                ? subagentToolIdByTaskId.get(taskNotification.taskId)
                : undefined;
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
          ? [...(taskOutputsByParentToolId.get(msg.toolId) || [])].sort((left, right) => {
              const leftTime = timestampToMs(left.toolUse.timestamp);
              const rightTime = timestampToMs(right.toolUse.timestamp);
              return leftTime === null || rightTime === null ? 0 : leftTime - rightTime;
            })
          : [];
        const terminalTaskOutput = [...taskOutputRecords].reverse().find((record) => (
          record.parsedResult.status &&
          isTaskNotificationTerminal(record.parsedResult.status)
        ));
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
        const isSubagentComplete = isSubagentContainer
          ? (
              taskNotification
                ? taskNotificationIsTerminal
                : terminalTaskOutput
                  ? true
                  : Boolean(tr) && !isBackgroundSubagent
            )
          : Boolean(tr);
        const toolCompletedAt = (
          taskNotificationIsTerminal
            ? notificationRecord?.timestamp
            : terminalTaskOutput
              ? terminalTaskOutput.toolResult?.timestamp
              : explicitCompletedAt
        ) || (
          isSubagentComplete && tr
            ? findNextTimestamp(messages, messageIndex, msg.timestamp)
            : undefined
        );

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        const existingChildToolIds = new Set<string>();
        const historicalChildTools = isSubagentContainer && !isSubagentDetailsAlias && msg.toolId
          ? historicalSubagentToolsByParentToolId.get(msg.toolId) || []
          : [];
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
          const realtimeChildToolRecords = msg.toolId
            ? subagentChildToolsByParentToolId.get(msg.toolId) || []
            : [];
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

        const toolResult = isSubagentContainer && taskNotification && taskNotificationIsTerminal
          ? {
              content: taskNotification.result ||
                taskNotification.summary ||
                'Background task finished',
              isError: isTaskNotificationError(taskNotification.status),
              toolUseResult: (tr as any)?.toolUseResult,
              timestamp: toolCompletedAt,
              resultSource: 'task_notification',
            }
          : isSubagentContainer && terminalTaskOutput
            ? {
                content: taskOutputSequence.join('\n\n'),
                isError: isTaskNotificationError(terminalTaskOutput.parsedResult.status || ''),
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
        if (
          (msg.toolUseId && subagentToolIds.has(msg.toolUseId)) ||
          (msg.taskId && subagentToolIdByTaskId.has(msg.taskId))
        ) {
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
