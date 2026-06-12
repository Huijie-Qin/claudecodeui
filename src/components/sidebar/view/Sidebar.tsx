import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { cn } from '../../../lib/utils';
import type { Project, LLMProvider } from '../../../types/app';
import WorkspaceShareDialog from '../../workspace-share/WorkspaceShareDialog';
import { useSidebarController } from '../hooks/useSidebarController';
import type { MCPServerStatus, SidebarProps } from '../types/types';

import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';

const SIDEBAR_WIDTH_STORAGE_KEY = 'cloudcli.sidebar.width';
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 480;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  onProjectSelect,
  onShareProject,
  onSessionSelect,
  onScheduledTaskOpen,
  onScheduledTasksListOpen,
  onNewSession,
  onSessionDelete,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
  showAdminEntry,
  onShowAdminPanel,
  tenants,
  currentTenant,
  onTenantSwitch,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMaster() as TaskMasterSidebarContext;
  const { tasksEnabled } = useTasksSettings();
  const [shareProject, setShareProject] = useState<Project | null>(null);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_SIDEBAR_WIDTH;
    }

    const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(savedWidth)
      ? clampSidebarWidth(savedWidth)
      : DEFAULT_SIDEBAR_WIDTH;
  });

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    loadingSessions,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    filteredProjects,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    loadMoreSessions,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onProjectDelete,
    setCurrentProject,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const handleProjectCreated = () => {
    if (window.refreshProjects) {
      void window.refreshProjects();
      return;
    }

    window.location.reload();
  };

  const handleShareProject = (project: Project) => {
    if (onShareProject) {
      onShareProject(project);
      return;
    }

    setShareProject(project);
  };

  const persistSidebarWidth = (width: number) => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  };

  const handleSidebarResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isMobile || event.button !== 0) {
      return;
    }

    event.preventDefault();

    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latestWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    setIsResizingSidebar(true);
    document.body.style.cursor = 'pointer';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
      setSidebarWidth(latestWidth);
    };

    const stopResizing = () => {
      setIsResizingSidebar(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      persistSidebarWidth(latestWidth);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);
  };

  const adjustSidebarWidth = (delta: number) => {
    setSidebarWidth((currentWidth) => {
      const nextWidth = clampSidebarWidth(currentWidth + delta);
      persistSidebarWidth(nextWidth);
      return nextWidth;
    });
  };

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    editingProject,
    editingName,
    loadingSessions,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    isProjectStarred,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onShareProject: handleShareProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (project) => {
      void saveProjectName(project);
    },
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onScheduledTaskOpen,
    onScheduledTasksListOpen,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: (project) => {
      void loadMoreSessions(project);
    },
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (project, sessionId: string, summary: string, provider: LLMProvider) => {
      void updateSessionSummary(project, sessionId, summary, provider);
    },
    t,
  };

  return (
    <>
      <SidebarModals
        projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        t={t}
      />

      <WorkspaceShareDialog
        project={shareProject}
        open={Boolean(shareProject)}
        onOpenChange={(open) => {
          if (!open) {
            setShareProject(null);
          }
        }}
      />

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          t={t}
        />
      ) : (
        <div
          className={cn('relative h-full', isResizingSidebar && 'select-none')}
          style={isMobile ? undefined : {
            width: sidebarWidth,
            minWidth: MIN_SIDEBAR_WIDTH,
            maxWidth: MAX_SIDEBAR_WIDTH,
          }}
        >
          <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            searchMode={searchMode}
            onSearchModeChange={(mode: 'projects' | 'conversations') => {
              setSearchMode(mode);
              if (mode === 'projects') clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onConversationResultClick={(projectName: string, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
              const resolvedProvider = (provider || 'claude') as LLMProvider;
              const project = projects.find(p => p.name === projectName);
              const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
              const sessionObj = {
                id: sessionId,
                __provider: resolvedProvider,
                __projectName: projectName,
                ...searchTarget,
              };
              if (project) {
                handleProjectSelect(project);
                const sessions = getProjectSessions(project);
                const existing = sessions.find(s => s.id === sessionId);
                if (existing) {
                  handleSessionClick({ ...existing, ...searchTarget }, projectName);
                } else {
                  handleSessionClick(sessionObj, projectName);
                }
              } else {
                handleSessionClick(sessionObj, projectName);
              }
            }}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            onCreateProject={() => setShowNewProject(true)}
            onCollapseSidebar={handleCollapseSidebar}
            onShowSettings={onShowSettings}
            showAdminEntry={showAdminEntry}
            onShowAdminPanel={onShowAdminPanel}
            tenants={tenants}
            currentTenant={currentTenant}
            onTenantSwitch={onTenantSwitch}
            projectListProps={projectListProps}
            t={t}
          />
          {!isMobile && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-valuemin={MIN_SIDEBAR_WIDTH}
              aria-valuemax={MAX_SIDEBAR_WIDTH}
              aria-valuenow={sidebarWidth}
              tabIndex={0}
              className={cn(
                'absolute -right-1 top-0 z-20 flex h-full w-2 cursor-pointer touch-none items-center justify-center outline-none',
                'after:h-full after:w-px after:bg-border/0 after:transition-colors hover:after:bg-primary/50 focus-visible:after:bg-primary/70',
                isResizingSidebar && 'after:bg-primary/70',
              )}
              onPointerDown={handleSidebarResizeStart}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  adjustSidebarWidth(-16);
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  adjustSidebarWidth(16);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  setSidebarWidth(MIN_SIDEBAR_WIDTH);
                  persistSidebarWidth(MIN_SIDEBAR_WIDTH);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  setSidebarWidth(MAX_SIDEBAR_WIDTH);
                  persistSidebarWidth(MAX_SIDEBAR_WIDTH);
                }
              }}
            />
          )}
        </div>
      )}

    </>
  );
}

export default Sidebar;
