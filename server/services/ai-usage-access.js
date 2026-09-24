export function aiUsageError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

export function positiveId(value, name = 'tenantId') {
  if (Array.isArray(value) || !/^\d+$/.test(String(value ?? '')) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw aiUsageError(400, 'invalidFilter', `${name} must be a positive integer`);
  }
  return Number(value);
}

// Never trust JWT roles or the tenant-context cache for a report/download authorization.
export function createAiUsageAccessService({ db }) {
  function resolve({ userId, tenantId, scope }) {
    if (userId == null) throw aiUsageError(401, 'authenticationRequired', 'Active user required');
    const user = db.prepare('SELECT id, username, is_active, is_system_admin FROM users WHERE id = ?').get(positiveId(userId, 'userId'));
    if (!user || !user.is_active) throw aiUsageError(401, 'authenticationRequired', 'Active user required');
    const id = positiveId(tenantId);
    const tenant = db.prepare('SELECT id, status FROM tenants WHERE id = ?').get(id);
    if (!tenant || tenant.status !== 'active') throw aiUsageError(403, 'tenantAccessDenied', 'Tenant access denied');
    const membership = db.prepare('SELECT role, status FROM tenant_users WHERE tenant_id = ? AND user_id = ?').get(id, user.id);
    const systemAdmin = user.is_system_admin === 1;
    if (!systemAdmin && membership?.status !== 'active') throw aiUsageError(403, 'tenantAccessDenied', 'Tenant access denied');
    const canViewTenant = systemAdmin || membership?.role === 'tenant_admin';
    const selectedScope = scope ?? (canViewTenant ? 'tenant' : 'self');
    if (!['self', 'tenant'].includes(selectedScope)) throw aiUsageError(400, 'invalidFilter', 'scope must be self or tenant');
    if (selectedScope === 'tenant' && !canViewTenant) throw aiUsageError(403, 'tenantReportDenied', 'Tenant report access required');
    return { tenantId: id, userId: user.id, scope: selectedScope, canViewTenant, canViewDefinitions: systemAdmin, canExport: true, defaultScope: canViewTenant ? 'tenant' : 'self' };
  }
  return { resolve };
}
