import { multitenancyDb } from '../database/multitenancy-db.js';

function parsePositiveInt(value) {
  if (Array.isArray(value)) {
    return parsePositiveInt(value[0]);
  }
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

    const membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
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

  const membership = multitenancy.memberships.getActiveMembership(userId, tenantId);
  if (!membership) return null;

  return {
    id: tenantId,
    membership,
    permission: membership.permission,
  };
}
