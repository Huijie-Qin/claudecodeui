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

function readToolResultStatus(value: unknown): string | undefined {
  const record = readObject(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.status === 'string') {
    return record.status;
  }
  return readToolResultStatus(record.toolUseResult);
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
  const taskNotificationsByToolId = new Map<string, {
    notification: NonNullable<ChatMessage['taskNotification']>;
    timestamp: TimestampValue;
  }>();

  for (const msg of messages) {
    if (msg.kind !== 'text' || msg.role !== 'user' || !msg.content) {
      continue;
    }
    const notification = parseTaskNotification(msg.content);
    if (notification?.toolUseId && subagentToolIds.has(notification.toolUseId)) {
      taskNotificationsByToolId.set(notification.toolUseId, {
        notification,
        timestamp: msg.timestamp,
      });
    }
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
            if (taskNotification.toolUseId && subagentToolIds.has(taskNotification.toolUseId)) {
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
        const mappedToolResult = msg.toolId ? toolResultMap.get(msg.toolId) : null;
        const inlineToolResult = msg.toolResult as (NonNullable<NormalizedMessage['toolResult']> & Record<string, unknown>) | undefined;
        const tr = inlineToolResult || mappedToolResult;
        const explicitCompletedAt = mappedToolResult?.timestamp ||
          readTimestampField(inlineToolResult) ||
          readTimestampField((tr as any)?.toolUseResult);
        const isSubagentContainer = isSubagentToolName(msg.toolName);
        const notificationRecord = msg.toolId
          ? taskNotificationsByToolId.get(msg.toolId)
          : undefined;
        const taskNotification = notificationRecord?.notification;
        const taskNotificationIsTerminal = taskNotification
          ? isTaskNotificationTerminal(taskNotification.status)
          : false;
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
                : Boolean(tr) && !isBackgroundSubagent
            )
          : Boolean(tr);
        const toolCompletedAt = (
          taskNotificationIsTerminal
            ? notificationRecord?.timestamp
            : explicitCompletedAt
        ) || (
          isSubagentComplete && tr
            ? findNextTimestamp(messages, messageIndex, msg.timestamp)
            : undefined
        );

        // Build child tools from subagentTools
        const childTools: SubagentChildTool[] = [];
        if (isSubagentContainer && msg.subagentTools && Array.isArray(msg.subagentTools)) {
          for (const tool of msg.subagentTools as any[]) {
            childTools.push({
              toolId: tool.toolId,
              toolName: tool.toolName,
              toolInput: tool.toolInput,
              toolResult: tool.toolResult || null,
              timestamp: new Date(tool.timestamp || Date.now()),
            });
          }
        }

        const toolResult = isSubagentContainer && taskNotification && taskNotificationIsTerminal
          ? {
              content: taskNotification.result ||
                taskNotification.summary ||
                'Background task finished',
              isError: isTaskNotificationError(taskNotification.status),
              toolUseResult: (tr as any)?.toolUseResult,
              timestamp: toolCompletedAt,
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
