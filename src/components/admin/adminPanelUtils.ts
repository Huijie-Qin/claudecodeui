type SystemAdminCandidate = {
  [key: string]: unknown;
  is_system_admin?: unknown;
} | null | undefined;

export type TenantPermission = 'view' | 'edit';

export function isSystemAdminUser(user: SystemAdminCandidate): boolean {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}

export function buildTenantMembershipPayload(permission: TenantPermission) {
  return {
    role: 'member',
    permission,
    status: 'active',
  };
}
