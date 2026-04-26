type SessionMessagesUrlOptions = {
  provider?: string;
  projectName?: string;
  projectPath?: string;
  workspaceId?: number | string;
  limit?: number | null;
  offset?: number;
  tenantId?: number | string | null;
};

function readCurrentTenantId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem('currentTenantId');
}

function appendParam(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null || value === '') return;
  params.append(key, String(value));
}

export function buildSessionMessagesUrl(
  sessionId: string,
  options: SessionMessagesUrlOptions = {},
): string {
  const params = new URLSearchParams();
  appendParam(params, 'provider', options.provider);
  appendParam(params, 'projectName', options.projectName);
  appendParam(params, 'projectPath', options.projectPath);
  appendParam(params, 'workspaceId', options.workspaceId);
  if (options.limit !== null && options.limit !== undefined) {
    appendParam(params, 'limit', options.limit);
    appendParam(params, 'offset', options.offset ?? 0);
  }
  appendParam(params, 'tenantId', options.tenantId ?? readCurrentTenantId());

  const queryString = params.toString();
  return `/api/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`;
}
