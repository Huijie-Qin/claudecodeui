import type { Project } from '../types/app';

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
