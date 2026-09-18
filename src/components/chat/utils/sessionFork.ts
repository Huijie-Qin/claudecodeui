import type { Project, ProjectSession } from '../../../types/app';
import type { ChatMessage } from '../types/types';

export function canForkMessage(message: ChatMessage, provider: string): boolean {
  return provider === 'claude'
    && message.canFork === true
    && Boolean(message.sourceMessageUuid)
    && message.type === 'assistant'
    && !message.isStreaming
    && !message.isThinking
    && !message.isToolUse
    && !message.isInteractivePrompt
    && !message.isTaskNotification
    && !message.isHookActivity;
}

/** Register a server-created session before its route is selected. */
export function addForkedSessionToProjects(
  projects: Project[],
  sourceProject: Project,
  session: ProjectSession,
): Project[] {
  return projects.map((project) => {
    if (project.name !== sourceProject.name || project.workspaceId !== sourceProject.workspaceId) {
      return project;
    }
    const sessions = project.sessions || [];
    const exists = sessions.some((candidate) => candidate.id === session.id);
    return {
      ...project,
      sessions: [session, ...sessions.filter((candidate) => candidate.id !== session.id)],
      sessionMeta: {
        ...project.sessionMeta,
        total: (project.sessionMeta?.total ?? sessions.length) + (exists ? 0 : 1),
      },
    };
  });
}
