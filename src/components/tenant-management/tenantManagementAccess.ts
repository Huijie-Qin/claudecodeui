export function canManageTenant(user: { [key: string]: unknown; is_system_admin?: unknown } | null | undefined,
  tenant: { role?: string } | null | undefined): boolean {
  return Boolean(user && tenant && (user.is_system_admin === true || user.is_system_admin === 1 || tenant.role === 'tenant_admin'));
}
