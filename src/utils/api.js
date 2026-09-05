import { IS_PLATFORM, SQL_CHECK_BASE_URL } from "../constants/config";
import { buildRuntimeQueryString } from "../components/admin/runtimeMonitorUtils";
import { AUTH_TOKEN_REFRESHED_EVENT } from "../components/auth/constants";

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
      window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, {
        detail: { token: refreshedToken },
      }));
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

const sqlCheckUrl = (path) => `${SQL_CHECK_BASE_URL}${path}`;

const buildQueryString = (params = {}) => {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === '') return;
    searchParams.set(key, String(value));
  });
  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : '';
};

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
  workspaceHooks: (workspaceId) => authenticatedFetch(withTenantParam(
    `/api/workspaces/${encodeURIComponent(String(workspaceId))}/hooks`,
  )),
  workspaceHookExecutions: (workspaceId, hookId, filters = {}) => authenticatedFetch(withTenantParam(
    `/api/workspaces/${encodeURIComponent(String(workspaceId))}/hooks/${encodeURIComponent(String(hookId))}/executions${buildQueryString(filters)}`,
  )),
  updateWorkspaceHook: (workspaceId, hookId, enabled) => authenticatedFetch(withTenantParam(
    `/api/workspaces/${encodeURIComponent(String(workspaceId))}/hooks/${encodeURIComponent(String(hookId))}`,
  ), {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  }),
  updateWorkspaceHookChatVisibility: (workspaceId, hookId, showInChat) => authenticatedFetch(withTenantParam(
    `/api/workspaces/${encodeURIComponent(String(workspaceId))}/hooks/${encodeURIComponent(String(hookId))}/chat-visibility`,
  ), {
    method: 'PUT',
    body: JSON.stringify({ showInChat }),
  }),
  checkProjectAgentList: (projectName, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${encodeURIComponent(projectName)}/agent-list-check`, workspaceId), {
      method: 'POST',
    }),
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
  projectSettings: (projectName, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${encodeURIComponent(projectName)}/settings`, workspaceId)),
  updateProjectSettings: (projectName, { displayName, claudeMarkdown, expectedRevision, workspaceId }) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${encodeURIComponent(projectName)}/settings`, workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ displayName, claudeMarkdown, expectedRevision }),
    }),
  deleteSession: (projectName, sessionId, provider = 'claude', workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}`, workspaceId), {
      method: 'DELETE',
      body: JSON.stringify({ provider }),
    }),
  renameSession: (sessionId, summary, provider, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/sessions/${sessionId}/rename`, workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  setSessionFavorite: (sessionId, { provider = 'claude', projectName, workspaceId, favorited }) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/sessions/${encodeURIComponent(sessionId)}/favorite`, workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ provider, projectName, favorited }),
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
    const url = withTenantAndWorkspaceParam(`/api/projects/${encodeURIComponent(projectName)}${qs ? `?${qs}` : ''}`, workspaceId);
    return authenticatedFetch(url, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const tenantId = getCurrentTenantId();
    if (token) params.set('token', token);
    if (tenantId) params.set('tenantId', tenantId);
    return `/api/search/conversations?${params.toString()}`;
  },
  createWorkspace: (workspaceData) =>
    authenticatedFetch(withTenantParam('/api/projects/create-workspace'), {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  agentTemplates: () => authenticatedFetch(withTenantParam('/api/agent-templates')),
  readFile: (projectName, filePath, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`, workspaceId)),
  readFileBlob: (projectName, filePath, workspaceId) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/files/content?path=${encodeURIComponent(filePath)}`, workspaceId)),
  saveFile: (projectName, filePath, content, workspaceId) =>
    authenticatedFetch(withTenantParam(`/api/projects/${projectName}/file`), {
      method: 'PUT',
      body: JSON.stringify({ filePath, content, workspaceId }),
    }),
  getFiles: (projectName, options = {}, workspaceId, showInternalConfigFiles = false) =>
    authenticatedFetch(withTenantAndWorkspaceParam(
      `/api/projects/${projectName}/files${showInternalConfigFiles ? '?showInternalConfigFiles=true' : ''}`,
      workspaceId,
    ), options),
  getFileQuota: (projectName, workspaceId, options = {}) =>
    authenticatedFetch(withTenantAndWorkspaceParam(`/api/projects/${projectName}/files/quota`, workspaceId), options),

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
    updateGitConfig: (gitName, gitEmail, gitToken) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({
          gitName,
          gitEmail,
          ...(gitToken ? { gitToken } : {}),
        }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
    claudePersonalEnv: () => authenticatedFetch('/api/settings/claude-env/personal'),
    updateClaudePersonalEnv: (payload) =>
      authenticatedFetch('/api/settings/claude-env/personal', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    claudeEffectiveEnv: (tenantId) => {
      const params = new URLSearchParams();
      if (tenantId != null && tenantId !== '') {
        params.set('tenantId', String(tenantId));
      }
      const query = params.toString();
      return authenticatedFetch(`/api/settings/claude-env/effective${query ? `?${query}` : ''}`);
    },
    claudeEnvDenyRules: () => authenticatedFetch('/api/settings/claude-env/deny-rules'),
    createClaudeEnvDenyRule: (payload) =>
      authenticatedFetch('/api/settings/claude-env/deny-rules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateClaudeEnvDenyRule: (ruleId, payload) =>
      authenticatedFetch(`/api/settings/claude-env/deny-rules/${encodeURIComponent(String(ruleId))}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    deleteClaudeEnvDenyRule: (ruleId) =>
      authenticatedFetch(`/api/settings/claude-env/deny-rules/${encodeURIComponent(String(ruleId))}`, {
        method: 'DELETE',
      }),
  },

  codehub: {
    repositories: (workspaceId) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories`)),
    cloneRepository: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/clone`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    changes: (workspaceId, repoId) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/changes`)),
    diff: (workspaceId, repoId, file) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/diff?file=${encodeURIComponent(file)}`)),
    pullPreview: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/pull-preview`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    stashLocalChanges: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/stash-local-changes`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    restoreStash: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/restore-stash`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    resolveConflictFile: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/resolve-conflict-file`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    clearLocalChanges: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/clear-local-changes`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    pull: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/pull`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    remoteBranches: (workspaceId, repoId, repository = 'personal') => {
      const params = new URLSearchParams({ repository });
      return authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/remote-branches?${params.toString()}`));
    },
    submissionCommits: (workspaceId, repoId, targetBranch, mrTargetRepository = 'personal', sourceBranch = '') => {
      const params = new URLSearchParams();
      if (sourceBranch) params.set('sourceBranch', sourceBranch);
      if (targetBranch) params.set('targetBranch', targetBranch);
      params.set('mrTargetRepository', mrTargetRepository);
      return authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/submission-commits?${params.toString()}`));
    },
    syncFork: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/sync-fork`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    commit: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/commit`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    push: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/push`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    createMergeRequest: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/merge-requests`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    submitMr: (workspaceId, repoId, payload) =>
      authenticatedFetch(withTenantParam(`/api/codehub/workspaces/${encodeURIComponent(String(workspaceId))}/repositories/${encodeURIComponent(String(repoId))}/submit-mr`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    retryMr: (submissionId) =>
      authenticatedFetch(withTenantParam(`/api/codehub/submissions/${encodeURIComponent(String(submissionId))}/retry-mr`), {
        method: 'POST',
      }),
  },

  tenants: {
    mine: () => authenticatedFetch('/api/tenants/me'),
    validate: (tenantId) => authenticatedFetch(`/api/tenants/${tenantId}/validate`),
    checkAgentList: (tenantId) =>
      authenticatedFetch(`/api/tenants/${encodeURIComponent(String(tenantId))}/agent-list-check`, {
        method: 'POST',
      }),
    requestJoin: (tenantId, message) =>
      authenticatedFetch(`/api/tenants/${tenantId}/join-requests`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
  },

  featureFlags: () => authenticatedFetch('/api/settings/feature-flags'),

  admin: {
    tenants: () => authenticatedFetch('/api/admin/tenants'),
    agentTemplates: (tenantId) => authenticatedFetch(
      tenantId
        ? `/api/admin/agent-templates?tenantId=${encodeURIComponent(String(tenantId))}`
        : '/api/admin/agent-templates',
    ),
    agentTemplatePresetCatalog: (tenantId) =>
      authenticatedFetch(`/api/admin/agent-templates/preset-catalog?tenantId=${encodeURIComponent(String(tenantId))}`),
    createAgentTemplate: (payload) =>
      authenticatedFetch('/api/admin/agent-templates', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateAgentTemplate: (templateId, payload) =>
      authenticatedFetch(`/api/admin/agent-templates/${encodeURIComponent(String(templateId))}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    publishAgentTemplate: (templateId) =>
      authenticatedFetch(`/api/admin/agent-templates/${encodeURIComponent(String(templateId))}/publish`, {
        method: 'POST',
      }),
    disableAgentTemplate: (templateId) =>
      authenticatedFetch(`/api/admin/agent-templates/${encodeURIComponent(String(templateId))}/disable`, {
        method: 'POST',
      }),
    deleteAgentTemplate: (templateId) =>
      authenticatedFetch(`/api/admin/agent-templates/${encodeURIComponent(String(templateId))}`, {
        method: 'DELETE',
      }),
    agentTemplateCategories: () => authenticatedFetch('/api/admin/agent-template-categories'),
    createAgentTemplateCategory: (name) => authenticatedFetch('/api/admin/agent-template-categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
    deleteAgentTemplateCategory: (categoryId) => authenticatedFetch(
      `/api/admin/agent-template-categories/${encodeURIComponent(String(categoryId))}`,
      { method: 'DELETE' },
    ),
    hooks: () => authenticatedFetch('/api/admin/hooks'),
    hook: (hookId) => authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}`),
    createHook: (payload) =>
      authenticatedFetch('/api/admin/hooks', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    hookExamples: () => authenticatedFetch('/api/admin/hooks/examples'),
    createHookExamples: (exampleIds) =>
      authenticatedFetch('/api/admin/hooks/examples', {
        method: 'POST',
        body: JSON.stringify({ exampleIds }),
      }),
    updateHook: (hookId, payload) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    publishHook: (hookId) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}/publish`, {
        method: 'POST',
      }),
    hookBindings: (hookId) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}/bindings`),
    updateHookBindings: (hookId, payload) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}/bindings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    deleteHook: (hookId) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}`, {
        method: 'DELETE',
      }),
    hookDataRecords: (hookId, limit = 50) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}/data-records?limit=${encodeURIComponent(String(limit))}`),
    hookExecutions: (hookId, filters = {}) =>
      authenticatedFetch(`/api/admin/hooks/${encodeURIComponent(String(hookId))}/executions${buildQueryString(filters)}`),
    allHookExecutions: (filters = {}) =>
      authenticatedFetch(`/api/admin/hook-executions${buildQueryString(filters)}`),
    hookExecution: (executionId) =>
      authenticatedFetch(`/api/admin/hook-executions/${encodeURIComponent(String(executionId))}`),
    hookSettings: () => authenticatedFetch('/api/admin/hooks/settings'),
    updateHookSettings: (payload) =>
      authenticatedFetch('/api/admin/hooks/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    hookResources: () => authenticatedFetch('/api/admin/hooks/resources'),
    createHookMcpServer: (payload) =>
      authenticatedFetch('/api/admin/hooks/mcp-servers', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateHookMcpServer: (serverName, payload) =>
      authenticatedFetch(`/api/admin/hooks/mcp-servers/${encodeURIComponent(String(serverName))}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    testHookMcpServer: (serverName) =>
      authenticatedFetch(withTenantParam(`/api/admin/hooks/mcp-servers/${encodeURIComponent(String(serverName))}/test`), {
        method: 'POST',
      }),
    uploadHookMcpHelperScript: (serverName, formData) =>
      authenticatedFetch(`/api/admin/hooks/mcp-servers/${encodeURIComponent(String(serverName))}/helper-script`, {
        method: 'POST',
        body: formData,
      }),
    deleteHookMcpHelperScript: (serverName) =>
      authenticatedFetch(`/api/admin/hooks/mcp-servers/${encodeURIComponent(String(serverName))}/helper-script`, {
        method: 'DELETE',
      }),
    deleteHookMcpServer: (serverName) =>
      authenticatedFetch(`/api/admin/hooks/mcp-servers/${encodeURIComponent(String(serverName))}`, {
        method: 'DELETE',
      }),
    uploadHookSkill: (formData) =>
      authenticatedFetch('/api/admin/hooks/skills', {
        method: 'POST',
        body: formData,
      }),
    deleteHookSkill: (skillId) =>
      authenticatedFetch(`/api/admin/hooks/skills/${encodeURIComponent(String(skillId))}`, {
        method: 'DELETE',
      }),
    analytics: (days = 30, tenantIds = []) => {
      const params = new URLSearchParams({ days: String(days) });
      if (Array.isArray(tenantIds) && tenantIds.length > 0) {
        params.set('tenantIds', tenantIds.map(String).join(','));
      }
      return authenticatedFetch(`/api/admin/analytics?${params.toString()}`);
    },
    aiCodeStats: (filters = {}) =>
      authenticatedFetch(`/api/admin/ai-code-stats${buildQueryString(filters)}`),
    aiCodeMrs: (filters = {}) =>
      authenticatedFetch(`/api/admin/ai-code-mrs${buildQueryString(filters)}`),
    mcpPresets: (tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets?tenantId=${encodeURIComponent(String(tenantId))}`),
    skillPresets: (tenantId) =>
      authenticatedFetch(`/api/admin/skill-presets?tenantId=${encodeURIComponent(String(tenantId))}`),
    searchSkillPresetMarket: (tenantId, {
      searchContent = '', page = 1, pageSize = 20, complete = false,
    } = {}) => {
      const params = new URLSearchParams({
        tenantId: String(tenantId),
        page: String(page),
        pageSize: String(pageSize),
      });
      if (searchContent) params.set('searchContent', searchContent);
      if (complete) params.set('complete', 'true');
      return authenticatedFetch(`/api/admin/skill-presets/market?${params.toString()}`);
    },
    createSkillPreset: (payload) =>
      authenticatedFetch('/api/admin/skill-presets', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateSkillPreset: (presetId, payload) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    validateSkillPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}/validate`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    publishSkillPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    applySkillPreset: (presetId, payload) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}/apply`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    disableSkillPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}/disable`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    deleteSkillPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/skill-presets/${presetId}?tenantId=${encodeURIComponent(String(tenantId))}`, {
        method: 'DELETE',
      }),
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
    deleteMcpPresetHelperScript: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/helper-script?tenantId=${encodeURIComponent(String(tenantId))}`, {
        method: 'DELETE',
      }),
    publishMcpPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    copyMcpPreset: (presetId, payload) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/copy`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    disableMcpPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}/disable`, {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      }),
    deleteMcpPreset: (presetId, tenantId) =>
      authenticatedFetch(`/api/admin/mcp-presets/${presetId}?tenantId=${encodeURIComponent(String(tenantId))}`, {
        method: 'DELETE',
      }),
    runtimes: (filters = {}) =>
      authenticatedFetch(`/api/admin/runtimes${buildRuntimeQueryString(filters)}`),
    scheduledTaskLogs: (filters = {}) =>
      authenticatedFetch(`/api/admin/scheduled-task-logs${buildQueryString(filters)}`),
    runtimeSummary: (filters = {}) =>
      authenticatedFetch(`/api/admin/runtimes/summary${buildRuntimeQueryString(filters)}`),
    stopRuntime: (runtimeId) =>
      authenticatedFetch(`/api/admin/runtimes/${encodeURIComponent(runtimeId)}/stop`, {
        method: 'POST',
      }),
    analyticsSummary: (rangeDays = 30) =>
      authenticatedFetch(`/api/admin/analytics/summary?rangeDays=${encodeURIComponent(String(rangeDays))}`),
    analyticsUsers: ({ page = 1, pageSize = 20, search = '' } = {}) => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search) params.set('search', search);
      return authenticatedFetch(`/api/admin/analytics/users?${params.toString()}`);
    },
    mcpToolUsage: ({ rangeDays = 30, provider = '' } = {}) => {
      const params = new URLSearchParams({ rangeDays: String(rangeDays) });
      if (provider) params.set('provider', provider);
      return authenticatedFetch(`/api/admin/mcp/tool-usage?${params.toString()}`);
    },
    createTenant: (payload) =>
      authenticatedFetch('/api/admin/tenants', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateTenant: (tenantId, payload) =>
      authenticatedFetch(`/api/admin/tenants/${encodeURIComponent(String(tenantId))}`, {
        method: 'PUT',
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
    claudeEnvUsers: () => authenticatedFetch('/api/admin/users/claude-env'),
    tenantClaudeEnv: (tenantId) =>
      authenticatedFetch(`/api/admin/tenants/${encodeURIComponent(String(tenantId))}/claude-env`),
    updateTenantClaudeEnv: (tenantId, payload) =>
      authenticatedFetch(`/api/admin/tenants/${encodeURIComponent(String(tenantId))}/claude-env`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    tenantClaudeEnvOverview: () => authenticatedFetch('/api/admin/tenants/claude-env'),
    updateTenantClaudeEnvBatch: (payload) =>
      authenticatedFetch('/api/admin/tenants/claude-env', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    claudeEnvAllowlist: () => authenticatedFetch('/api/admin/claude-env/personal-allowlist'),
    updateClaudeEnvAllowlist: (payload) =>
      authenticatedFetch('/api/admin/claude-env/personal-allowlist', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    claudeEnvDenyRules: () => authenticatedFetch('/api/admin/claude-env/deny-rules'),
    createClaudeEnvDenyRule: (payload) =>
      authenticatedFetch('/api/admin/claude-env/deny-rules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    updateClaudeEnvDenyRule: (ruleId, payload) =>
      authenticatedFetch(`/api/admin/claude-env/deny-rules/${encodeURIComponent(String(ruleId))}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    deleteClaudeEnvDenyRule: (ruleId) =>
      authenticatedFetch(`/api/admin/claude-env/deny-rules/${encodeURIComponent(String(ruleId))}`, {
        method: 'DELETE',
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
    sqlCheckTenantConfig: (tenantId, options = {}) =>
      authenticatedFetch(`/api/admin/tenants/${encodeURIComponent(String(tenantId))}/sql-check`, options),
    updateSqlCheckTenantConfig: (tenantId, ruleIds) =>
      authenticatedFetch(`/api/admin/tenants/${encodeURIComponent(String(tenantId))}/sql-check`, {
        method: 'PUT',
        body: JSON.stringify({ ruleIds }),
      }),
  },

  sqlCheck: {
    rules: (options = {}) => fetch(sqlCheckUrl('/sql-check/rules'), options),
    workspaceConfig: (workspaceId, options = {}) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/sql-check`), options),
    updateWorkspaceConfig: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/sql-check`), {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    updateEnforcement: (workspaceId, enabled) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${encodeURIComponent(String(workspaceId))}/sql-check/enforcement`), {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
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
    detail: (workspaceId, name) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}`)),
    file: (workspaceId, name, filePath) =>
      authenticatedFetch(withTenantParam(
        `/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/files?filePath=${encodeURIComponent(filePath)}`,
      )),
    saveFile: (workspaceId, name, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/files`), {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    createEntry: (workspaceId, name, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/entries`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    renameEntry: (workspaceId, name, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/entries`), {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    renameDirectory: (workspaceId, name, nextName) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/directory`), {
        method: 'PATCH',
        body: JSON.stringify({ nextName }),
      }),
    deleteEntry: (workspaceId, name, path) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/entries`), {
        method: 'DELETE',
        body: JSON.stringify({ path }),
      }),
    deleteLocal: (workspaceId, name) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/skills/${encodeURIComponent(name)}/local`), {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'yes' }),
      }),
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
    updateImport: (workspaceId, name, { forceLocalChanges = false } = {}) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/download`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ overwrite: true, forceLocalChanges }),
      }),
    publishPreview: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish-preview`, workspaceId)),
    publishState: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish-state`, workspaceId)),
    publishSkill: (workspaceId, name, localContentHash) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ localContentHash }),
      }),
    uploadAndPublishSkill: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/upload-publish`, workspaceId), {
        method: 'POST',
      }),
    unpublishSkill: (workspaceId, name, remoteSkillId) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/unpublish`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'yes', remoteSkillId }),
      }),
    submitSkill: (workspaceId, name, localContentHash) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/publish`, workspaceId), {
        method: 'POST',
        body: JSON.stringify({ localContentHash }),
      }),
    remove: (workspaceId, name) =>
      authenticatedFetch(withTenantAndWorkspaceParam(`/api/skill-market/skills/${encodeURIComponent(name)}/import`, workspaceId), {
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'yes' }),
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
    updateToolPreference: (workspaceId, presetId, allowedToolNames) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/mcp-tools/${presetId}/tool-preference`), {
        method: 'PUT',
        body: JSON.stringify({ allowedToolNames }),
      }),
  },

  agentGraphs: {
    list: (workspaceId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs`)),
    create: (workspaceId, graph) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs`), {
        method: 'POST',
        body: JSON.stringify(graph),
      }),
    update: (workspaceId, graphId, graph) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}`), {
        method: 'PUT',
        body: JSON.stringify(graph),
      }),
    remove: (workspaceId, graphId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}`), {
        method: 'DELETE',
      }),
    startTopSkillJob: (workspaceId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/top-skill-jobs`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    getTopSkillJob: (workspaceId, jobId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/top-skill-jobs/${encodeURIComponent(jobId)}`)),
    startRun: (workspaceId, graphId, payload) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs`), {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    listRuns: (workspaceId, graphId, limit = 20) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs?limit=${encodeURIComponent(String(limit))}`)),
    getRun: (workspaceId, graphId, runId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs/${encodeURIComponent(runId)}`)),
    listRunArtifacts: (workspaceId, graphId, runId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs/${encodeURIComponent(runId)}/artifacts`)),
    readRunArtifact: (workspaceId, graphId, runId, artifactId, offset = 0, limit = 16000) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}?offset=${encodeURIComponent(String(offset))}&limit=${encodeURIComponent(String(limit))}`)),
    cancelRun: (workspaceId, graphId, runId) =>
      authenticatedFetch(withTenantParam(`/api/workspaces/${workspaceId}/agent-graphs/${encodeURIComponent(graphId)}/runs/${encodeURIComponent(runId)}/cancel`), {
        method: 'POST',
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
