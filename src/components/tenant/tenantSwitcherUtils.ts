import type { Tenant } from '../../types/app';

export function shouldShowTenantSwitcher(tenants: Tenant[]): boolean {
  return tenants.length > 1;
}

export function resolveTenantSelection(tenants: Tenant[], tenantId: string): Tenant | null {
  const numericTenantId = Number(tenantId);
  if (!Number.isInteger(numericTenantId) || numericTenantId <= 0) return null;

  return tenants.find((tenant) => tenant.id === numericTenantId) ?? null;
}
