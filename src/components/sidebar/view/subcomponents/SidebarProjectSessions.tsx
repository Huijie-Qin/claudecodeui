import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FolderClock, Pause, Plus, Settings2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { Project, ProjectScheduledTask, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  isLoadingSessions: boolean;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (project: Project, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onScheduledTaskOpen?: (project: Project, task: ProjectScheduledTask) => void;
  onToggleSessionFavorite: (project: Project, session: SessionWithProvider) => void;
  onDeleteSession: (
    project: Project,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (project: Project) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  isLoadingSessions,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onScheduledTaskOpen,
  onToggleSessionFavorite,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<number>>(new Set());
  const { regularSessions, taskFolders, sessionsByTaskId } = useMemo(() => {
    const folders = new Map<number, ProjectScheduledTask>();
    const grouped = new Map<number, SessionWithProvider[]>();
    const regular: SessionWithProvider[] = [];

    for (const task of project.scheduledTasks || []) {
      folders.set(task.id, task);
      grouped.set(task.id, []);
    }

    for (const session of sessions) {
      const taskId = Number(session.scheduledTask?.id);
      if (!Number.isFinite(taskId)) {
        regular.push(session);
        continue;
      }

      if (!folders.has(taskId)) {
        folders.set(taskId, {
          id: taskId,
          name: String(session.scheduledTask?.name || session.summary || 'Scheduled task'),
          enabled: session.scheduledTask?.enabled !== false,
          provider: session.scheduledTask?.provider || session.__provider,
          sessionMode: session.scheduledTask?.sessionMode === 'merge' ? 'merge' : 'new',
          scheduleType: session.scheduledTask?.scheduleType,
          scheduleCron: session.scheduledTask?.scheduleCron,
          scheduleStartAt: session.scheduledTask?.scheduleStartAt,
          nextRunAt: session.scheduledTask?.nextRunAt,
        });
      }
      const taskSessions = grouped.get(taskId) || [];
      taskSessions.push(session);
      grouped.set(taskId, taskSessions);
    }

    return {
      regularSessions: regular,
      taskFolders: [...folders.values()],
      sessionsByTaskId: grouped,
    };
  }, [project.scheduledTasks, sessions]);

  useEffect(() => {
    const selectedTaskId = Number(selectedSession?.scheduledTask?.id);
    if (!Number.isFinite(selectedTaskId)) return;
    setExpandedTaskIds((current) => {
      if (current.has(selectedTaskId)) return current;
      const next = new Set(current);
      next.add(selectedTaskId);
      return next;
    });
  }, [selectedSession]);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = regularSessions.length > 0 || taskFolders.length > 0;
  const hasMoreSessions = project.sessionMeta?.hasMore === true;
  const toggleTaskFolder = (taskId: number) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const renderSession = (session: SessionWithProvider) => (
    <SidebarSessionItem
      key={`${session.__provider}:${session.id}`}
      project={project}
      session={session}
      selectedSession={selectedSession}
      currentTime={currentTime}
      editingSession={editingSession}
      editingSessionName={editingSessionName}
      onEditingSessionNameChange={onEditingSessionNameChange}
      onStartEditingSession={onStartEditingSession}
      onCancelEditingSession={onCancelEditingSession}
      onSaveEditingSession={onSaveEditingSession}
      onProjectSelect={onProjectSelect}
      onSessionSelect={onSessionSelect}
      onToggleSessionFavorite={onToggleSessionFavorite}
      onDeleteSession={onDeleteSession}
      t={t}
    />
  );

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      <div className="px-3 pb-1 pt-1 md:hidden">
        <button
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </button>
      </div>

      <Button
        variant="default"
        size="sm"
        className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !isLoadingSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {taskFolders.map((task) => {
            const taskSessions = sessionsByTaskId.get(task.id) || [];
            const isTaskExpanded = expandedTaskIds.has(task.id);
            const containsSelectedSession = taskSessions.some((session) => session.id === selectedSession?.id);
            return (
              <div key={task.id} className="space-y-1">
                <div className="group/task flex min-w-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    className={`h-8 min-w-0 flex-1 justify-start gap-1.5 px-2 text-left text-xs font-normal ${containsSelectedSession ? 'bg-accent' : ''}`}
                    onClick={() => toggleTaskFolder(task.id)}
                  >
                    {isTaskExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <FolderClock className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate" title={task.name}>{task.name}</span>
                    {task.enabled ? null : <Pause className="h-3 w-3 shrink-0 text-amber-600" />}
                    <span className="shrink-0 text-[10px] text-muted-foreground">{taskSessions.length}</span>
                  </Button>
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover/task:opacity-100"
                    onClick={() => onScheduledTaskOpen?.(project, task)}
                    title={t('tooltips.editScheduledTask', { defaultValue: 'Edit scheduled task' })}
                    aria-label={t('tooltips.editScheduledTask', { defaultValue: 'Edit scheduled task' })}
                  >
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {isTaskExpanded ? (
                  <div className="ml-3 space-y-1 border-l border-border pl-2">
                    {taskSessions.length > 0
                      ? taskSessions.map(renderSession)
                      : <p className="px-2 py-1 text-xs text-muted-foreground">{t('sessions.noTaskRuns', { defaultValue: 'No runs yet' })}</p>}
                  </div>
                ) : null}
              </div>
            );
          })}
          {regularSessions.map(renderSession)}
        </>
      )}

      {hasSessions && hasMoreSessions && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-center gap-2 text-muted-foreground"
          onClick={() => onLoadMoreSessions(project)}
          disabled={isLoadingSessions}
        >
          {isLoadingSessions ? (
            <>
              <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
              {t('sessions.loading')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              {t('sessions.showMore')}
            </>
          )}
        </Button>
      )}
    </div>
  );
}
