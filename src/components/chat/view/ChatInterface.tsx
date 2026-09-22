import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import type { LLMProvider } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useChatSessionFork } from '../hooks/useChatSessionFork';
import { useSkillCreation } from '../hooks/useSkillCreation';
import { shouldRefreshSessionHistoryForRealtimeMessage } from '../hooks/chatRealtimeRefresh';
import { useSessionStore } from '../../../stores/useSessionStore';
import { createSessionStreamAccumulator } from '../hooks/sessionStreamAccumulator';
import { buildSubagentTraces } from '../subagent/buildSubagentTraces';
import { SubagentPanel } from '../subagent/SubagentPanel';
import {
  applySubagentPermissionWaitingState,
  partitionSubagentPermissionRequests,
} from '../subagent/subagentPermissionRouting';
import { useSubagentPanelLayout } from '../subagent/useSubagentPanelLayout';
import { buildExecutionTasks } from '../execution/buildExecutionTasks';
import { ExecutionTaskPanel } from '../execution/ExecutionTaskPanel';
import { findExecutionTaskParentTrace } from '../execution/navigation';
import { isWorkspaceExecutionOutput } from '../execution/display';
import type { ExecutionTask } from '../execution/types';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import ScheduledTasksDialog from './subcomponents/ScheduledTasksDialog';


type PendingViewSession = {
  sessionId: string | null;
  startedAt: number;
};

const STREAM_HEALTH_CHECK_INTERVAL_MS = 10_000;
const STREAM_INACTIVITY_CHECK_MS = 30_000;
const STREAM_STATUS_PROBE_MIN_INTERVAL_MS = 20_000;

