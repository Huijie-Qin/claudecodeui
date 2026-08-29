import React, { Suspense, useEffect, useMemo } from 'react';

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
import EditorSidebar from '../../code-editor/view/EditorSidebar';
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
    editingFile,
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
  });

  const handleChatFileOpen = React.useCallback(
    (filePath: string, diffInfo?: { old_string?: string; new_string?: string }) =>
      handleFileOpen(filePath, diffInfo ?? null, 'chat'),
    [handleFileOpen],
  );

  const handleFileManagerFileOpen = React.useCallback(
    (filePath: string, diffInfo?: { old_string?: string; new_string?: string }) =>
      handleFileOpen(filePath, diffInfo ?? null, 'files'),
    [handleFileOpen],
  );

  const handleCodeHubFileOpen = React.useCallback(
    (filePath: string) => handleFileOpen(filePath, null, 'files'),
    [handleFileOpen],
  );

  const handleActiveTabChange = React.useCallback(
    (nextTabAction: React.SetStateAction<AppTab>) => {
      const nextTab = typeof nextTabAction === 'function'
        ? nextTabAction(activeTab)
        : nextTabAction;

      if (nextTab !== activeTab) {
        handleCloseEditor();
      }

      setActiveTab(nextTab);
    },
    [activeTab, handleCloseEditor, setActiveTab],
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

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return <MainContentStateView mode="empty" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={handleActiveTabChange}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        disabledTabs={disabledTabs}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        agentGraphEnabled={agentGraphEnabled}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className={`flex min-h-0 min-w-[200px] flex-col overflow-hidden ${editorExpanded ? 'hidden' : ''} flex-1`}>
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
                onReplaceTemporarySession={onReplaceTemporarySession}
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
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          isResizing={isResizing}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.path}
          isReadOnly={isViewOnlyWorkspace}
          fillSpace={activeTab === 'files'}
          onOpenFile={handleFileManagerFileOpen}
        />
      </div>

    </div>
  );
}

export default React.memo(MainContent);
