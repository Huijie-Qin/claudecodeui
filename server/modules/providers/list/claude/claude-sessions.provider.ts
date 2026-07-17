import path from 'node:path';

import { getSessionMessages, getSessionMessagesFromProjectsRoot } from '@/projects.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';

const PROVIDER = 'claude';

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
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
 * Those are useful for the CLI but should not appear in the user-facing chat.
 */
const INTERNAL_CONTENT_PREFIXES = [
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

function isInternalContent(content: string): boolean {
  const normalizedContent = content.trimStart();
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => normalizedContent.startsWith(prefix));
}

function cleanAssistantText(text: string): string {
  return text.replace(/<\|assistant\|>/g, '');
}

function resolveConversationRole(raw: AnyRecord): 'user' | 'assistant' | undefined {
  if (raw.type === 'user') return 'user';
  if (raw.type === 'assistant') return 'assistant';
  if (raw.message?.role === 'user' || raw.message?.role === 'assistant') {
    return raw.message.role;
  }
  return undefined;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (
      raw.isSidechain === true ||
      raw.is_sidechain === true ||
      raw.isMeta === true ||
      raw.is_meta === true ||
      raw.message?.isMeta === true ||
      raw.message?.is_meta === true ||
      raw.message?.isSidechain === true ||
      raw.message?.is_sidechain === true
    ) {
      return [];
    }

    const streamEvent = raw.type === 'stream_event' ? readObjectRecord(raw.event) : raw;

    if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.text) {
      const content = cleanAssistantText(streamEvent.delta.text);
      if (!content) {
        return [];
      }
      return [createNormalizedMessage({ kind: 'stream_delta', content, sessionId, provider: PROVIDER })];
    }
    if (streamEvent?.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');
    const conversationRole = resolveConversationRole(raw);

    if (conversationRole === 'user' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
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
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            if (text && !isInternalContent(text)) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: text,
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
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
            }));
          }
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;
        if (text && !isInternalContent(text)) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: text,
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

    let result: ClaudeHistoryResult;
    try {
      result = options.runtimeHomePath
        ? await loadClaudeRuntimeSessionMessages(
          path.join(options.runtimeHomePath, '.claude', 'projects'),
          sessionId,
          limit,
          offset,
        )
        : await loadClaudeSessionMessages(projectStorageName, sessionId, limit, offset);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);
    const total = Array.isArray(result) ? rawMessages.length : (result.total || 0);
    const hasMore = Array.isArray(result) ? false : Boolean(result.hasMore);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
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
      }
    }

    return {
      messages: normalized,
      total,
      hasMore,
      offset,
      limit,
    };
  }
}
