import React, { Suspense, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import ChatInterface from '../../chat/view/ChatInterface';
import CodeHubPanel from '../../codehub/CodeHubPanel';
import FileTree from '../../file-tree/view/FileTree';
import SkillsWorkspacePanel from '../../skills-market/SkillsWorkspacePanel';
import McpToolsPanel from '../../tools-market/McpToolsPanel';
import SqlCheckPanel from '../../sql-check/SqlCheckPanel';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import { useMainFileTabs } from '../../code-editor/hooks/useMainFileTabs';
import MainTabbedEditorSidebar from '../../code-editor/view/MainTabbedEditorSidebar';
import type { AppTab, Project } from '../../../types/app';
import { getWorkspaceDisabledTabs, resolveAllowedWorkspaceTab } from '../utils/mainContentAccess';
import { useAgentGraphFeatureEnabled } from '../../../features/agent-graph/agentGraphFeature';

import MainContentHeader from './subcomponents/MainContentHeader';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';

const AgentGraphStudio = React.lazy(() => import('../../../features/agent-graph/AgentGraphStudio'));

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { t } = useTranslation('codeEditor');
  const { t: tCommon } = useTranslation('common');
  const agentGraphEnabled = useAgentGraphFeatureEnabled();
  const { preferences } = useUiPreferences();
  const { hideToolMessages, autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;

  const disabledTabs = useMemo(
    () => getWorkspaceDisabledTabs(selectedProject?.accessRole),
    [selectedProject?.accessRole],
  );
  const isViewOnlyWorkspace = selectedProject?.accessRole === 'view';

  const {
    editorWidth,
    editorExpanded,
    isResizing,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
    trackEditingFile: false,
  });

  const fileTabs = useMainFileTabs();
  const chatTabs = useMainFileTabs();
  const codehubTabs = useMainFileTabs();
  const flushFileTabs = fileTabs.flushAndClear;
  const flushChatTabs = chatTabs.flushAndClear;
  const flushCodehubTabs = codehubTabs.flushAndClear;
  const adoptChatScope = chatTabs.adoptScope;
  const openFileTab = fileTabs.openFile;
  const openChatTab = chatTabs.openFile;
  const openCodehubTab = codehubTabs.openFile;
  const beforeFileTabMutation = fileTabs.beforeFileMutation;
  const beforeChatTabMutation = chatTabs.beforeFileMutation;
  const beforeCodehubTabMutation = codehubTabs.beforeFileMutation;
  const beforeFileMutation = React.useCallback(async (paths: string[]) => {
    const results = await Promise.all([
      beforeFileTabMutation(paths),
      beforeChatTabMutation(paths),
      beforeCodehubTabMutation(paths),
    ]);
    return results.every(Boolean);
  }, [beforeChatTabMutation, beforeCodehubTabMutation, beforeFileTabMutation]);
  const projectScope = `${selectedProject?.tenantId ?? 'tenant'}:${selectedProject?.workspaceId ?? selectedProject?.fullPath ?? 'none'}:${selectedProject?.accessRole ?? 'owner'}`;
  const filesScope = `${projectScope}:files`;
  const chatScope = `${projectScope}:chat:${selectedSession?.__provider ?? 'claude'}:${selectedSession?.id ?? 'draft'}`;
  const codehubScope = `${projectScope}:codehub`;
  const pendingChatReplacementRef = React.useRef<string | null>(null);
  const handleReplaceTemporarySession = React.useCallback((sessionId?: string | null) => {
    pendingChatReplacementRef.current = sessionId ?? null;
    onReplaceTemporarySession(sessionId);
  }, [onReplaceTemporarySession]);
  const hiddenSaveFailure = ([
    { name: tCommon('tabs.files'), manager: fileTabs, key: 'files', scope: filesScope },
    { name: tCommon('tabs.chat'), manager: chatTabs, key: 'chat', scope: chatScope },
    { name: tCommon('tabs.codehub'), manager: codehubTabs, key: 'codehub', scope: codehubScope },
  ] as const).find(({ manager, key, scope }) => manager.saveError && (key !== activeTab || manager.ownerScope !== scope));
  const previousContextRef = React.useRef({ activeTab, projectScope, chatScope, provider: selectedSession?.__provider ?? 'claude' });

  useEffect(() => {
    const previous = previousContextRef.current;
    previousContextRef.current = { activeTab, projectScope, chatScope, provider: selectedSession?.__provider ?? 'claude' };
    if (previous.projectScope !== projectScope) {
      pendingChatReplacementRef.current = null;
      void flushFileTabs();
      void flushChatTabs();
      void flushCodehubTabs();
      handleCloseEditor();
      return;
    }
    if (previous.activeTab !== activeTab) {
      const flushPrevious = previous.activeTab === 'files' ? flushFileTabs
        : previous.activeTab === 'chat' ? flushChatTabs
          : previous.activeTab === 'codehub' ? flushCodehubTabs : null;
      if (flushPrevious) void flushPrevious();
      handleCloseEditor();
    }
    if (previous.chatScope !== chatScope) {
      const isCreatedSession = Boolean(
        selectedSession?.id &&
        pendingChatReplacementRef.current === selectedSession.id &&
        previous.provider === (selectedSession.__provider ?? 'claude') &&
        previous.activeTab === 'chat' && activeTab === 'chat',
      );
      pendingChatReplacementRef.current = null;
      if (isCreatedSession) {
        adoptChatScope(previous.chatScope, chatScope);
      } else {
        void flushChatTabs();
      }
    }
  }, [activeTab, adoptChatScope, chatScope, flushChatTabs, flushCodehubTabs, flushFileTabs, handleCloseEditor, projectScope, selectedSession?.__provider, selectedSession?.id]);

  const handleChatFileOpen = React.useCallback(
    (filePath: string, diffInfo?: { old_string?: string; new_string?: string }) => {
      if (!selectedProject) return;
      const file = handleFileOpen(filePath, diffInfo ?? null, 'chat');
      void openChatTab(file, selectedProject, chatScope);
    },
    [chatScope, handleFileOpen, openChatTab, selectedProject],
  );

  const handleFileManagerFileOpen = React.useCallback(
    (filePath: string, diffInfo?: { old_string?: string; new_string?: string }) => {
      if (!selectedProject) return;
      const file = handleFileOpen(filePath, diffInfo ?? null, 'files');
      void openFileTab(file, selectedProject, filesScope);
    },
    [filesScope, handleFileOpen, openFileTab, selectedProject],
  );

  const handleCodeHubFileOpen = React.useCallback(
    (filePath: string) => {
      if (!selectedProject) return;
      const file = handleFileOpen(filePath, null, 'files');
      void openCodehubTab(file, selectedProject, codehubScope);
    },
    [codehubScope, handleFileOpen, openCodehubTab, selectedProject],
  );

  const handleActiveTabChange = React.useCallback(
    (nextTabAction: React.SetStateAction<AppTab>) => {
      const nextTab = typeof nextTabAction === 'function'
        ? nextTabAction(activeTab)
        : nextTabAction;

      setActiveTab(nextTab);
    },
    [activeTab, setActiveTab],
  );

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    const allowedTab = resolveAllowedWorkspaceTab(activeTab, disabledTabs, agentGraphEnabled);
    if (allowedTab !== activeTab) {
      handleActiveTabChange(allowedTab);
    }
  }, [activeTab, agentGraphEnabled, disabledTabs, handleActiveTabChange]);

  useEffect(() => {
    const activeTabCount = activeTab === 'files' ? fileTabs.tabs.length
      : activeTab === 'chat' ? chatTabs.tabs.length
        : activeTab === 'codehub' ? codehubTabs.tabs.length : 0;
    if (editorExpanded && activeTabCount === 0) handleCloseEditor();
  }, [activeTab, chatTabs.tabs.length, codehubTabs.tabs.length, editorExpanded, fileTabs.tabs.length, handleCloseEditor]);

  const showStateView = isLoading || !selectedProject;

  return (
    <div className="flex h-full flex-col">
      {!showStateView && selectedProject && <MainContentHeader
        activeTab={activeTab}
        setActiveTab={handleActiveTabChange}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        disabledTabs={disabledTabs}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        agentGraphEnabled={agentGraphEnabled}
      />}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {showStateView && <MainContentStateView mode={isLoading ? 'loading' : 'empty'} isMobile={isMobile} onMenuClick={onMenuClick} />}
        {hiddenSaveFailure && (
          <div role="alert" className="absolute right-3 top-3 z-30 flex max-w-sm items-center gap-2 rounded-md border border-red-300 bg-background p-2 text-xs text-red-700 shadow-lg dark:border-red-900 dark:text-red-300">
            <span>{t('tabs.hiddenSaveFailed', { scope: hiddenSaveFailure.name })}</span>
            <button type="button" className="shrink-0 underline" onClick={() => void hiddenSaveFailure.manager.flushAndClear()}>{t('tabs.retrySave')}</button>
          </div>
        )}
        {!showStateView && selectedProject && <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded && ((activeTab === 'files' && fileTabs.tabs.length) || (activeTab === 'chat' && chatTabs.tabs.length) || (activeTab === 'codehub' && codehubTabs.tabs.length)) ? 'hidden' : ''} flex-1`}>
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                latestMessage={latestMessage}
                onFileOpen={handleChatFileOpen}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                onReplaceTemporarySession={handleReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                hideToolMessages={hideToolMessages}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                onShowAllTasks={null}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree
                selectedProject={selectedProject}
                onFileOpen={handleFileManagerFileOpen}
                openImagesInEditor
                activePath={fileTabs.activeTab?.displayPath}
                beforeFileMutation={beforeFileMutation}
                isReadOnly={isViewOnlyWorkspace}
              />
            </div>
          )}

          {activeTab === 'codehub' && (
            <div className="h-full overflow-hidden">
              <CodeHubPanel
                selectedProject={selectedProject}
                isReadOnly={isViewOnlyWorkspace}
                onFileOpen={handleCodeHubFileOpen}
              />
            </div>
          )}

          {activeTab === 'mcp-tools' && (
            <div className="h-full overflow-hidden">
              <McpToolsPanel selectedProject={selectedProject} isReadOnly={isViewOnlyWorkspace} />
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="h-full overflow-hidden">
              <SkillsWorkspacePanel selectedProject={selectedProject} isReadOnly={isViewOnlyWorkspace} />
            </div>
          )}

          {activeTab === 'sql-check' && (
            <div className="h-full overflow-hidden">
              <SqlCheckPanel selectedProject={selectedProject} />
            </div>
          )}

          {agentGraphEnabled && activeTab === 'agent-graph' && (
            <div className="h-full overflow-hidden">
              <ErrorBoundary showDetails>
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading Agent Graph Studio...</div>}>
                  <AgentGraphStudio selectedProject={selectedProject} readOnly={isViewOnlyWorkspace} />
                </Suspense>
              </ErrorBoundary>
            </div>
          )}
        </div>}

        {([
          { key: 'files', manager: fileTabs, scope: filesScope, openFile: handleFileManagerFileOpen },
          { key: 'chat', manager: chatTabs, scope: chatScope, openFile: handleChatFileOpen },
          { key: 'codehub', manager: codehubTabs, scope: codehubScope, openFile: handleCodeHubFileOpen },
        ] as const).map(({ key, manager, scope, openFile }) => (
          <MainTabbedEditorSidebar
            key={key}
            manager={manager}
            isVisible={!showStateView && activeTab === key && manager.ownerScope === scope && !manager.isClearing}
            isMobile={isMobile}
            editorExpanded={editorExpanded}
            editorWidth={editorWidth}
            isResizing={isResizing}
            hasManualWidth={hasManualWidth}
            resizeHandleRef={resizeHandleRef}
            onResizeStart={handleResizeStart}
            onToggleEditorExpand={handleToggleEditorExpand}
            fillSpace={key === 'files'}
            onOpenFile={openFile}
          />
        ))}
      </div>

    </div>
  );
}

export default React.memo(MainContent);
