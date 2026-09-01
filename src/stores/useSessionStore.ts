/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import type { LLMProvider } from '../types/app';
import { authenticatedFetch } from '../utils/api';

import { buildSessionMessagesUrl } from './sessionRequestUrl';
import {
  computeMerged,
  dropSupersededStreamingPlaceholders,
  reconcileRealtimeAfterServerRefresh,
  upsertRealtimeMessages,
} from './sessionMerge';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'hook_activity';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  origin?: 'hook';
  activityKind?: 'execution' | 'followup';
  hookActivityId?: string;
  role?: 'user' | 'assistant';
  content?: string;
  clientMessageId?: string;
  queueStatus?: 'queued' | 'processing' | 'failed';
  queuePosition?: number;
  images?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  toolUseResult?: unknown;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  jobId?: string;
  executionId?: string;
  hookId?: string;
  hookName?: string;
  actionId?: string;
  actionType?: 'invoke_skill' | 'send_agent_message' | 'mcp_loop_run';
  eventName?: string;
  actionTypes?: Array<'call_mcp_tool' | 'mcp_loop_run' | 'write_record' | 'invoke_skill' | 'send_agent_message'>;
  actionResults?: Array<{
    actionId: string;
    actionType: 'call_mcp_tool' | 'mcp_loop_run' | 'write_record';
    output?: unknown;
    record?: {
      id: string;
      type?: string;
      data?: unknown;
      createdAt?: string;
    };
  }>;
  hasScript?: boolean;
  skillName?: string;
  error?: string;
  taskId?: string;
  toolUseId?: string;
  outputFile?: string;
  result?: string;
  usage?: Record<string, string | number>;
  exitCode?: number;
  diagnostics?: Record<string, unknown>;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  subagentMessages?: NormalizedMessage[];
  isFinal?: boolean;
  mcpLoopReplacement?: boolean;
  mcpLoopJobId?: string;
  loopJobId?: string;
  loopStatus?: string;
  loopAttemptCount?: number;
  loopStartedAtMs?: number;
  loopNextPollAtMs?: number;
  loopTargetTool?: string;
  loopToolUseId?: string;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
  };
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

function isStreamingPlaceholder(message: NormalizedMessage): boolean {
  return message.kind === 'stream_delta' && message.id.startsWith('__streaming_');
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    if (sessionId === activeSessionIdRef.current) {
      setTick(n => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const store = storeRef.current;
    if (!store.has(sessionId)) {
      store.set(sessionId, createEmptySlot());
    }
    return store.get(sessionId)!;
  }, []);

  const has = useCallback((sessionId: string) => storeRef.current.has(sessionId), []);

  /**
   * Fetch messages from the unified endpoint and populate serverMessages.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectName?: string;
      projectPath?: string;
      workspaceId?: number;
      limit?: number | null;
      offset?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    slot.status = 'loading';
    notify(sessionId);

    try {
      const url = buildSessionMessagesUrl(sessionId, opts);
      const response = await authenticatedFetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const messages: NormalizedMessage[] = data.messages || [];

      slot.serverMessages = messages;
      slot.total = data.total ?? messages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = (opts.offset ?? 0) + messages.length;
      slot.fetchedAt = Date.now();
      slot.status = 'idle';
      recomputeMergedIfNeeded(slot);
      if (data.tokenUsage) {
        slot.tokenUsage = data.tokenUsage;
      }

      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
      slot.status = 'error';
      notify(sessionId);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectName?: string;
      projectPath?: string;
      workspaceId?: number;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const limit = opts.limit ?? 20;
    const url = buildSessionMessagesUrl(sessionId, {
      ...opts,
      limit,
      offset: slot.offset,
    });

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      slot.serverMessages = [...olderMessages, ...slot.serverMessages];
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    let updated = dropSupersededStreamingPlaceholders(
      upsertRealtimeMessages(slot.realtimeMessages, [msg]),
    );
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    let updated = dropSupersededStreamingPlaceholders(
      upsertRealtimeMessages(slot.realtimeMessages, msgs),
    );
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the unified endpoint (e.g., on projects_updated).
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectName?: string;
      projectPath?: string;
      workspaceId?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    try {
      const url = buildSessionMessagesUrl(sessionId, opts);
      const response = await authenticatedFetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      slot.serverMessages = data.messages || [];
      slot.total = data.total ?? slot.serverMessages.length;
      slot.hasMore = Boolean(data.hasMore);
      slot.fetchedAt = Date.now();
      // Drop only messages confirmed by the refreshed history. The history
      // endpoint can briefly lag the complete event, so unmatched realtime
      // messages must remain visible until a later refresh catches up.
      slot.realtimeMessages = reconcileRealtimeAfterServerRefresh(
        slot.serverMessages,
        slot.realtimeMessages,
      );
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    } catch (error) {
      console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
    }
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((
    sessionId: string,
    accumulatedText: string,
    msgProvider: LLMProvider,
    options: { id?: string; timestamp?: string; parentToolUseId?: string } = {},
  ) => {
    const slot = getSlot(sessionId);
    const streamId = options.id || `__streaming_${sessionId}`;
    const existingStream = slot.realtimeMessages.find(m => m.id === streamId);
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId,
      timestamp: existingStream?.timestamp || options.timestamp || new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
      ...(options.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (!slot) return;
    const streamingIndexes = slot.realtimeMessages
      .map((message, index) => isStreamingPlaceholder(message) ? index : -1)
      .filter(index => index >= 0);
    if (streamingIndexes.length > 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      for (const idx of streamingIndexes) {
        const stream = slot.realtimeMessages[idx];
        slot.realtimeMessages[idx] = {
          ...stream,
          id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          kind: 'text',
          role: 'assistant',
        };
      }
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const slot = storeRef.current.get(sessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
    }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(sessionId)?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(sessionId);
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
