/**
 * Message normalization utilities.
 * Converts NormalizedMessage[] from the session store into ChatMessage[] for the UI.
 */

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage, SubagentChildTool } from '../types/types';
import { decodeHtmlEntities, unescapeWithMathProtection, formatUsageLimitText } from '../utils/chatFormatting';

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

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const msg = messages[messageIndex];

    switch (msg.kind) {
      case 'text': {
        const content = msg.content || '';
        if (!content.trim()) continue;

        if (msg.role === 'user') {
          // Parse task notifications
          const taskNotifRegex = /<task-notification>\s*<task-id>[^<]*<\/task-id>\s*<output-file>[^<]*<\/output-file>\s*<status>([^<]*)<\/status>\s*<summary>([^<]*)<\/summary>\s*<\/task-notification>/g;
          const taskNotifMatch = taskNotifRegex.exec(content);
          if (taskNotifMatch) {
            converted.push({
              ...getMessageIdentity(msg),
              type: 'assistant',
              content: taskNotifMatch[2]?.trim() || 'Background task finished',
              timestamp: msg.timestamp,
              isTaskNotification: true,
              taskStatus: taskNotifMatch[1]?.trim() || 'completed',
            });
          } else {
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
        const toolCompletedAt = explicitCompletedAt ||
          (tr ? findNextTimestamp(messages, messageIndex, msg.timestamp) : undefined);
        const isSubagentContainer = msg.toolName === 'Task';

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

        const toolResult = tr
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
          subagentState: isSubagentContainer
            ? {
                childTools,
                currentToolIndex: childTools.length > 0 ? childTools.length - 1 : -1,
                isComplete: Boolean(toolResult),
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
