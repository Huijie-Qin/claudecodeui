export function canManageTenant(user: { [key: string]: unknown; is_system_admin?: unknown } | null | undefined,
  tenant: { role?: string } | null | undefined): boolean {
  return Boolean(user && tenant && (user.is_system_admin === true || user.is_system_admin === 1 || tenant.role === 'tenant_admin'));
}

// Navigation is role-specific: platform admins use Admin, not this entry.
// This does not change the existing page or backend management permissions.
export function shouldShowTenantManagementEntry(user: Parameters<typeof canManageTenant>[0],
  tenant: Parameters<typeof canManageTenant>[1]): boolean {
  return Boolean(user && !user.is_system_admin && tenant?.role === 'tenant_admin');
}
