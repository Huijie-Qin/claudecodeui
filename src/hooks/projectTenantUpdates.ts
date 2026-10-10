import type { Project, ProjectsUpdatedMessage } from '../types/app';

export function isProjectUpdateScopedToTenant(
  projects: Project[],
  tenantId?: number | null,
  messageTenantId?: number | null,
): boolean {
  if (!tenantId) return true;

  if (messageTenantId != null && Number(messageTenantId) !== tenantId) return false;
  if (projects.length === 0) return messageTenantId != null;

  return projects.every((project) => Number(project.tenantId) === tenantId);
}

/** A retained WebSocket event is not a fresh snapshot after local navigation. */
export function createProjectUpdateTracker() {
  const consumedMessages = new WeakSet<object>();
  return {
    consume(message: unknown, tenantId?: number | null): message is ProjectsUpdatedMessage {
      if (!message || typeof message !== 'object') return false;
      const update = message as ProjectsUpdatedMessage;
      if (update.type !== 'projects_updated' || !Array.isArray(update.projects)
        || !isProjectUpdateScopedToTenant(update.projects, tenantId, update.tenantId)
        || consumedMessages.has(message)) return false;
      consumedMessages.add(message);
      return true;
    },
  };
}
