import crypto from 'node:crypto';
import path from 'path';

import { scheduledTasksDb } from '../database/db.js';

export function slugifyWorkspaceName(value) {
  const normalizedName = String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase();
  const asciiSlug = normalizedName
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const containsNonAsciiLetterOrNumber = /[^\x00-\x7F]/.test(normalizedName)
    && /[\p{L}\p{N}]/u.test(normalizedName.replace(/[\x00-\x7F]/g, ''));

  if (!containsNonAsciiLetterOrNumber) {
    return asciiSlug.slice(0, 63);
  }

  const readablePrefix = asciiSlug || 'agent';
  const nameHash = crypto
    .createHash('sha256')
    .update(normalizedName)
    .digest('hex')
    .slice(0, 8);

  return `${readablePrefix.slice(0, 54)}-${nameHash}`;
}

export function sanitizePathSegment(value, fallback = 'x') {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return sanitized || fallback;
}

export function buildTenantWorkspacePath({
  workspacesRoot,
  tenantCode,
  username,
  tenantId,
  userId,
  requestedPath,
}) {
  const requestedName = path.basename(path.resolve(String(requestedPath || '')));
  const workspaceSlug = slugifyWorkspaceName(requestedName);
  if (!workspaceSlug) {
    return '';
  }

  return path.join(
    workspacesRoot,
    sanitizePathSegment(tenantCode, String(tenantId)),
    sanitizePathSegment(username, String(userId)),
    workspaceSlug,
  );
}

export function resolveWorkspaceTarget({
  workspaceType,
  workspacesRoot,
  tenantCode,
  username,
  tenantId,
  userId,
  requestedPath,
}) {
  const requestedName = path.basename(path.resolve(String(requestedPath || '')));
  const workspaceSlug = slugifyWorkspaceName(requestedName);
  const targetPath =
    workspaceType === 'new'
      ? buildTenantWorkspacePath({
        workspacesRoot,
        tenantCode,
        username,
        tenantId,
        userId,
        requestedPath,
      })
      : requestedPath;

  return {
    requestedName,
    workspaceSlug,
    targetPath,
  };
}

export function resolveCloneDestinationPath({
  workspaceType,
  workspaceRootPath,
  workspaceSlug,
  repoName,
}) {
  const normalizedRepoName = repoName || 'repository';
  const repoSlug = slugifyWorkspaceName(normalizedRepoName);
  if (workspaceType === 'new' && repoSlug && repoSlug === workspaceSlug) {
    return workspaceRootPath;
  }

  return path.join(workspaceRootPath, normalizedRepoName);
}

function mapSession(session, workspaceId, scheduledTaskMap = new Map()) {
  const mapped = {
    id: session.provider_session_id,
    summary: session.summary || 'New Session',
    lastActivity: session.updated_at,
    isFavorited: session.is_favorited === 1,
    __provider: session.provider,
    __workspaceId: workspaceId,
  };
  const scheduledTask = scheduledTaskMap.get(session.provider_session_id);
  if (scheduledTask) {
    mapped.isScheduledTaskSession = true;
    mapped.scheduledTask = scheduledTask;
  }
  return mapped;
}

export function mapWorkspaceRowsToProjects(rows, {
  tenantId,
  userId,
  listSessions,
  listScheduledTasks = scheduledTasksDb.listWorkspaceTasks,
  getScheduledTaskMap = scheduledTasksDb.getSessionTaskMap,
}) {
  return rows.map((row) => {
    const sessionRows = listSessions({
      tenantId,
      workspaceId: row.id,
      userId,
    }).filter((session) => (
      !String(session.provider_session_id || '').startsWith('scheduled-task-')
      && !String(session.provider_session_id || '').startsWith('pending:')
    ));
    const scheduledTasks = listScheduledTasks({
      tenantId,
      workspaceId: row.id,
      userId,
    });
    const scheduledTaskMap = getScheduledTaskMap({
      tenantId,
      workspaceId: row.id,
      userId,
      sessionIds: sessionRows.map((session) => session.provider_session_id),
    });

    return {
      name: row.slug,
      workspaceId: row.id,
      tenantId: row.tenant_id,
      ownerUserId: row.owner_user_id,
      path: row.path,
      fullPath: row.path,
      displayName: row.display_name,
      accessRole: row.accessRole,
      isCustomName: true,
      scheduledTasks,
      sessions: sessionRows
        .filter((session) => session.provider === 'claude')
        .map((session) => mapSession(session, row.id, scheduledTaskMap)),
      codexSessions: sessionRows
        .filter((session) => session.provider === 'codex')
        .map((session) => mapSession(session, row.id, scheduledTaskMap)),
      cursorSessions: sessionRows
        .filter((session) => session.provider === 'cursor')
        .map((session) => mapSession(session, row.id, scheduledTaskMap)),
      geminiSessions: sessionRows
        .filter((session) => session.provider === 'gemini')
        .map((session) => mapSession(session, row.id, scheduledTaskMap)),
      sessionMeta: {
        hasMore: false,
        total: sessionRows.length,
      },
    };
  });
}
