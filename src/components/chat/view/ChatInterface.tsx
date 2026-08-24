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
import { shouldRefreshSessionHistoryForRealtimeMessage } from '../hooks/chatRealtimeRefresh';
import { useSessionStore } from '../../../stores/useSessionStore';
import { createSessionStreamAccumulator } from '../hooks/sessionStreamAccumulator';
import { buildSubagentTraces } from '../subagent/buildSubagentTraces';
import { SubagentPanel } from '../subagent/SubagentPanel';
import {
  applySubagentPermissionWaitingState,
  partitionSubagentPermissionRequests,
  shouldAutoSelectSubagentQuestion,
} from '../subagent/subagentPermissionRouting';
import { useSubagentPanelLayout } from '../subagent/useSubagentPanelLayout';

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
  const lastAutoOpenedQuestionRef = useRef<string | null>(null);
  const [showScheduledTasks, setShowScheduledTasks] = useState(false);
  const [isQuickSettingsOpen, setIsQuickSettingsOpen] = useState(false);
  const [selectedSubagentTraceId, setSelectedSubagentTraceId] = useState<string | null>(null);

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
  const selectedSubagentTrace = subagentPermissionRouting.selectedTrace;
  const selectedSubagentQuestionRequests = subagentPermissionRouting.selectedRequests;
  const hiddenSubagentQuestions = subagentPermissionRouting.hidden;
  const unresolvedSubagentQuestions = subagentPermissionRouting.unresolved;
  const mainPermissionRequests = subagentPermissionRouting.main;
  const subagentDisplayTraces = useMemo(
    () => applySubagentPermissionWaitingState(subagentTraces, routedSubagentQuestions),
    [routedSubagentQuestions, subagentTraces],
  );
  const isSubagentPanelOpen = selectedSubagentTraceId !== null;
  const {
    containerRef: subagentLayoutRef,
    panelWidth: subagentPanelWidth,
    panelMinWidth: subagentPanelMinWidth,
    panelMaxWidth: subagentPanelMaxWidth,
    isDocked: isSubagentPanelDocked,
    isResizing: isSubagentPanelResizing,
    handleResizeStart: handleSubagentPanelResizeStart,
    handleResizeKeyDown: handleSubagentPanelResizeKeyDown,
  } = useSubagentPanelLayout(isSubagentPanelOpen);

  const closeSubagentPanel = useCallback(() => {
    setSelectedSubagentTraceId(null);
    const returnFocusTarget = subagentReturnFocusRef.current;
    subagentReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocusTarget?.focus());
  }, []);

  const handleOpenSubagent = useCallback((toolId: string) => {
    const trace = subagentTraces.find((candidate) => (
      candidate.id === toolId || candidate.sourceToolIds.includes(toolId)
    ));
    if (trace) {
      subagentReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setIsQuickSettingsOpen(false);
      setSelectedSubagentTraceId(trace.id);
    }
  }, [subagentTraces]);

  const handleOpenLatestSubagent = useCallback(() => {
    const runningTrace = [...subagentDisplayTraces]
      .reverse()
      .find((trace) => trace.status === 'running' || trace.status === 'waiting');
    const trace = runningTrace || subagentDisplayTraces[subagentDisplayTraces.length - 1];
    if (trace) {
      subagentReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      setIsQuickSettingsOpen(false);
      setSelectedSubagentTraceId(trace.id);
    }
  }, [subagentDisplayTraces]);

  const latestHiddenSubagentQuestion = hiddenSubagentQuestions[hiddenSubagentQuestions.length - 1];
  const hiddenSubagentQuestionCount = hiddenSubagentQuestions.length + unresolvedSubagentQuestions.length;

  useEffect(() => {
    setSelectedSubagentTraceId(null);
    setIsQuickSettingsOpen(false);
    subagentReturnFocusRef.current = null;
    lastAutoOpenedQuestionRef.current = null;
  }, [selectedSession?.id]);

  useEffect(() => {
    const latestQuestion = routedSubagentQuestions[routedSubagentQuestions.length - 1];
    if (!latestQuestion || lastAutoOpenedQuestionRef.current === latestQuestion.request.requestId) {
      return;
    }

    if (!shouldAutoSelectSubagentQuestion(
      isSubagentPanelOpen,
      selectedSubagentTrace?.id ?? null,
      selectedSubagentQuestionRequests.length,
      latestQuestion.trace.id,
    )) {
      // Keep the current form mounted so partially entered answers and focus
      // survive when another subagent asks a question concurrently.
      return;
    }

    lastAutoOpenedQuestionRef.current = latestQuestion.request.requestId;
    if (!isSubagentPanelOpen) {
      subagentReturnFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setIsQuickSettingsOpen(false);
    setSelectedSubagentTraceId(latestQuestion.trace.id);
  }, [
    isSubagentPanelOpen,
    routedSubagentQuestions,
    selectedSubagentQuestionRequests.length,
    selectedSubagentTrace?.id,
  ]);

  const handleQuickSettingsOpenChange = useCallback((nextOpen: boolean) => {
    setIsQuickSettingsOpen(nextOpen);
    if (nextOpen && isSubagentPanelOpen && !isSubagentPanelDocked) {
      subagentReturnFocusRef.current = null;
      setSelectedSubagentTraceId(null);
    }
  }, [isSubagentPanelDocked, isSubagentPanelOpen]);

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
    const canCloseSubagentDrawer = isSubagentPanelOpen && !isSubagentPanelDocked;
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
          {subagentDisplayTraces.length > 0 && (
            <button
              type="button"
              onClick={handleOpenLatestSubagent}
              aria-controls="subagent-activity-panel"
              aria-expanded={isSubagentPanelOpen}
              aria-hidden={isSubagentPanelOpen}
              tabIndex={isSubagentPanelOpen ? -1 : undefined}
              className={`absolute right-3 top-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/90 px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground ${isSubagentPanelOpen ? 'pointer-events-none invisible' : 'visible'}`}
              title={t('subagent.openPanel', { defaultValue: 'Open agent activity' })}
            >
              <Bot className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t('subagent.agents', { defaultValue: 'Agents' })}</span>
              <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-foreground">
                {subagentDisplayTraces.length}
              </span>
              {subagentDisplayTraces.some((trace) => trace.status === 'running' || trace.status === 'waiting') && (
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500" aria-hidden="true" />
              )}
            </button>
          )}

          <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
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
          visibleMessages={visibleMessages}
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
                {latestHiddenSubagentQuestion && (
                  <button
                    type="button"
                    onClick={() => handleOpenSubagent(latestHiddenSubagentQuestion.trace.id)}
                    aria-controls="subagent-activity-panel"
                    className="shrink-0 rounded px-1 font-medium text-purple-600 hover:bg-purple-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-purple-300"
                  >
                    {t('subagentPanel.openQuestion', { defaultValue: 'Open' })}
                  </button>
                )}
              </div>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={mainPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          loadingStartedAt={loadingStartedAt}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          thinkingMode={thinkingMode}
          setThinkingMode={setThinkingMode}
          tokenBudget={tokenBudget}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          onOpenCapabilities={onOpenCapabilities}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={
            isLoading && provider === 'claude'
              ? t('input.supplementPlaceholder', {
                  defaultValue: 'Queue a follow-up after the current response...',
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

        {isSubagentPanelOpen && isSubagentPanelDocked && (
          <div className="flex h-full min-w-0 flex-shrink-0">
            <div
              role="separator"
              tabIndex={0}
              aria-label={t('subagent.resizePanel', { defaultValue: 'Resize agent activity panel' })}
              aria-orientation="vertical"
              aria-controls="subagent-activity-panel"
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
              <SubagentPanel
                traces={subagentDisplayTraces}
                selectedTraceId={selectedSubagentTraceId}
                onSelectTrace={setSelectedSubagentTraceId}
                onClose={closeSubagentPanel}
                mode="docked"
                permissionRequests={selectedSubagentQuestionRequests}
                onPermissionDecision={handlePermissionDecision}
              />
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
