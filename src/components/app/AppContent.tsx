import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import Sidebar from '../sidebar/view/Sidebar';
import MainContent from '../main-content/view/MainContent';
import AdminPanel from '../admin/AdminPanel';
import ScheduledTasksDialog from '../chat/view/subcomponents/ScheduledTasksDialog';
import { isSystemAdminUser } from '../admin/adminPanelUtils';
import { useAuth } from '../auth/context/AuthContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useTenant } from '../../contexts/TenantContext';
import { useDeviceSettings } from '../../hooks/useDeviceSettings';
import { useModelResponseBrowserNotifications } from '../../hooks/useModelResponseBrowserNotifications';
import { useSessionProtection } from '../../hooks/useSessionProtection';
import { useProjectsState } from '../../hooks/useProjectsState';
import type { LLMProvider, Project, ProjectSession, Tenant } from '../../types/app';

type ScheduledTaskEditorState = {
  project: Project;
  taskId: number;
  provider: LLMProvider;
};

export default function AppContent() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const { t } = useTranslation('common');
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { user } = useAuth();
  const { tenants, currentTenant, selectTenant } = useTenant();
  const { ws, sendMessage, subscribeMessage, latestMessage, isConnected } = useWebSocket();
  const wasConnectedRef = useRef(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [scheduledTaskEditor, setScheduledTaskEditor] = useState<ScheduledTaskEditorState | null>(null);
  const isSystemAdmin = isSystemAdminUser(user);

  const {
    activeSessions,
    processingSessions,
    markSessionAsActive,
    markSessionAsInactive,
    markSessionAsProcessing,
    markSessionAsNotProcessing,
    replaceTemporarySession,
  } = useSessionProtection();

  const {
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    externalMessageUpdate,
    setActiveTab,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    refreshProjectsSilently,
    sidebarSharedProps,
  } = useProjectsState({
    sessionId,
    navigate,
    latestMessage,
    isMobile,
    activeSessions,
  });

  const handleTenantSwitch = useCallback((tenant: Tenant) => {
    selectTenant(tenant);
    navigate('/');

    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile, navigate, selectTenant, setSidebarOpen]);

  const handleScheduledTaskOpen = useCallback((project: Project, session: ProjectSession) => {
    const taskId = Number(session.scheduledTask?.id);
    if (!Number.isFinite(taskId)) {
      return;
    }

    setScheduledTaskEditor({
      project,
      taskId,
      provider: session.scheduledTask?.provider || session.__provider || 'claude',
    });
    setActiveTab('chat');

    if (isMobile) {
      setSidebarOpen(false);
    }
  }, [isMobile, setActiveTab, setSidebarOpen]);

  const handleNotificationNavigate = useCallback((targetSessionId: string) => {
    setActiveTab('chat');
    setSidebarOpen(false);
    navigate(`/session/${targetSessionId}`);
  }, [navigate, setActiveTab, setSidebarOpen]);

  useModelResponseBrowserNotifications({
    subscribeMessage,
    onNavigateToSession: handleNotificationNavigate,
  });

  useEffect(() => {
    // Expose a non-blocking refresh for chat/session flows.
    // Full loading refreshes are still available through direct fetchProjects calls.
    window.refreshProjects = refreshProjectsSilently;

    return () => {
      if (window.refreshProjects === refreshProjectsSilently) {
        delete window.refreshProjects;
      }
    };
  }, [refreshProjectsSilently]);

  useEffect(() => {
    window.openSettings = openSettings;

    return () => {
      if (window.openSettings === openSettings) {
        delete window.openSettings;
      }
    };
  }, [openSettings]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return undefined;
    }

    const handleServiceWorkerMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.type !== 'notification:navigate') {
        return;
      }

      if (typeof message.provider === 'string' && message.provider.trim()) {
        localStorage.setItem('selected-provider', message.provider);
      }

      setActiveTab('chat');
      setSidebarOpen(false);
      void refreshProjectsSilently();

      if (typeof message.sessionId === 'string' && message.sessionId) {
        navigate(`/session/${message.sessionId}`);
        return;
      }

      navigate('/');
    };

    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
    };
  }, [navigate, refreshProjectsSilently, setActiveTab, setSidebarOpen]);

  // Permission recovery: query pending permissions on WebSocket reconnect or session change
  useEffect(() => {
    const isReconnect = isConnected && !wasConnectedRef.current;

    if (isReconnect) {
      wasConnectedRef.current = true;
    } else if (!isConnected) {
      wasConnectedRef.current = false;
    }

    if (isConnected && selectedSession?.id) {
      sendMessage({
        type: 'get-pending-permissions',
        sessionId: selectedSession.id
      });
    }
  }, [isConnected, selectedSession?.id, sendMessage]);

  // Adjust the app container to stay above the virtual keyboard on iOS Safari.
  // On Chrome for Android the layout viewport already shrinks when the keyboard opens,
  // so inset-0 adjusts automatically. On iOS the layout viewport stays full-height and
  // the keyboard overlays it — we use the Visual Viewport API to track keyboard height
  // and apply it as a CSS variable that shifts the container's bottom edge up.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // Only resize matters — keyboard open/close changes vv.height.
      // Do NOT listen to scroll: on iOS Safari, scrolling content changes
      // vv.offsetTop which would make --keyboard-height fluctuate during
      // normal scrolling, causing the container to bounce up and down.
      const kb = Math.max(0, window.innerHeight - vv.height);
      document.documentElement.style.setProperty('--keyboard-height', `${kb}px`);
    };
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return (
    <div className="fixed inset-0 flex bg-background" style={{ bottom: 'var(--keyboard-height, 0px)' }}>
      {!isMobile ? (
        <div className="h-full flex-shrink-0 border-r border-border/50">
          <Sidebar
            {...sidebarSharedProps}
            onScheduledTaskOpen={handleScheduledTaskOpen}
            showAdminEntry={isSystemAdmin}
            onShowAdminPanel={() => setShowAdminPanel(true)}
            tenants={tenants}
            currentTenant={currentTenant}
            onTenantSwitch={handleTenantSwitch}
          />
        </div>
      ) : (
        <div
          className={`fixed inset-0 z-50 flex transition-all duration-150 ease-out ${sidebarOpen ? 'visible opacity-100' : 'invisible opacity-0'
            }`}
        >
          <button
            className="fixed inset-0 bg-background/60 backdrop-blur-sm transition-opacity duration-150 ease-out"
            onClick={(event) => {
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            onTouchStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarOpen(false);
            }}
            aria-label={t('versionUpdate.ariaLabels.closeSidebar')}
          />
          <div
            className={`relative h-full w-[85vw] max-w-sm transform border-r border-border/40 bg-card transition-transform duration-150 ease-out sm:w-80 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            onClick={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            <Sidebar
              {...sidebarSharedProps}
              onScheduledTaskOpen={handleScheduledTaskOpen}
              showAdminEntry={isSystemAdmin}
              onShowAdminPanel={() => setShowAdminPanel(true)}
              tenants={tenants}
              currentTenant={currentTenant}
              onTenantSwitch={handleTenantSwitch}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <MainContent
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          ws={ws}
          sendMessage={sendMessage}
          latestMessage={latestMessage}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(true)}
          isLoading={isLoadingProjects}
          onInputFocusChange={setIsInputFocused}
          onSessionActive={markSessionAsActive}
          onSessionInactive={markSessionAsInactive}
          onSessionProcessing={markSessionAsProcessing}
          onSessionNotProcessing={markSessionAsNotProcessing}
          processingSessions={processingSessions}
          onReplaceTemporarySession={replaceTemporarySession}
          onNavigateToSession={(targetSessionId: string) => navigate(`/session/${targetSessionId}`)}
          onShowSettings={() => setShowSettings(true)}
          externalMessageUpdate={externalMessageUpdate}
        />
      </div>

      <AdminPanel open={showAdminPanel} onOpenChange={setShowAdminPanel} />

      {scheduledTaskEditor ? (
        <ScheduledTasksDialog
          open
          selectedProject={scheduledTaskEditor.project}
          provider={scheduledTaskEditor.provider}
          initialTaskId={scheduledTaskEditor.taskId}
          onClose={() => setScheduledTaskEditor(null)}
        />
      ) : null}
    </div>
  );
}
