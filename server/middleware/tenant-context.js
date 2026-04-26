import { multitenancyDb } from '../database/multitenancy-db.js';

function parsePositiveInt(value) {
  if (Array.isArray(value)) {
    return parsePositiveInt(value[0]);
  }
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function isSystemAdmin(user) {
  return user?.is_system_admin === 1 || user?.is_system_admin === true;
}

function grantSystemAdminTenantAccess({ multitenancy, userId, tenantId }) {
  if (typeof multitenancy.memberships.grantSystemAdminAccessToTenant === 'function') {
    return multitenancy.memberships.grantSystemAdminAccessToTenant({ userId, tenantId });
  }

  const tenant = multitenancy.tenants?.getTenantById?.(tenantId);
  if (!tenant || tenant.status !== 'active') return null;

  if (typeof multitenancy.memberships.upsertMembership === 'function') {
    return multitenancy.memberships.upsertMembership({
      tenantId,
      userId,
      role: 'system_admin',
      permission: 'edit',
      status: 'active',
    });
  }

  return {
    tenant_id: tenantId,
    user_id: userId,
    role: 'system_admin',
    permission: 'edit',
    status: 'active',
  };
}

export function resolveTenantIdFromRequest(req) {
  const queryTenantId = parsePositiveInt(req.query?.tenantId);
  if (queryTenantId) return queryTenantId;

  const headerTenantId = parsePositiveInt(req.headers?.['x-tenant-id']);
  if (headerTenantId) return headerTenantId;

  try {
    const url = new URL(req.url || '', 'http://localhost');
    return parsePositiveInt(url.searchParams.get('tenantId'));
  } catch {
    return null;
  }
}

export function createTenantContextMiddleware(multitenancy = multitenancyDb) {
  return async function tenantContextMiddleware(req, res, next) {
    const tenantId = resolveTenantIdFromRequest(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const userId = req.user?.id ?? req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
    if (!membership && isSystemAdmin(req.user)) {
      membership = grantSystemAdminTenantAccess({ multitenancy, userId, tenantId });
    }

    if (!membership) {
      return res.status(403).json({ error: 'Tenant access denied' });
    }

    req.tenant = {
      id: tenantId,
      membership,
      permission: membership.permission,
    };
    return next();
  };
}

export const tenantContext = createTenantContextMiddleware(multitenancyDb);

export function resolveWebSocketTenant({ request, user, multitenancy = multitenancyDb }) {
  const tenantId = resolveTenantIdFromRequest(request);
  const userId = user?.id ?? user?.userId;
  if (!tenantId || !userId) return null;

  let membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
  if (!membership && isSystemAdmin(user)) {
    membership = grantSystemAdminTenantAccess({ multitenancy, userId, tenantId });
  }
  if (!membership) return null;

  return {
    id: tenantId,
    membership,
    permission: membership.permission,
  };
}
