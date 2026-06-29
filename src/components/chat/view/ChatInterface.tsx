import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
import { useSessionStore } from '../../../stores/useSessionStore';
import { createSessionStreamAccumulator } from '../hooks/sessionStreamAccumulator';

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
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
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
  const [showScheduledTasks, setShowScheduledTasks] = useState(false);

  const resetStreamingState = useCallback(() => {
    for (const timerId of streamTimersRef.current.values()) {
      clearTimeout(timerId);
    }
    streamTimersRef.current.clear();
    streamAccumulatorRef.current.clearAll();
  }, []);

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
  });

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
      if (!message || message.type !== 'session-status' || message.isProcessing !== false) {
        return;
      }
      if (!selectedProject) {
        return;
      }

      const statusSessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
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
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

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
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
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
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
        />

        <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
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
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'gemini'
                    ? t('messageTypes.gemini')
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
          onOpenScheduledTasks={canCreateScheduledTask ? () => setShowScheduledTasks(true) : undefined}
          scheduledTasksDisabledReason={scheduledTasksDisabledReason}
        />
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

      <QuickSettingsPanel />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