const isConcreteSessionId = (sessionId: string | null | undefined): sessionId is string =>
  typeof sessionId === 'string' && sessionId.length > 0 && !sessionId.startsWith('new-session-');

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  hideToolMessages,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  initialUserMessage,
  onOpenCapabilities,
  onShowAllTasks,
  workspaceTerminology = 'workspace',
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');
  const { subscribeMessage } = useWebSocket();

  const sessionStore = useSessionStore();
  const streamAccumulatorRef = useRef(createSessionStreamAccumulator());
  const streamTimersRef = useRef(new Map<string, number>());
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);
  const lastRealtimeActivityAtRef = useRef(Date.now());
  const lastSessionStatusProbeAtRef = useRef(0);
  const subagentReturnFocusRef = useRef<HTMLElement | null>(null);
  const [showScheduledTasks, setShowScheduledTasks] = useState(false);
  const [isQuickSettingsOpen, setIsQuickSettingsOpen] = useState(false);
  const [selectedSubagentTraceId, setSelectedSubagentTraceId] = useState<string | null>(null);
  const [selectedExecutionTaskId, setSelectedExecutionTaskId] = useState<string | null>(null);
  const [executionNavigationMessage, setExecutionNavigationMessage] = useState('');
  const [locatedExecutionSource, setLocatedExecutionSource] = useState<{ messageId?: string; toolUseId?: string } | null>(null);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  } = useChatProviderState({
    selectedSession,
  });

  const resetStreamingState = useCallback(() => {
    // A route/session transition can happen before the 100 ms streaming timer
    // publishes the opening chunks. Persist every buffered snapshot first so
    // the next view observes the same realtime content.
    for (const snapshot of streamAccumulatorRef.current.drainSnapshots()) {
      if (!snapshot.content) continue;
      sessionStore.updateStreaming(snapshot.sessionId, snapshot.content, provider, {
        id: snapshot.id,
        timestamp: snapshot.timestamp,
        parentToolUseId: snapshot.parentToolUseId,
        assistantMessageId: snapshot.assistantMessageId,
      });
    }
    for (const timerId of streamTimersRef.current.values()) {
      clearTimeout(timerId);
    }
    streamTimersRef.current.clear();
  }, [provider, sessionStore]);

  const {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessages,
    allMessagesLoaded,
    loadingStartedAt,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    revealAllLoadedMessages,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
    initialUserMessage,
  });

  const { forkMessage, forkingMessageUuid, forkError, forkDisabled } = useChatSessionFork({
    selectedProject,
    sessionId: selectedSession?.id || currentSessionId,
    provider,
    isProcessing: isLoading || Boolean(processingSessions?.has(selectedSession?.id || currentSessionId || '')),
    onNavigateToSession,
  });

  const subagentTraces = useMemo(
    () => buildSubagentTraces(chatMessages),
    [chatMessages],
  );
  const subagentPermissionRouting = useMemo(
    () => partitionSubagentPermissionRequests(
      subagentTraces,
      pendingPermissionRequests,
      selectedSubagentTraceId,
    ),
    [pendingPermissionRequests, selectedSubagentTraceId, subagentTraces],
  );
  const routedSubagentQuestions = subagentPermissionRouting.routed;
  const selectedSubagentQuestionRequests = subagentPermissionRouting.selectedRequests;
  const hiddenSubagentQuestions = subagentPermissionRouting.hidden;
  const unresolvedSubagentQuestions = subagentPermissionRouting.unresolved;
  const mainPermissionRequests = subagentPermissionRouting.main;
  const subagentDisplayTraces = useMemo(
    () => applySubagentPermissionWaitingState(subagentTraces, routedSubagentQuestions),
    [routedSubagentQuestions, subagentTraces],
  );
  const executionTasks = useMemo(
    () => buildExecutionTasks(chatMessages, subagentDisplayTraces),
    [chatMessages, subagentDisplayTraces],
  );
  const selectedExecutionTask = executionTasks.find((task) => task.id === selectedExecutionTaskId) || null;
  const executionOutputUnavailableReason = selectedExecutionTask?.outputFile
    && !isWorkspaceExecutionOutput(selectedExecutionTask.outputFile, selectedProject?.fullPath)
    ? t('execution.outputOutsideWorkspace', { defaultValue: 'This file belongs to the execution runtime and cannot be previewed here. Reported output is available in Result.' })
    : undefined;
  const isSubagentPanelOpen = selectedSubagentTraceId !== null;
  const isDetailsPanelOpen = isSubagentPanelOpen || selectedExecutionTask !== null;
  const {
    containerRef: subagentLayoutRef,
    panelWidth: subagentPanelWidth,
    panelMinWidth: subagentPanelMinWidth,
    panelMaxWidth: subagentPanelMaxWidth,
    isDocked: isSubagentPanelDocked,
    isResizing: isSubagentPanelResizing,
    handleResizeStart: handleSubagentPanelResizeStart,
    handleResizeKeyDown: handleSubagentPanelResizeKeyDown,
  } = useSubagentPanelLayout(isDetailsPanelOpen);

  const closeSubagentPanel = useCallback(() => {
    setSelectedSubagentTraceId(null);
    setSelectedExecutionTaskId(null);
    const returnFocusTarget = subagentReturnFocusRef.current;
    subagentReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
      else subagentLayoutRef.current?.querySelector<HTMLButtonElement>('[data-execution-task-id]')?.focus();
    });
  }, [subagentLayoutRef]);

  // Keep opening explicit: only the matching Task/Agent tool card receives this callback.
  const handleOpenSubagent = useCallback((toolId: string) => {
    const trace = subagentTraces.find((candidate) => (
      candidate.id === toolId || candidate.sourceToolIds.includes(toolId)
    ));
    if (trace) {
      if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[data-execution-task-panel], #subagent-activity-panel')) {
        subagentReturnFocusRef.current = document.activeElement;
      }
      setIsQuickSettingsOpen(false);
      setSelectedExecutionTaskId(null);
      setSelectedSubagentTraceId(trace.id);
    }
  }, [subagentTraces]);

  const handleOpenExecutionTask = useCallback((taskId: string) => {
    const task = executionTasks.find((candidate) => candidate.id === taskId);
    if (!task || task.kind !== 'background') return;
    setExecutionNavigationMessage('');
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest('[data-execution-task-panel], #subagent-activity-panel')) {
      subagentReturnFocusRef.current = document.activeElement;
    }
    setIsQuickSettingsOpen(false);
    setSelectedSubagentTraceId(null);
    setSelectedExecutionTaskId(task.id);
  }, [executionTasks]);

  const latestHiddenSubagentQuestion = hiddenSubagentQuestions[hiddenSubagentQuestions.length - 1];
  const hiddenSubagentQuestionCount = hiddenSubagentQuestions.length + unresolvedSubagentQuestions.length;

  useEffect(() => {
    setSelectedSubagentTraceId(null);
    setSelectedExecutionTaskId(null);
    setExecutionNavigationMessage('');
    setLocatedExecutionSource(null);
    setIsQuickSettingsOpen(false);
    subagentReturnFocusRef.current = null;
  }, [selectedSession?.id]);

  const handleQuickSettingsOpenChange = useCallback((nextOpen: boolean) => {
    setIsQuickSettingsOpen(nextOpen);
    if (nextOpen && isDetailsPanelOpen && !isSubagentPanelDocked) {
      subagentReturnFocusRef.current = null;
      setSelectedSubagentTraceId(null);
      setSelectedExecutionTaskId(null);
    }
  }, [isSubagentPanelDocked, isDetailsPanelOpen]);

  useEffect(() => {
    if (
      selectedSubagentTraceId &&
      !subagentTraces.some((trace) => (
        trace.id === selectedSubagentTraceId ||
        trace.sourceToolIds.includes(selectedSubagentTraceId)
      ))
    ) {
      setSelectedSubagentTraceId(null);
    }
  }, [selectedSubagentTraceId, subagentTraces]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    thinkingMode,
    setThinkingMode,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    isDragActive,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    geminiModel,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    clearMessages,
    rewindMessages,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
  });

  const creation = useSkillCreation({ project: selectedProject, sessionId: selectedSession?.id || currentSessionId, provider, input, setInput, onConversationReady: (id) => { setCurrentSessionId(id); onNavigateToSession?.(id); } });
  const combinedMessages = useMemo(() => [...chatMessages, ...creation.messages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()), [chatMessages, creation.messages]);
  const combinedVisible = useMemo(() => [...visibleMessages, ...creation.messages].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()), [visibleMessages, creation.messages]);

  useEffect(() => {
    if (!isUserScrolledUp && creation.messages.length) {
      const timer = setTimeout(scrollToBottom, 50);
      return () => clearTimeout(timer);
    }
  }, [creation.messages, isUserScrolledUp, scrollToBottom]);

  const handleLocateExecutionTask = useCallback((task: ExecutionTask) => {
    setLocatedExecutionSource({ messageId: task.sourceMessageId, toolUseId: task.toolUseId });
    const parent = findExecutionTaskParentTrace(task, subagentTraces);
    if (parent) handleOpenSubagent(parent.id);
    else if (!isSubagentPanelDocked) closeSubagentPanel();
    revealAllLoadedMessages();
    setIsUserScrolledUp(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const candidates = [...(subagentLayoutRef.current?.querySelectorAll<HTMLElement>('[data-chat-message-id]') || [])];
      const target = candidates.find((element) => element.dataset.chatMessageId === task.sourceMessageId)
        || candidates.find((element) => Boolean(task.toolUseId) && element.dataset.chatToolId === task.toolUseId);
      if (!target) {
        setExecutionNavigationMessage(t('execution.sourceUnavailable', { defaultValue: 'The source message is not in the loaded history.' }));
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.querySelector<HTMLElement>('button, summary, a')?.focus({ preventScroll: true });
      setExecutionNavigationMessage('');
    }));
  }, [closeSubagentPanel, handleOpenSubagent, isSubagentPanelDocked, revealAllLoadedMessages, setIsUserScrolledUp, subagentLayoutRef, subagentTraces, t]);

  const handleExecutionOpenParent = useCallback((task: ExecutionTask) => {
    const parent = findExecutionTaskParentTrace(task, subagentTraces);
    if (parent) handleOpenSubagent(parent.id);
    else handleLocateExecutionTask(task);
  }, [handleLocateExecutionTask, handleOpenSubagent, subagentTraces]);

  const getCurrentConcreteSessionId = useCallback(() => {
    const providerVal = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const reconnectProvider = (selectedSession?.__provider || providerVal) as LLMProvider;
    const pendingSessionId =
      typeof window !== 'undefined' ? sessionStorage.getItem('pendingSessionId') : null;
    const candidateSessionId =
      selectedSession?.id ||
      currentSessionId ||
      pendingViewSessionRef.current?.sessionId ||
      pendingSessionId ||
      null;

    return {
      provider: reconnectProvider,
      sessionId: isConcreteSessionId(candidateSessionId) ? candidateSessionId : null,
    };
  }, [currentSessionId, selectedSession]);

  const probeCurrentSessionStatus = useCallback(() => {
    const { provider: probeProvider, sessionId } = getCurrentConcreteSessionId();

    if (!sessionId) {
      return false;
    }

    lastSessionStatusProbeAtRef.current = Date.now();
    sendMessage({
      type: 'check-session-status',
      sessionId,
      provider: probeProvider,
    });

    return true;
  }, [getCurrentConcreteSessionId, sendMessage]);

  // On WebSocket reconnect, re-fetch the current session's messages from the server
  // so missed streaming events are shown. Also ask the server whether the session
  // is still active; for Claude this reattaches SDK output to the new socket.
  const handleWebSocketReconnect = useCallback(async () => {
    const { provider: reconnectProvider, sessionId } = getCurrentConcreteSessionId();

    if (sessionId) {
      probeCurrentSessionStatus();
    }

    if (selectedProject && selectedSession) {
      await sessionStore.refreshFromServer(selectedSession.id, {
        provider: reconnectProvider,
        projectName: selectedProject.name,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        workspaceId: selectedProject.workspaceId,
      });
    }

    if (!sessionId) {
      setIsLoading(false);
      setCanAbortSession(false);
    }
  }, [getCurrentConcreteSessionId, probeCurrentSessionStatus, selectedProject, selectedSession, sessionStore, setIsLoading, setCanAbortSession]);

  useChatRealtimeHandlers({
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
    onSessionAdopted: creation.adoptSession,
    onNavigateToSession,
    onWebSocketReconnect: handleWebSocketReconnect,
    addMessage,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading) {
      lastSessionStatusProbeAtRef.current = 0;
      return;
    }

    lastRealtimeActivityAtRef.current = Date.now();
  }, [isLoading]);

  useEffect(() => {
    return subscribeMessage((message) => {
      if (!message) return;
      if (message.type === 'websocket-reconnected') return;

      lastRealtimeActivityAtRef.current = Date.now();
    });
  }, [subscribeMessage]);

  useEffect(() => {
    return subscribeMessage((message) => {
      if (!message || !shouldRefreshSessionHistoryForRealtimeMessage(message)) {
        return;
      }
      if (!selectedProject) {
        return;
      }

      const statusSessionId = typeof message.sessionId === 'string'
        ? message.sessionId
        : typeof message.actualSessionId === 'string'
          ? message.actualSessionId
          : null;
      if (!statusSessionId) {
        return;
      }

      const { provider: statusProvider, sessionId: currentConcreteSessionId } = getCurrentConcreteSessionId();
      if (currentConcreteSessionId && statusSessionId !== currentConcreteSessionId) {
        return;
      }

      void sessionStore.refreshFromServer(statusSessionId, {
        provider: (message.provider || statusProvider) as LLMProvider,
        projectName: selectedProject.name,
        projectPath: selectedProject.fullPath || selectedProject.path || '',
        workspaceId: selectedProject.workspaceId,
      });
    });
  }, [getCurrentConcreteSessionId, selectedProject, sessionStore, subscribeMessage]);

  useEffect(() => {
    if (!isLoading) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const inactiveForMs = now - lastRealtimeActivityAtRef.current;
      const lastProbeAgeMs = now - lastSessionStatusProbeAtRef.current;

      if (
        inactiveForMs < STREAM_INACTIVITY_CHECK_MS ||
        lastProbeAgeMs < STREAM_STATUS_PROBE_MIN_INTERVAL_MS
      ) {
        return;
      }

      probeCurrentSessionStatus();
    }, STREAM_HEALTH_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isLoading, probeCurrentSessionStatus]);

  useEffect(() => {
    const canCloseSubagentDrawer = selectedExecutionTask !== null
      || (isSubagentPanelOpen && !isSubagentPanelDocked);
    if (
      !isQuickSettingsOpen &&
      !canCloseSubagentDrawer &&
      (!isLoading || !canAbortSession)
    ) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.repeat ||
        event.defaultPrevented ||
        event.isComposing
      ) {
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest('[data-subagent-question-panel]')
      ) {
        // AskUserQuestion owns Escape ("skip") while its form has focus.
        return;
      }

      if (isQuickSettingsOpen) {
        event.preventDefault();
        setIsQuickSettingsOpen(false);
        return;
      }

      if (canCloseSubagentDrawer) {
        event.preventDefault();
        closeSubagentPanel();
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [
    canAbortSession,
    closeSubagentPanel,
    handleAbortSession,
    isLoading,
    isQuickSettingsOpen,
    isSubagentPanelDocked,
    isSubagentPanelOpen,
    selectedExecutionTask,
  ]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);
  const handleProviderChange = useCallback(
    (nextProvider: LLMProvider) => setProvider(nextProvider as Provider),
    [setProvider],
  );

  const selectedModel = provider === 'cursor'
    ? cursorModel
    : provider === 'codex'
      ? codexModel
      : provider === 'gemini'
        ? geminiModel
        : claudeModel;
  const scheduledTaskSessionId =
    currentSessionId && !currentSessionId.startsWith('new-session-')
      ? currentSessionId
      : selectedSession?.id || null;
  const canCreateScheduledTask = !scheduledTaskSessionId;
  const scheduledTaskSessionName =
    selectedSession?.summary || selectedSession?.title || selectedSession?.name || scheduledTaskSessionId;
  const scheduledTasksDisabledReason = canCreateScheduledTask
    ? undefined
    : t('input.scheduledTasksNewSessionOnly', {
        defaultValue: 'Scheduled tasks can only be created from a new session',
      });

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'gemini'
            ? t('messageTypes.gemini')
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div
        ref={subagentLayoutRef}
        className="relative flex h-full min-h-0 overflow-hidden"
      >
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {selectedSession?.parentSessionId && onNavigateToSession && (
            <div className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => onNavigateToSession(selectedSession.parentSessionId!)}
              >
                {t('fork.viewParent', { defaultValue: 'View original chat' })}
              </button>
              <span className="ml-2">{t('fork.sameWorkspace', { defaultValue: 'This branch uses the same workspace.' })}</span>
            </div>
          )}
          {forkError && (
            <div role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {t('fork.failed', { defaultValue: 'Could not branch this chat. Please retry.' })} {forkError}
            </div>
          )}
          {executionNavigationMessage && <p role="status" className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground">{executionNavigationMessage}</p>}
          <ChatMessagesPane
            creationMode={creation.mode}
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={combinedMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={handleProviderChange}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessages={combinedVisible}
          allMessagesLoaded={allMessagesLoaded}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          autoExpandTools={autoExpandTools}
          hideToolMessages={hideToolMessages}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          onOpenSubagent={handleOpenSubagent}
          executionTasks={executionTasks}
          locatedExecutionSource={locatedExecutionSource}
          onOpenExecutionTask={handleOpenExecutionTask}
          onForkMessage={onNavigateToSession && selectedProject.accessRole !== 'view' ? forkMessage : undefined}
          forkingMessageUuid={forkingMessageUuid}
          forkDisabled={forkDisabled}
        />

          {(latestHiddenSubagentQuestion || unresolvedSubagentQuestions.length > 0) && (
            <div className="shrink-0 border-t border-border bg-background px-3 py-2">
              <div
                role="status"
                className="flex w-full items-center gap-2 rounded-lg border border-purple-500/25 bg-purple-500/5 px-3 py-2 text-left text-xs"
              >
                <Bot className="h-4 w-4 shrink-0 text-purple-500" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {latestHiddenSubagentQuestion
                    ? t('subagentPanel.questionWaiting', {
                        defaultValue: 'A subagent is waiting for your answer',
                      })
                    : t('subagentPanel.locatingQuestion', {
                        defaultValue: 'Connecting a subagent question…',
                      })}
                </span>
                {hiddenSubagentQuestionCount > 1 && (
                  <span className="rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-purple-600 dark:text-purple-300">
                    {hiddenSubagentQuestionCount}
                  </span>
                )}
              </div>
            </div>
          )}

          {creation.error && <div role="alert" className="px-4 py-2 text-sm text-red-600">{creation.error}</div>}
          <ChatComposer
          skillCreation={{ mode: creation.mode, busy: creation.busy, disabled: !selectedProject.workspaceId || selectedProject.accessRole === 'view', onToggle: creation.toggle }}
          pendingPermissionRequests={mainPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={creation.busy ? null : claudeStatus}
          isLoading={isLoading || creation.busy}
          loadingStartedAt={loadingStartedAt}
          onAbortSession={creation.busy ? () => void creation.cancel() : handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          onOpenCapabilities={onOpenCapabilities}
          hasInput={!creation.busy && Boolean((creation.mode ? creation.description : input).trim())}
          onClearInput={creation.mode ? () => creation.change('') : handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={creation.mode ? (event) => { event.preventDefault(); if (!isLoading) void creation.submit(); } : handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={!creation.mode && showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={!creation.mode && showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={creation.mode ? creation.description : input}
          onInputChange={creation.mode ? (event) => creation.change(event.target.value) : handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={creation.mode ? (event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.shiftKey && ((event.ctrlKey || event.metaKey) || !sendByCtrlEnter)) {
              event.preventDefault(); if (!isLoading) void creation.submit();
            }
          } : handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={
            creation.mode ? t('skillCreation.placeholder', { ns: 'common' }) : isLoading && provider === 'claude'
              ? t('input.supplementPlaceholder', {
                  defaultValue: 'Add supplemental information while Claude is working...',
                })
              : t('input.placeholder', {
                  provider:
                    provider === 'cursor'
                      ? t('messageTypes.cursor')
                      : provider === 'codex'
                        ? t('messageTypes.codex')
                        : provider === 'gemini'
                          ? t('messageTypes.gemini')
                          : t('messageTypes.claude'),
                })
          }
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          onOpenScheduledTasks={canCreateScheduledTask ? () => setShowScheduledTasks(true) : undefined}
          scheduledTasksDisabledReason={scheduledTasksDisabledReason}
        />
        </div>

        {isDetailsPanelOpen && isSubagentPanelDocked && (
          <div className="flex h-full min-w-0 flex-shrink-0">
            <div
              role="separator"
              tabIndex={0}
              aria-label={t('subagent.resizePanel', { defaultValue: 'Resize agent activity panel' })}
              aria-orientation="vertical"
              aria-controls={selectedExecutionTask ? 'execution-task-panel' : 'subagent-activity-panel'}
              aria-valuemin={subagentPanelMinWidth}
              aria-valuemax={subagentPanelMaxWidth}
              aria-valuenow={Math.round(subagentPanelWidth)}
              onPointerDown={handleSubagentPanelResizeStart}
              onKeyDown={handleSubagentPanelResizeKeyDown}
              className="group relative w-1 flex-shrink-0 cursor-col-resize bg-border/70 transition-colors hover:bg-purple-500 focus-visible:bg-purple-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/40"
            >
              <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-purple-500 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div
              className="h-full min-w-0 overflow-hidden border-l border-border bg-background"
              style={{ width: `${subagentPanelWidth}px` }}
            >
              {selectedExecutionTask ? <ExecutionTaskPanel
                task={selectedExecutionTask}
                mode="docked"
                onClose={closeSubagentPanel}
                onLocateTask={handleLocateExecutionTask}
                outputFileUnavailableReason={executionOutputUnavailableReason}
                onOpenParent={handleExecutionOpenParent}
                onFileOpen={onFileOpen}
              /> : <SubagentPanel
                traces={subagentDisplayTraces}
                selectedTraceId={selectedSubagentTraceId}
                onSelectTrace={setSelectedSubagentTraceId}
                onClose={closeSubagentPanel}
                mode="docked"
                permissionRequests={selectedSubagentQuestionRequests}
                onPermissionDecision={handlePermissionDecision}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={handleGrantToolPermission}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                selectedProject={selectedProject}
                provider={provider}
                executionTasks={executionTasks}
                onOpenExecutionTask={handleOpenExecutionTask}
              />}
            </div>
          </div>
        )}

        {isSubagentPanelOpen && !isSubagentPanelDocked && (
          <SubagentPanel
            traces={subagentDisplayTraces}
            selectedTraceId={selectedSubagentTraceId}
            onSelectTrace={setSelectedSubagentTraceId}
            onClose={closeSubagentPanel}
            mode="drawer"
            permissionRequests={selectedSubagentQuestionRequests}
            onPermissionDecision={handlePermissionDecision}
            createDiff={createDiff}
            onFileOpen={onFileOpen}
            onShowSettings={onShowSettings}
            onGrantToolPermission={handleGrantToolPermission}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            selectedProject={selectedProject}
            provider={provider}
            executionTasks={executionTasks}
            onOpenExecutionTask={handleOpenExecutionTask}
          />
        )}

        {selectedExecutionTask && !isSubagentPanelDocked && (
          <ExecutionTaskPanel
            task={selectedExecutionTask}
            mode="drawer"
            onClose={closeSubagentPanel}
            onLocateTask={handleLocateExecutionTask}
            outputFileUnavailableReason={executionOutputUnavailableReason}
            onOpenParent={handleExecutionOpenParent}
            onFileOpen={onFileOpen}
          />
        )}

        {isSubagentPanelResizing && (
          <div className="fixed inset-0 z-[10000] cursor-col-resize" aria-hidden="true" />
        )}
      </div>

      {selectedProject && showScheduledTasks ? (
        <ScheduledTasksDialog
          open={showScheduledTasks}
          selectedProject={selectedProject}
          provider={provider as LLMProvider}
          model={selectedModel}
          permissionMode={permissionMode}
          initialPrompt={input}
          selectedSessionId={null}
          selectedSessionName={scheduledTaskSessionName}
          mode="create"
          terminology={workspaceTerminology}
          onClose={() => setShowScheduledTasks(false)}
        />
      ) : null}

      <QuickSettingsPanel
        open={isQuickSettingsOpen}
        onOpenChange={handleQuickSettingsOpenChange}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
