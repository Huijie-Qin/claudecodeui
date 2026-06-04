import { IS_PLATFORM } from "../constants/config";
import { buildRuntimeQueryString } from "../components/admin/runtimeMonitorUtils";

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      localStorage.setItem('auth-token', refreshedToken);
    }
    return response;
  });
};

const getCurrentTenantId = () => localStorage.getItem('currentTenantId');

const withTenantParam = (url) => {
  const tenantId = getCurrentTenantId();
  if (!tenantId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}tenantId=${encodeURIComponent(tenantId)}`;
};

const withWorkspaceParam = (url, workspaceId) => {
  if (!workspaceId) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}workspaceId=${encodeURIComponent(String(workspaceId))}`;
};

const withTenantAndWorkspaceParam = (url, workspaceId) =>
  withTenantParam(withWorkspaceParam(url, workspaceId));

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password, gitEmail) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, gitEmail }),
    }),
    invitation: (token) => fetch(`/api/auth/invitations/${encodeURIComponent(token)}`),
    acceptInvitation: (token, password, gitEmail) => fetch(`/api/auth/invitations/${encodeURIComponent(token)}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, gitEmail }),
    }),
    passwordReset: (token) => fetch(`/api/auth/password-resets/${encodeURIComponent(token)}`),
    resetPassword: (token, password) => fetch(`/api/auth/password-resets/${encodeURIComponent(token)}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: (token) => fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: () => authenticatedFetch(withTenantParam('/api/projects')),
  sessions: (projectName, limit = 5, offset = 0, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`, workspaceId)),
  // Unified endpoint — all providers through one URL
  unifiedSessionMessages: (sessionId, provider = 'claude', { projectName = '', projectPath = '', workspaceId, limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.append('provider', provider);
    if (projectName) params.append('projectName', projectName);
    if (projectPath) params.append('projectPath', projectPath);
    if (workspaceId) params.append('workspaceId', String(workspaceId));
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(withTenantParam(`/api/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`));
  },
  renameProject: (projectName, displayName, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/rename`, workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  deleteSession: (projectName, sessionId, provider = 'claude', workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/sessions/${sessionId}`, workspaceId), {
      method: 'DELETE',
      body: JSON.stringify({ provider }),
    }),
  renameSession: (sessionId, summary, provider, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/sessions/${sessionId}/rename`, workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  deleteCodexSession: (sessionId, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/codex/sessions/${sessionId}`, workspaceId), {
      method: 'DELETE',
    }),
  deleteGeminiSession: (sessionId, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/gemini/sessions/${sessionId}`, workspaceId), {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false, deleteData = false, workspaceId) => {
    const params = new URLSearchParams();
    if (force) params.set('force', 'true');
    if (deleteData) params.set('deleteData', 'true');
    const qs = params.toString();
    const url = withTenantAndWorkspaceParam(`/api/projects/${projectName}${qs ? `?${qs}` : ''}`, workspaceId);
    return authenticatedFetch(url, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/search/conversations?${params.toString()}`;
  },
  createWorkspace: (workspaceData) =>
    authenticatedFetch(withTenantParam('/api/projects/create-workspace'), {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`, workspaceId)),
  readFileBlob: (projectName, filePath, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/files/content?path=${encodeURIComponent(filePath)}`, workspaceId)),
  saveFile: (projectName, filePath, content, workspaceId) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/file`), {
      method: 'PUT',
      body: JSON.stringify({ filePath, content, workspaceId }),
    }),
  getFiles: (projectName, options = {}, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/files`, workspaceId), options),

  // File operations
  createFile: (projectName, { path, type, name, workspaceId }) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/files/create`), {
      method: 'POST',
      body: JSON.stringify({ path, type, name, workspaceId }),
    }),

  renameFile: (projectName, { oldPath, newName, workspaceId }) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/files/rename`), {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName, workspaceId }),
    }),

  moveFile: (projectName, { sourcePath, targetDirectory, workspaceId }) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/files/move`), {
      method: 'PUT',
      body: JSON.stringify({ sourcePath, targetDirectory, workspaceId }),
    }),

  deleteFile: (projectName, { path, type, workspaceId }) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/files`), {
      method: 'DELETE',
      body: JSON.stringify({ path, type, workspaceId }),
    }),

  uploadFiles: (projectName, formData, workspaceId) => {
    if (workspaceId) {
      formData.set('workspaceId', String(workspaceId));
    }
    return authenticatedFetch(withTenantParam(`/api/projects/${projectName}/files/upload`), {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    });
  },

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) =>
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  tenants: {
    mine: () => authenticatedFetch('/api/tenants/me'),
    validate: (tenantId) => authenticatedFetch(`/api/tenants/${tenantId}/validate`),
    requestJoin: (tenantId, message) =>
      authenticatedFetch(`/api/tenants/${tenantId}/join-requests`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
  },

  admin: {
    tenants: () => authenticatedFetch('/api/admin/tenants'),
    analytics: (days = 30, tenantIds = []) => {
      const params = new URLSearchParams({ days: String(days) });
      if (Array.isArray(tenantIds) && tenantIds.length > 0) {
        params.set('tenantIds', tenantIds.map(String).join(','));
      }
      return authenticatedFetch(`/api/admin/analytics?${params.toString()}`);
    },
    mcpPresets: (tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets?tenantId=${encodeURIComponent(String(tenantId))}`),
    createMcpPreset: (payload) =>
      authenticatedFetch('/api/admin/mcp-presets', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateMcpPreset: (presetId, payload) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    testMcpPreset: (presetId, tenantId, payload) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/test`, {
        method: 'POST',
        body: JSON.stringify({ ...(payload || {}), tenantId }),
      }),
    uploadMcpPresetHelperScript: (presetId, tenantId, formData) => {
      formData.set('tenantId', String(tenantId));
      return authenticatedFetch(`/api/admin/mcp-presets/${presetId}/helper-script`, {
        method: 'POST',
        body: formData,
      });
    },
    publishMcpPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    disableMcpPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/disable`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    runtimes: (filters = {}) =>
      authenticatedFetch(`/api/admin/runtimes${buildRuntimeQueryString(filters)}`),
    runtimeSummary: (filters = {}) =>
      authenticatedFetch(`/api/admin/runtimes/summary${buildRuntimeQueryString(filters)}`),
    stopRuntime: (runtimeId) =>
      authenticatedFetch(`/api/admin/runtimes/${encodeURIComponent(runtimeId)}/stop`, {
        method: 'POST',
      }),
    analyticsSummary: (rangeDays = 30) =>
      authenticatedFetch(`/api/admin/analytics/summary?rangeDays=${encodeURIComponent(String(rangeDays))}`),
    analyticsUsers: ({ rangeDays = 30, page = 1, pageSize = 20, sortBy = 'sessionCount', search = '' } = {}) => {
      const params = new URLSearchParams({
        rangeDays: String(rangeDays),
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
      });
      if (search) params.set('search', search);
      return authenticatedFetch(`/api/admin/analytics/users?${params.toString()}`);
    },
    createTenant: (payload) =>
      authenticatedFetch('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    createUser: (payload) =>
      authenticatedFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    createUsersBatch: (payload) =>
      authenticatedFetch('/api/admin/users/batch', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateClaudeEnvBatch: (payload) =>
      authenticatedFetch('/api/admin/users/claude-env/batch', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    users: () => authenticatedFetch('/api/admin/users'),
    memberships: () => authenticatedFetch('/api/admin/memberships'),
    createUserActivationLink: (userId) =>
      authenticatedFetch(`/api/admin/users/${userId}/invitation`, {
        method: 'POST',
      }),
    createUserPasswordResetLink: (userId) =>
      authenticatedFetch(`/api/admin/users/${userId}/password-reset`, {
        method: 'POST',
      }),
    deleteUser: (userId) =>
      authenticatedFetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
      }),
    upsertTenantUser: (tenantId, userId, payload) =>
      authenticatedFetch(`/api/admin/tenants/${tenantId}/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    upsertTenantUsersBatch: (payload) =>
      authenticatedFetch('/api/admin/tenant-users/batch', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    deleteTenantUser: (tenantId, userId) =>
      authenticatedFetch(`/api/admin/tenants/${tenantId}/users/${userId}`, {
        method: 'DELETE',
      }),
  },

  workspaceShare: {
    get: (workspaceId) => authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/share`)),
    update: (workspaceId, entries) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/share`), {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      }),
  },

  scheduledTasks: {
    list: (workspaceId) => authenticatedFetch(withTenantAndWorkspaceParam('/api/scheduled-tasks', workspaceId)),
    create: (payload) =>
      authenticatedFetch(withTenantParam('/api/scheduled-tasks'), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (taskId, payload) =>
      authenticatedFetch(withTenantParam(`/api/scheduled-tasks/${encodeURIComponent(String(taskId))}`), {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    remove: (taskId) =>
      authenticatedFetch(withTenantParam(`/api/scheduled-tasks/${encodeURIComponent(String(taskId))}`), {
        method: 'DELETE',
      }),
  },

  workspaceSkills: {
    list: (workspaceId) => authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills`)),
    previewGithub: (workspaceId, url) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/preview`), {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),
    uploadLocal: (workspaceId, formData) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/upload`), {
        method: 'POST',
        body: formData,
      }),
    installPreview: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  skillMarket: {
    list: (workspaceId, { searchContent = '', page = 1, pageSize = 20 } = {}) => {
      const params = new URLSearchParams();
      if (searchContent) params.set('searchContent', searchContent);
      if (page) params.set('page', String(page));
      if (pageSize) params.set('pageSize', String(pageSize));
      const query = params.toString();
      return authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills${query ? `?${query}` : ''}`, workspaceId));
    },
    detail: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}`, workspaceId)),
    file: (workspaceId, name, filePath) =>
      authenticatedFetch(withTenantAndWorkspaceParam(
        `/api/skill-market/skills/${encodeURIComponent(name)}/files?filePath=${encodeURIComponent(filePath)}`,
        workspaceId,
      )),
    importSkill: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/download`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ overwrite: false }),
      }),
    updateImport: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/download`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ overwrite: true }),
      }),
    publishPreview: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish-preview`, workspaceId)),
    publishState: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish-state`, workspaceId)),
    publishSkill: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish`, workspaceId), {
        method: 'POST',
      }),
    uploadAndPublishSkill: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/upload-publish`, workspaceId), {
        method: 'POST',
      }),
    submitSkill: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish`, workspaceId), {
        method: 'POST',
      }),
    remove: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/import`, workspaceId), {
        method: 'DELETE',
      }),
  },

  workspaceTools: {
    list: (workspaceId) => authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/tools`)),
    probeMcp: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/tools/mcp/probe`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    upsertMcp: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/tools/mcp`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    removeMcp: (workspaceId, name) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/tools/mcp/${encodeURIComponent(name)}`), {
        method: 'DELETE',
      }),
    previewMcpImport: (workspaceId, json) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/tools/mcp/import-preview`), {
        method: 'POST',
        body: JSON.stringify({ json }),
      }),
  },

  workspaceMcpTools: {
    list: (workspaceId) => authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/mcp-tools`)),
    install: (workspaceId, presetId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/mcp-tools/${presetId}/install`), {
        method: 'POST',
      }),
    remove: (workspaceId, presetId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/mcp-tools/${presetId}`), {
        method: 'DELETE',
      }),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
