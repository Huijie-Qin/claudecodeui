import path from 'node:path';

import { getSessionMessages, getSessionMessagesFromProjectsRoot } from '@/projects.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
} from '@/shared/utils.js';

import { readClaudeDisplayMetadata } from './claude-display-command-store.js';
import { orderSupplementMessages } from '../../../../../shared/messageDisplayOrder.js';

const PROVIDER: 'claude' = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentMessages?: unknown;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
      messages?: AnyRecord[];
      total?: number;
      hasMore?: boolean;
    };

const loadClaudeSessionMessages = getSessionMessages as unknown as (
  projectName: string,
  sessionId: string,
  limit: number | null,
  offset: number,
) => Promise<ClaudeHistoryResult>;

const loadClaudeRuntimeSessionMessages = getSessionMessagesFromProjectsRoot as unknown as (
  projectsRoot: string,
  sessionId: string,
  limit: number | null,
  offset: number,
) => Promise<ClaudeHistoryResult>;

export function resolveClaudeProjectStorageName(options: Pick<FetchHistoryOptions, 'projectName' | 'projectPath'>): string {
  if (options.projectPath) {
    return String(options.projectPath).replace(/[^a-zA-Z0-9-]/g, '-');
  }

  return options.projectName || '';
}

/**
 * Claude writes internal command and system reminder entries into history.
 * User slash invocations are restored before filtering; their internal wrappers
 * and expanded skill instructions should not appear in the user-facing chat.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<ccui-hook-recovery',
  '<ccui-mcp-loop-result',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<system-reminder>',
  '<!-- ECC:SUMMARY:START -->',
  'Base directory for this skill:',
  '# Session:',
  'Hook SessionStart:',
  'Previous session summary:',
  'Caveat:',
  'This session is being continued from a previous',
  '[Request interrupted',
] as const;

const INTERNAL_SKILL_CONTENT_MARKERS = [
  'Base directory for this skill:',
] as const;

const INTERNAL_SKILL_CONTENT_PATTERNS = [
  /^\s*<[^>\n]*skill[^>\n]*>/i,
  /^\s*skill\s+(?:body|content|detail|details|instructions|parameters|params|arguments|args)\s*:/i,
] as const;

function isInternalContent(content: string): boolean {
  const normalizedContent = content.trimStart();
  return (
    INTERNAL_CONTENT_PREFIXES.some((prefix) => normalizedContent.startsWith(prefix)) ||
    INTERNAL_SKILL_CONTENT_MARKERS.some((marker) => normalizedContent.includes(marker)) ||
    INTERNAL_SKILL_CONTENT_PATTERNS.some((pattern) => pattern.test(normalizedContent))
  );
}

function cleanAssistantText(text: string): string {
  return text.replace(/<\|assistant\|>/g, '');
}

function readNativeSlashInvocation(text: string): string | null {
  // Match the entire command envelope so expanded instructions and unrelated
  // internal messages cannot be mistaken for a user query.
  const match = text.match(/^\s*<command-message>[^<]*<\/command-message>\s*<command-name>(\/[^\s<>]+)<\/command-name>(?:\s*<command-args>([\s\S]*)<\/command-args>)?\s*$/);
  if (!match) {
    return null;
  }
  const args = match[2]?.trim() || '';
  return `${match[1]}${args ? ` ${args}` : ''}`;
}

function resolveVisibleUserText(
  text: string,
  storedDisplayCommand: string | null = null,
  restoreNativeCommand = false,
): string | null {
  if (storedDisplayCommand) {
    return isInternalContent(storedDisplayCommand) ? null : storedDisplayCommand;
  }

  if (restoreNativeCommand) {
    const invocation = readNativeSlashInvocation(text);
    if (invocation) {
      return invocation;
    }
  }

  return isInternalContent(text) ? null : text;
}

function resolveConversationRole(raw: AnyRecord): 'user' | 'assistant' | undefined {
  if (raw.type === 'user') return 'user';
  if (raw.type === 'assistant') return 'assistant';
  if (raw.message?.role === 'user' || raw.message?.role === 'assistant') {
    return raw.message.role;
  }
  return undefined;
}

function readHookRecoveryActivityId(displayCommand: string | null): string | null {
  if (!displayCommand?.startsWith('<ccui-hook-recovery')) {
    return null;
  }
  const match = displayCommand.match(/\bactivity=(['"])([^'"]+)\1/i);
  return match?.[2]?.trim() || null;
}

function normalizeTaskStatus(status: unknown): string | undefined {
  if (typeof status !== 'string' || !status.trim()) {
    return undefined;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === 'killed' ? 'stopped' : normalized;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(
    rawMessage: unknown,
    sessionId: string | null,
    storedDisplayCommand: string | null = null,
    includeSidechain = false,
  ): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (
      raw.isMeta === true ||
      raw.is_meta === true ||
      raw.message?.isMeta === true ||
      raw.message?.is_meta === true
    ) {
      return [];
    }

    if (
      !includeSidechain && (
      raw.isSidechain === true ||
      raw.is_sidechain === true ||
      raw.message?.isSidechain === true ||
      raw.message?.is_sidechain === true)
    ) {
      return [];
    }

    const streamEvent = raw.type === 'stream_event' ? readObjectRecord(raw.event) : raw;
    const assistantMessageId = raw.assistantMessageId || raw.message?.id;
    const assistantIdentity = typeof assistantMessageId === 'string' ? { assistantMessageId } : {};

    if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.text) {
      const content = cleanAssistantText(streamEvent.delta.text);
      if (!content) {
        return [];
      }
      return [createNormalizedMessage({ kind: 'stream_delta', content, sessionId, provider: PROVIDER, ...assistantIdentity })];
    }
    if (streamEvent?.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER, ...assistantIdentity })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');
    const conversationRole = resolveConversationRole(raw);

    if (raw.type === 'system' && typeof raw.subtype === 'string') {
      const taskId = typeof raw.task_id === 'string' ? raw.task_id : undefined;
      const toolUseId = typeof raw.tool_use_id === 'string' ? raw.tool_use_id : undefined;
      const commonTaskFields = {
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'task_notification' as const,
        taskId,
        toolUseId,
      };

      if (raw.subtype === 'task_started') {
        return [createNormalizedMessage({
          ...commonTaskFields,
          status: 'running',
          summary: typeof raw.description === 'string' ? raw.description : 'Background task started',
        })];
      }

      if (raw.subtype === 'task_progress') {
        return [createNormalizedMessage({
          ...commonTaskFields,
          status: 'running',
          summary: typeof raw.summary === 'string'
            ? raw.summary
            : typeof raw.description === 'string'
              ? raw.description
              : 'Background task is running',
          usage: readObjectRecord(raw.usage) || {},
        })];
      }

      if (raw.subtype === 'task_updated') {
        const patch = readObjectRecord(raw.patch);
        return [createNormalizedMessage({
          ...commonTaskFields,
          status: normalizeTaskStatus(patch?.status) || 'running',
          summary: typeof patch?.error === 'string'
            ? patch.error
            : typeof patch?.description === 'string'
              ? patch.description
              : 'Background task updated',
        })];
      }

      if (raw.subtype === 'task_notification') {
        return [createNormalizedMessage({
          ...commonTaskFields,
          status: normalizeTaskStatus(raw.status) || 'completed',
          summary: typeof raw.summary === 'string' ? raw.summary : 'Background task finished',
          outputFile: typeof raw.output_file === 'string' ? raw.output_file : undefined,
          result: typeof raw.result === 'string' ? raw.result : undefined,
          usage: readObjectRecord(raw.usage) || {},
        })];
      }
    }

    if (conversationRole === 'user' && raw.message?.content) {
      const clientMessageId = typeof raw.uuid === 'string' ? raw.uuid : undefined;
      const restoreNativeCommand = raw.type === 'user' && raw.message.role === 'user';
      if (Array.isArray(raw.message.content)) {
        let didUseStoredDisplayCommand = false;
        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              subagentMessages: raw.subagentMessages,
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult ?? raw.tool_use_result,
            }));
          } else if (part.type === 'text') {
            if (storedDisplayCommand && didUseStoredDisplayCommand) {
              continue;
            }
            const text = part.text || '';
            const visibleText = text
              ? resolveVisibleUserText(
                text,
                didUseStoredDisplayCommand ? null : storedDisplayCommand,
                restoreNativeCommand,
              )
              : null;
            if (visibleText) {
              didUseStoredDisplayCommand = Boolean(storedDisplayCommand);
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                clientMessageId,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: visibleText,
              }));
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          const visibleTextParts = textParts
            ? resolveVisibleUserText(textParts, storedDisplayCommand, restoreNativeCommand)
            : null;
          if (visibleTextParts) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              clientMessageId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: visibleTextParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;
        const visibleText = text
          ? resolveVisibleUserText(text, storedDisplayCommand, restoreNativeCommand)
          : null;
        if (visibleText) {
          messages.push(createNormalizedMessage({
            id: baseId,
            clientMessageId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: visibleText,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (conversationRole === 'assistant' && raw.message?.content) {
      let didAttachUsage = false;
      const attachUsage = () => {
        if (didAttachUsage || !raw.message?.usage) {
          return {};
        }
        didAttachUsage = true;
        return { usage: raw.message.usage };
      };

      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            const content = cleanAssistantText(part.text);
            if (!content) {
              partIndex++;
              continue;
            }
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content,
              ...attachUsage(),
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        const content = cleanAssistantText(raw.message.content);
        if (!content) {
          return messages;
        }
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content,
          ...attachUsage(),
        }));
      }
      for (const message of messages) Object.assign(message, assistantIdentity);
      return messages;
    }

    return messages;
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const projectStorageName = resolveClaudeProjectStorageName(options);
    if (!options.runtimeHomePath && !projectStorageName) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    let displayMetadata = new Map<string, { displayCommand?: string; displayAfterAssistantId?: string; supplementSequence?: number }>();
    if (options.runtimeHomePath) {
      try {
        displayMetadata = await readClaudeDisplayMetadata({ runtimeHomePath: options.runtimeHomePath, sessionId });
      } catch (error) {
        console.warn(`[ClaudeProvider] Failed to load display metadata for ${sessionId}:`, String(error));
      }
    }
    // Clients advance their offset by the number of normalized messages returned.
    // Normalize before pagination: hidden skill bodies consume JSONL rows, while
    // a single assistant row can expand into multiple messages. Raw-row offsets
    // would otherwise repeat or skip messages on the next page.

    let result: ClaudeHistoryResult;
    try {
      result = options.runtimeHomePath
        ? await loadClaudeRuntimeSessionMessages(
          path.join(options.runtimeHomePath, '.claude', 'projects'),
          sessionId,
          null,
          0,
        )
        : await loadClaudeSessionMessages(projectStorageName, sessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentMessages: raw.subagentMessages,
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult ?? raw.tool_use_result,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    let activeHookActivityId: string | null = null;
    for (const raw of rawMessages) {
      const metadata = typeof raw.uuid === 'string' ? displayMetadata.get(raw.uuid) : undefined;
      const displayCommand = metadata?.displayCommand || null;
      const recoveryActivityId = readHookRecoveryActivityId(displayCommand);
      const nextMessages = this.normalizeMessage(raw, sessionId, displayCommand);
      if (metadata?.displayAfterAssistantId) {
        for (const message of nextMessages) {
          if (message.kind === 'text' && message.role === 'user') {
            message.displayAfterAssistantId = metadata.displayAfterAssistantId;
            message.supplementSequence = metadata.supplementSequence;
          }
        }
      }
      if (recoveryActivityId) {
        activeHookActivityId = recoveryActivityId;
      } else if (nextMessages.some((message) => message.kind === 'text' && message.role === 'user')) {
        activeHookActivityId = null;
      }
      if (activeHookActivityId) {
        nextMessages.forEach((message) => {
          message.hookActivityId = activeHookActivityId || undefined;
        });
      }
      normalized.push(...nextMessages);
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
        if (Array.isArray(toolResult.subagentMessages)) {
          msg.subagentMessages = toolResult.subagentMessages.flatMap((subagentRaw) => {
            const nested = this.normalizeMessage(subagentRaw, sessionId, null, true);
            const rawRecord = readObjectRecord(subagentRaw);
            const nestedParentToolUseId = typeof rawRecord?.parentToolUseId === 'string'
              ? rawRecord.parentToolUseId
              : typeof rawRecord?.parent_tool_use_id === 'string'
                ? rawRecord.parent_tool_use_id
                : msg.toolId;
            return nested.map((subagentMessage) => ({
              ...subagentMessage,
              parentToolUseId: subagentMessage.parentToolUseId || nestedParentToolUseId,
            }));
          });
        }
      }
    }

    const ordered = orderSupplementMessages(normalized);
    const end = Math.max(0, ordered.length - Math.max(0, offset));
    const start = limit === null ? 0 : Math.max(0, end - Math.max(0, limit));
    return { messages: ordered.slice(start, end), total: ordered.length, hasMore: start > 0, offset, limit };
  }
}
