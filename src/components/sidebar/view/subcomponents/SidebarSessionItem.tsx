import { Check, Clock, Edit2, Star, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { MouseEvent } from 'react';

import { Badge, Button } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import { formatTimeAgo } from '../../../../utils/dateUtils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel } from '../../utils/utils';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (project: Project, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onToggleSessionFavorite: (project: Project, session: SessionWithProvider) => void;
  onDeleteSession: (
    project: Project,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  t: TFunction;
};

export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onToggleSessionFavorite,
  onDeleteSession,
  t,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const isFavorited = session.isFavorited === true;
  const isScheduledTaskSession = session.isScheduledTaskSession === true;
  const canRenameSession = !isScheduledTaskSession;

  const selectMobileSession = () => {
    onProjectSelect(project);
    onSessionSelect(session, project.name);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project, session.id, sessionView.sessionName, session.__provider);
  };

  const toggleFavoriteSession = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleSessionFavorite(project, session);
  };
  return (
    <div className="group relative">
      {sessionView.isActive && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <div className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
        </div>
      )}

      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/10 border-primary/30' : '',
            !isSelected &&
              (sessionView.isActive
                ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
                : 'border-border/30'),
          )}
          onClick={selectMobileSession}
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="truncate text-xs font-medium text-foreground" title={sessionView.sessionName}>
                  {sessionView.sessionName}
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(sessionView.sessionTime, currentTime, t)}
                </span>
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="ml-auto px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>

            <button
              className={cn(
                'ml-1 flex h-5 w-5 items-center justify-center rounded-md border transition-transform active:scale-95',
                isFavorited
                  ? 'border-yellow-200 bg-yellow-500/10 text-yellow-600 dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : 'border-gray-200 bg-gray-500/10 text-gray-600 dark:border-gray-800 dark:bg-gray-900/30 dark:text-gray-400',
              )}
              onClick={toggleFavoriteSession}
              title={isFavorited
                ? t('tooltips.removeSessionFromFavorites', { defaultValue: 'Remove session from favorites' })
                : t('tooltips.addSessionToFavorites', { defaultValue: 'Add session to favorites' })}
            >
              <Star className={cn('h-2.5 w-2.5', isFavorited && 'fill-current')} />
            </button>

            {!sessionView.isCursorSession && (
              <button
                className="ml-1 flex h-5 w-5 items-center justify-center rounded-md bg-red-50 opacity-70 transition-transform active:scale-95 dark:bg-red-900/20"
                onClick={(event) => {
                  event.stopPropagation();
                  requestDeleteSession();
                }}
              >
                <Trash2 className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="hidden md:block">
        <Button
          variant="ghost"
          className={cn(
            'h-auto w-full justify-start border-l-2 border-transparent p-2 text-left font-normal transition-colors duration-200 hover:bg-accent/50',
            isSelected && 'border-primary/60 bg-primary/10 text-accent-foreground hover:bg-primary/15',
          )}
          onClick={() => onSessionSelect(session, project.name)}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <div className="truncate text-xs font-medium text-foreground" title={sessionView.sessionName}>
                  {sessionView.sessionName}
                </div>
              </div>
              <div className="mt-0.5 flex items-center gap-1">
                <Clock className="h-2.5 w-2.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  {formatTimeAgo(sessionView.sessionTime, currentTime, t)}
                </span>
                {sessionView.messageCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-auto px-1 py-0 text-xs transition-opacity group-hover:opacity-0"
                  >
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </Button>

        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-all duration-200">
            {editingSession === session.id && canRenameSession ? (
              <>
                <input
                  type="text"
                  value={editingSessionName}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      saveEditedSession();
                    } else if (event.key === 'Escape') {
                      onCancelEditingSession();
                    }
                  }}
                  onClick={(event) => event.stopPropagation()}
                  className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    saveEditedSession();
                  }}
                  title={t('tooltips.save')}
                >
                  <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
                </button>
                <button
                  className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCancelEditingSession();
                  }}
                  title={t('tooltips.cancel')}
                >
                  <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                </button>
              </>
            ) : (
              <>
                {canRenameSession && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 opacity-0 hover:bg-gray-100 group-hover:opacity-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      onStartEditingSession(session.id, sessionView.sessionName);
                    }}
                    title={t('tooltips.editSessionName')}
                  >
                    <Edit2 className="h-3 w-3 text-gray-600 dark:text-gray-400" />
                  </button>
                )}
                <button
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded transition-all duration-200 hover:bg-yellow-50 dark:hover:bg-yellow-900/20',
                    isFavorited ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                  onClick={toggleFavoriteSession}
                  title={isFavorited
                    ? t('tooltips.removeSessionFromFavorites', { defaultValue: 'Remove session from favorites' })
                    : t('tooltips.addSessionToFavorites', { defaultValue: 'Add session to favorites' })}
                >
                  <Star
                    className={cn(
                      'h-3 w-3 transition-colors',
                      isFavorited ? 'fill-current text-yellow-600 dark:text-yellow-400' : 'text-gray-600 dark:text-gray-400',
                    )}
                  />
                </button>
                {!sessionView.isCursorSession && (
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded bg-red-50 opacity-0 hover:bg-red-100 group-hover:opacity-100 dark:bg-red-900/20 dark:hover:bg-red-900/40"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDeleteSession();
                    }}
                    title={t('tooltips.deleteSession')}
                  >
                    <Trash2 className="h-3 w-3 text-red-600 dark:text-red-400" />
                  </button>
                )}
              </>
            )}
          </div>
      </div>
    </div>
  );
}
