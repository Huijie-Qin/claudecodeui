import { workspaceAccess } from './workspace-access.js';

function parsePositiveInt(value) {
  if (Array.isArray(value)) {
    return parsePositiveInt(value[0]);
  }
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function getRequestTenantId(req) {
  return parsePositiveInt(req.query?.tenantId ?? req.body?.tenantId ?? req.headers?.['x-tenant-id']);
}

export function getRequestWorkspaceId(req) {
  return parsePositiveInt(req.query?.workspaceId ?? req.body?.workspaceId ?? req.params?.workspaceId);
}

export function getRequestUserId(req) {
  return req.user?.id ?? req.user?.userId ?? null;
}

export function handleWorkspaceError(res, error) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    error: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.details ? { details: error.details } : {}),
  });
}

export function createWorkspaceRequestResolver(access = workspaceAccess) {
  return function resolveWorkspaceForRequest(req, { requireEdit = false } = {}) {
    const tenantId = getRequestTenantId(req);
    const userId = getRequestUserId(req);
    const workspaceId = getRequestWorkspaceId(req);

    if (!tenantId || !workspaceId || !userId) {
      const error = new Error('tenantId and workspaceId are required');
      error.statusCode = 400;
      throw error;
    }

    return access.requireWorkspace({ tenantId, userId, workspaceId, requireEdit });
  };
}

export const resolveWorkspaceForRequest = createWorkspaceRequestResolver(workspaceAccess);
