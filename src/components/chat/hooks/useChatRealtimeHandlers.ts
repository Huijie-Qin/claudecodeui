import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ChatMessage, PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

import {
  scheduleProjectsRefresh,
  shouldRefreshProjectsForRealtimeMessage,
} from './chatRealtimeRefresh';
import {
  getExplicitRealtimeSessionId,
  resolvePermissionRequestRouting,
} from './permissionRequestRouting';
import { shouldAdoptCreatedSession } from './sessionCreatedRouting';
import type { SessionStreamAccumulator } from './sessionStreamAccumulator';
import {
  getRealtimeErrorContent,
  isPendingViewTerminalMessage,
} from './chatRealtimeErrors';

type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  timestamp?: string;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  subscribeMessage?: (listener: (message: LatestChatMessage) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamAccumulatorRef: MutableRefObject<SessionStreamAccumulator>;
  streamTimersRef: MutableRefObject<Map<string, number>>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onReplaceTemporarySession?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string) => void;
  onWebSocketReconnect?: () => void;
  addMessage?: (message: ChatMessage) => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  latestMessage,
  subscribeMessage,
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamAccumulatorRef,
  streamTimersRef,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  onReplaceTemporarySession,
  onNavigateToSession,
  onWebSocketReconnect,
  addMessage,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);

  const processRealtimeMessage = useCallback((incomingMessage: LatestChatMessage | null) => {
    if (!incomingMessage) return;
    if (lastProcessedMessageRef.current === incomingMessage) return;
    lastProcessedMessageRef.current = incomingMessage;

    const activeViewSessionId = selectedSession?.id || currentSessionId || null;

    /* ---------------------------------------------------------------- */
    /*  Legacy messages (no `kind` field) — handle and return           */
    /* ---------------------------------------------------------------- */

    const msg = incomingMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const status = msg.status;
          if (status) {
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          // Legacy isProcessing format from check-session-status
          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          if (msg.isProcessing) {
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }
          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const explicitSessionId = getExplicitRealtimeSessionId(msg);
    const sid = explicitSessionId || activeViewSessionId;
    const isActiveViewSession = Boolean(sid && sid === activeViewSessionId);
    const pendingTerminalMessage = isPendingViewTerminalMessage({
      kind: msg.kind,
      explicitSessionId,
      activeViewSessionId,
      hasPendingViewSession: Boolean(pendingViewSessionRef.current),
      selectedSessionId: selectedSession?.id || null,
    });
    const pendingLifecycleSessionId = pendingTerminalMessage
      ? pendingViewSessionRef.current?.sessionId || null
      : null;
    const lifecycleSessionId = sid || pendingLifecycleSessionId;
    const shouldAffectCurrentView = isActiveViewSession || pendingTerminalMessage;

    const clearStreamTimer = (sessionId: string) => {
      const timerId = streamTimersRef.current.get(sessionId);
      if (!timerId) return;
      clearTimeout(timerId);
      streamTimersRef.current.delete(sessionId);
    };

    const flushStream = (sessionId: string) => {
      clearStreamTimer(sessionId);
      const finalText = streamAccumulatorRef.current.finish(sessionId);
      if (finalText) {
        sessionStore.updateStreaming(sessionId, finalText, provider);
      }
    };

    const finalizeStreamFallback = (sessionId: string) => {
      flushStream(sessionId);
      sessionStore.finalizeStreaming(sessionId);
    };

    // --- Streaming: buffer for performance ---
    if (msg.kind === 'stream_delta') {
      if (!sid) return;
      const text = msg.content || '';
      if (!text) return;
      streamAccumulatorRef.current.appendDelta(sid, text);
      if (!streamTimersRef.current.has(sid)) {
        const timerId = window.setTimeout(() => {
          streamTimersRef.current.delete(sid);
          const accumulatedText = streamAccumulatorRef.current.get(sid);
          if (accumulatedText) {
            sessionStore.updateStreaming(sid, accumulatedText, provider);
          }
        }, 100);
        streamTimersRef.current.set(sid, timerId);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (sid) {
        flushStream(sid);
      }
      return;
    }

    // --- All other messages: route to store ---
    if (sid) {
      if (msg.kind === 'text' && msg.role === 'assistant') {
        clearStreamTimer(sid);
        streamAccumulatorRef.current.clear(sid);
      }
      sessionStore.appendRealtime(sid, { ...msg, sessionId: sid } as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;

        const shouldAdoptSession = shouldAdoptCreatedSession({
          newSessionId,
          currentSessionId,
          selectedSessionId: selectedSession?.id || null,
          hasPendingViewSession: Boolean(pendingViewSessionRef.current),
        });

        if (shouldAdoptSession) {
          sessionStorage.setItem('pendingSessionId', newSessionId);
          if (pendingViewSessionRef.current) {
            pendingViewSessionRef.current.sessionId = newSessionId;
          }
          setCurrentSessionId(newSessionId);
          onReplaceTemporarySession?.(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
          onNavigateToSession?.(newSessionId);
        }
        if (shouldRefreshProjectsForRealtimeMessage(msg)) {
          scheduleProjectsRefresh(250);
        }
        break;
      }

      case 'complete': {
        if (sid) {
          finalizeStreamFallback(sid);
        }

        if (shouldAffectCurrentView) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setPendingPermissionRequests([]);
        }
        onSessionInactive?.(lifecycleSessionId);
        onSessionNotProcessing?.(lifecycleSessionId);
        if (pendingTerminalMessage) {
          pendingViewSessionRef.current = null;
        } else if (pendingViewSessionRef.current?.sessionId === sid) {
          pendingViewSessionRef.current = null;
        }

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        if (shouldRefreshProjectsForRealtimeMessage({ ...msg, sessionId: sid || msg.sessionId })) {
          scheduleProjectsRefresh(500);
        }

        // Clear pending session
        const pendingSessionId = sessionStorage.getItem('pendingSessionId');
        if (pendingSessionId && !currentSessionId && msg.exitCode === 0) {
          const actualId = msg.actualSessionId || pendingSessionId;
          setCurrentSessionId(actualId);
          if (msg.actualSessionId) {
            onNavigateToSession?.(actualId);
          }
          sessionStorage.removeItem('pendingSessionId');
        }
        break;
      }

      case 'error': {
        if (sid) {
          clearStreamTimer(sid);
          streamAccumulatorRef.current.clear(sid);
        }
        if (pendingTerminalMessage) {
          addMessage?.({
            type: 'error',
            content: getRealtimeErrorContent(msg),
            timestamp: msg.timestamp || new Date(),
          });
        }
        if (shouldAffectCurrentView) {
          setIsLoading(false);
          setCanAbortSession(false);
          setClaudeStatus(null);
          setPendingPermissionRequests([]);
        }
        onSessionInactive?.(lifecycleSessionId);
        onSessionNotProcessing?.(lifecycleSessionId);
        if (pendingTerminalMessage) {
          pendingViewSessionRef.current = null;
        } else if (pendingViewSessionRef.current?.sessionId === sid) {
          pendingViewSessionRef.current = null;
        }
        break;
      }

      case 'permission_request': {
        if (!msg.requestId) break;
        const permissionRouting = resolvePermissionRequestRouting({
          messageSessionId: explicitSessionId,
          activeViewSessionId,
          selectedSessionId: selectedSession?.id || null,
        });

        if (!permissionRouting.shouldSurface) break;

        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: permissionRouting.sessionId || null,
            receivedAt: new Date(),
          }];
        });
        if (permissionRouting.sessionId && permissionRouting.sessionId === activeViewSessionId) {
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({
            text: msg.toolName === 'AskUserQuestion' ? 'Waiting for answer' : 'Waiting for confirmation',
            tokens: 0,
            can_interrupt: true,
          });
        }
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (!isActiveViewSession) break;
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  }, [
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamAccumulatorRef,
    streamTimersRef,
    onSessionInactive,
    onSessionProcessing,
    onSessionNotProcessing,
    onReplaceTemporarySession,
    onNavigateToSession,
    onWebSocketReconnect,
    addMessage,
    sessionStore,
  ]);

  const processRealtimeMessageRef = useRef(processRealtimeMessage);
  useEffect(() => {
    processRealtimeMessageRef.current = processRealtimeMessage;
  }, [processRealtimeMessage]);

  useEffect(() => {
    if (!subscribeMessage) return undefined;
    return subscribeMessage((message) => {
      processRealtimeMessageRef.current(message);
    });
  }, [subscribeMessage]);

  useEffect(() => {
    if (subscribeMessage) return;
    processRealtimeMessage(latestMessage);
  }, [latestMessage, processRealtimeMessage, subscribeMessage]);
}
