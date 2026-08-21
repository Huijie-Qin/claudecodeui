import { CalendarClock, ChevronDown, ChevronRight, Edit3, Folder, FolderOpen, Star, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectScheduledTask, ProjectSession, LLMProvider } from '../../../../types/app';
import type { MCPServerStatus, SessionWithProvider } from '../../types/types';
import { getTaskIndicatorStatus } from '../../utils/utils';

import TaskIndicator from './TaskIndicator';
import SidebarProjectSessions from './SidebarProjectSessions';

type SidebarProjectItemProps = {
  project: Project;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  isExpanded: boolean;
  isDeleting: boolean;
  isStarred: boolean;
  sessions: SessionWithProvider[];
  processingSessions: ReadonlyMap<string, number>;
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  tasksEnabled: boolean;
  mcpServerStatus: MCPServerStatus;
  onToggleProject: (projectName: string) => void;
  onProjectSelect: (project: Project) => void;
  onShareProject: (project: Project) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onScheduledTaskOpen?: (project: Project, task: ProjectScheduledTask) => void;
  onScheduledTasksListOpen?: (project: Project) => void;
  onToggleSessionFavorite: (project: Project, session: SessionWithProvider) => void;
  onDeleteSession: (
    project: Project,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (project: Project, sessionId: string, summary: string, provider: LLMProvider) => void;
  t: TFunction;
};

const getSessionCountDisplay = (sessions: SessionWithProvider[], hasMoreSessions: boolean): string => {
  const sessionCount = sessions.length;
  if (hasMoreSessions && sessionCount >= 5) {
    return `${sessionCount}+`;
  }
  return `${sessionCount}`;
};

export default function SidebarProjectItem({
  project,
  selectedProject,
  selectedSession,
  isExpanded,
  isDeleting,
  isStarred,
  sessions,
  processingSessions,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  tasksEnabled,
  mcpServerStatus,
  onToggleProject,
  onProjectSelect,
  onShareProject: _onShareProject,
  onEditProject,
  onDeleteProject,
  onSessionSelect,
  onScheduledTaskOpen,
  onScheduledTasksListOpen,
  onToggleSessionFavorite,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectItemProps) {
  const isSelected = selectedProject?.name === project.name;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;
  const sessionCountDisplay = getSessionCountDisplay(sessions, hasMoreSessions);
  const sessionCountLabel = `${sessionCountDisplay} session${sessions.length === 1 ? '' : 's'}`;
  const taskStatus = getTaskIndicatorStatus(project, mcpServerStatus);
  const scheduledTasksTooltip = t('tooltips.scheduledTasks', { defaultValue: 'Scheduled tasks' });
  const editProjectTooltip = t('projectEdit.title', { defaultValue: '编辑项目' });

  void _onShareProject;

  const toggleProject = () => onToggleProject(project.name);
  const openScheduledTasksList = () => onScheduledTasksListOpen?.(project);
  const selectAndToggleProject = () => {
    if (selectedProject?.name !== project.name) {
      onProjectSelect(project);
    }
    toggleProject();
  };

  return (
    <div className={cn('md:space-y-1', isDeleting && 'pointer-events-none opacity-50')}>
      <div className="md:group group">
        <div className="md:hidden">
          <div
            className={cn(
              'mx-3 my-1 rounded-lg border border-border/50 bg-card p-3 transition-all duration-150 active:scale-[0.98]',
              isSelected && 'border-primary/20 bg-primary/5',
              isStarred && !isSelected && 'border-yellow-200/30 bg-yellow-50/50 dark:border-yellow-800/30 dark:bg-yellow-900/5',
            )}
            onClick={toggleProject}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                  isExpanded ? 'bg-primary/10' : 'bg-muted',
                )}>
                  {isExpanded
                    ? <FolderOpen className="h-4 w-4 text-primary" />
                    : <Folder className="h-4 w-4 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h3 className="truncate text-sm font-medium text-foreground">{project.displayName}</h3>
                    {isStarred ? <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" /> : null}
                    {tasksEnabled ? (
                      <TaskIndicator status={taskStatus} size="xs" className="ml-1 shrink-0" />
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">{sessionCountLabel}</p>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    openScheduledTasksList();
                  }}
                  title={scheduledTasksTooltip}
                >
                  <CalendarClock className="h-4 w-4 text-primary" />
                </button>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 active:scale-90 dark:border-primary/30 dark:bg-primary/20"
                  onClick={(event) => {
                    event.stopPropagation();
                    onEditProject(project);
                  }}
                  title={editProjectTooltip}
                >
                  <Edit3 className="h-4 w-4 text-primary" />
                </button>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-200 bg-red-500/10 active:scale-90 dark:border-red-800 dark:bg-red-900/30"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteProject(project);
                  }}
                  title={t('tooltips.deleteProject')}
                >
                  <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                </button>
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-muted/30">
                  {isExpanded
                    ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                </div>
              </div>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          className={cn(
            'hidden h-auto w-full justify-between p-2 font-normal hover:bg-accent/50 md:flex',
            isSelected && 'bg-accent text-accent-foreground',
            isStarred && !isSelected && 'bg-yellow-50/50 hover:bg-yellow-100/50 dark:bg-yellow-900/10 dark:hover:bg-yellow-900/20',
          )}
          onClick={selectAndToggleProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isExpanded
              ? <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
              : <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1 text-left">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="truncate text-sm font-semibold text-foreground" title={project.displayName}>
                  {project.displayName}
                </div>
                {isStarred ? <Star className="h-3 w-3 shrink-0 fill-current text-yellow-500" /> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {sessionCountDisplay}
                {project.fullPath !== project.displayName ? (
                  <span className="ml-1 opacity-60" title={project.fullPath}>
                    {' - '}{project.fullPath.length > 25 ? `...${project.fullPath.slice(-22)}` : project.fullPath}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <div
              className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                openScheduledTasksList();
              }}
              title={scheduledTasksTooltip}
            >
              <CalendarClock className="h-3 w-3 text-muted-foreground" />
            </div>
            <div
              className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-accent group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onEditProject(project);
              }}
              title={editProjectTooltip}
            >
              <Edit3 className="h-3 w-3" />
            </div>
            <div
              className="touch:opacity-100 flex h-6 w-6 cursor-pointer items-center justify-center rounded opacity-0 transition-all duration-200 hover:bg-red-50 group-hover:opacity-100 dark:hover:bg-red-900/20"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteProject(project);
              }}
              title={t('tooltips.deleteProject')}
            >
              <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
            </div>
            {isExpanded
              ? <ChevronDown className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
              : <ChevronRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />}
          </div>
        </Button>
      </div>

      <SidebarProjectSessions
        project={project}
        isExpanded={isExpanded}
        sessions={sessions}
        processingSessions={processingSessions}
        selectedSession={selectedSession}
        initialSessionsLoaded={initialSessionsLoaded}
        isLoadingSessions={isLoadingSessions}
        currentTime={currentTime}
        editingSession={editingSession}
        editingSessionName={editingSessionName}
        onEditingSessionNameChange={onEditingSessionNameChange}
        onStartEditingSession={onStartEditingSession}
        onCancelEditingSession={onCancelEditingSession}
        onSaveEditingSession={onSaveEditingSession}
        onProjectSelect={onProjectSelect}
        onSessionSelect={onSessionSelect}
        onScheduledTaskOpen={onScheduledTaskOpen}
        onToggleSessionFavorite={onToggleSessionFavorite}
        onDeleteSession={onDeleteSession}
        onLoadMoreSessions={onLoadMoreSessions}
        onNewSession={onNewSession}
        t={t}
      />
    </div>
  );
}
