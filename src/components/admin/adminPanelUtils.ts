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

export function parseBatchUsernames(value: string): string[] {
  const seen = new Set<string>();

  return value
    .split(/[\s,;]+/g)
    .map((username) => username.trim())
    .filter((username) => {
      if (!username || seen.has(username.toLowerCase())) {
        return false;
      }

      seen.add(username.toLowerCase());
      return true;
    });
}

export function normalizeTenantCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}
