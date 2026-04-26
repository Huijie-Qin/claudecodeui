import type { Project } from '../types/app';

export function isProjectUpdateScopedToTenant(projects: Project[], tenantId?: number | null): boolean {
  if (!tenantId) return true;

  return projects.every((project) => Number(project.tenantId) === tenantId);
}
