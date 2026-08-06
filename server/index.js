#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs, {promises as fsPromises} from 'fs';
import path from 'path';
import {findAppRoot, getModuleDir} from './utils/runtime-paths.js';

import {AppError, createNormalizedMessage} from '@/shared/utils.js';
import {c} from './utils/colors.js';
import express from 'express';
import {WebSocket, WebSocketServer} from 'ws';
import os from 'os';
import http from 'http';
import cors from 'cors';
import {spawn} from 'child_process';
import pty from 'node-pty';
import mime from 'mime-types';

import {
    clearProjectDirectoryCache,
    createConversationSearchHelpers,
    deleteProject,
    deleteSession,
    deleteSessionFromProjectsRoot,
    extractProjectDirectory,
    getProjects,
    getSessions,
    renameProject,
    searchConversations,
    validateClaudeProjectName,
    validateClaudeSessionId
} from './projects.js';
import {
    abortClaudeSDKSession,
    getActiveClaudeSDKSessions,
    getPendingApprovalsForSession,
    isClaudeSDKSessionActive,
    pushClaudeSupplement,
    queryClaudeSDK,
    reconnectSessionWriter,
    resolveToolApproval
} from './claude-sdk.js';
import {abortCursorSession, getActiveCursorSessions, isCursorSessionActive, spawnCursor} from './cursor-cli.js';
import {abortCodexSession, getActiveCodexSessions, isCodexSessionActive, queryCodex} from './openai-codex.js';
import {abortGeminiSession, getActiveGeminiSessions, isGeminiSessionActive, spawnGemini} from './gemini-cli.js';
import sessionManager from './sessionManager.js';
import gitRoutes from './routes/git.js';
import codehubRoutes from './routes/codehub.js';
import authRoutes from './routes/auth.js';
import tenantsRoutes from './routes/tenants.js';
import adminRoutes from './routes/admin.js';
import workspacesRoutes from './routes/workspaces.js';
import skillMarketRoutes from './routes/skill-market.js';
import workspaceSkillsRoutes from './routes/workspace-skills.js';
import workspaceMcpToolsRoutes from './routes/workspace-mcp-tools.js';
import workspaceToolsRoutes from './routes/workspace-tools.js';
import cursorRoutes from './routes/cursor.js';
import taskmasterRoutes from './routes/taskmaster.js';
import mcpUtilsRoutes from './routes/mcp-utils.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectsRoutes, {validateWorkspacePath, WORKSPACES_ROOT} from './routes/projects.js';
import userRoutes from './routes/user.js';
import codexRoutes from './routes/codex.js';
import geminiRoutes from './routes/gemini.js';
import pluginsRoutes from './routes/plugins.js';
import messagesRoutes from './routes/messages.js';
import scheduledTasksRoutes from './routes/scheduled-tasks.js';
import providerRoutes from './modules/providers/provider.routes.js';
import {sessionsService} from './modules/providers/services/sessions.service.js';
import {getPluginPort, startEnabledPluginServers, stopAllPlugins} from './utils/plugin-process-manager.js';
import {applyCustomSessionNames, applyScheduledSessionTaskFlags, initializeDatabase, sessionNamesDb, userDb} from './database/db.js';
import {multitenancyDb} from './database/multitenancy-db.js';
import {configureWebPush} from './services/vapid-keys.js';
import {deleteClaudeDisplayCommands} from './modules/providers/list/claude/claude-display-command-store.js';
import {authenticateToken, authenticateWebSocket, validateApiKey} from './middleware/auth.js';
import {noApiCache} from './middleware/no-api-cache.js';
import {resolveTenantIdFromRequest, resolveWebSocketTenant, tenantContext} from './middleware/tenant-context.js';
import {canAccessHostFilesystem} from './services/host-filesystem-access.js';
import {runtimeSweeper} from './services/runtime-sweeper.js';
import {agentSessionRuntimeManager} from './services/agent-session-runtime.js';
import {createScheduledSessionTaskService} from './services/scheduled-session-tasks.js';
import {codeHubMrPoller} from './services/codehub-mr-poller.js';
import {mapWorkspaceRowsToProjects} from './services/workspace-projects.js';
import {workspaceAccess} from './services/workspace-access.js';
import {handleWorkspaceError, resolveWorkspaceForRequest} from './services/workspace-request.js';
import {moveWorkspaceItem} from './services/workspace-file-operations.js';
import {applyWorkspaceOwnership} from './services/workspace-ownership.js';
import {
    assertWorkspaceUploadFitsQuota,
    getWorkspaceStorageQuota
} from './services/workspace-storage-quota.js';
import {
    createSessionLimitExceededMessage,
    isSessionLimitExceededError,
    sessionConcurrencyLimiter
} from './services/session-concurrency-limit.js';
import {IS_PLATFORM} from './constants/config.js';
import {getConnectableHost} from '../shared/networkHosts.js';
import {
    extractUrlsFromText,
    normalizeDetectedUrl,
    shouldAutoOpenUrlFromOutput,
    stripAnsiSequences
} from './utils/url-detection.js';


const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

const VALID_PROVIDERS = ['claude', 'codex', 'cursor', 'gemini'];

function normalizeOpaqueSessionId(sessionId) {
    const normalized = String(sessionId ?? '').trim();
    if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
        return null;
    }
    return normalized;
}

// File system watchers for provider project/session folders
const PROVIDER_WATCH_PATHS = [
    { provider: 'claude', rootPath: path.join(os.homedir(), '.claude', 'projects') },
    { provider: 'cursor', rootPath: path.join(os.homedir(), '.cursor', 'chats') },
    { provider: 'codex', rootPath: path.join(os.homedir(), '.codex', 'sessions') },
    { provider: 'gemini', rootPath: path.join(os.homedir(), '.gemini', 'projects') },
    { provider: 'gemini_sessions', rootPath: path.join(os.homedir(), '.gemini', 'sessions') }
];
const WATCHER_IGNORED_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/*.tmp',
    '**/*.swp',
    '**/.DS_Store'
];
const WATCHER_DEBOUNCE_MS = 300;
let projectsWatchers = [];
let projectsWatcherDebounceTimer = null;
const connectedClients = new Set();
let isGetProjectsRunning = false; // Flag to prevent reentrant calls

const CLOUDCLI_RUNTIME_ROOT_SEGMENT = 'claude';
const CLOUDCLI_HOME_PREFIX = '/home/cloudcli/.claude/projects';

function normalizeRuntimeRoot(inputPath) {
  const fallback = path.join(os.homedir(), '.cloudcli', 'runtimes');
  const rawPath = String(process.env.CLOUDCLI_RUNTIME_ROOT || inputPath || fallback || '').trim();
  const trimmed = rawPath.replace(/^(["']).*\1$/g, (match) => match.slice(1, -1));

  if (!trimmed) {
    return fallback;
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;

}

function normalizeStringSegment(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.replace(/[\\\/]+/g, '-').replace(/^\s+|\s+$/g, '');
}

function resolveRuntimeMountedFilePath({ targetPath, tenantCode, userName, workspace }) {
  const resolvedUserName = normalizeStringSegment(userName);
  const workspaceName = workspace?.slug || workspace?.name || path.basename(workspace?.path || '');
  if (!workspaceName) {
    return null;
  }

  if (!targetPath || typeof targetPath !== 'string') {
    return null;
  }

  const normalizedTargetPath = targetPath.replace(/\\/g, '/');
  if (!normalizedTargetPath.startsWith(CLOUDCLI_HOME_PREFIX)) {
    return null;
  }

  const resolvedTenantCode = normalizeStringSegment(tenantCode);
  if (!resolvedUserName || resolvedUserName.length === 0) {
    return null;
  }
  if (!resolvedTenantCode) {
    return null;
  }

  const runtimeRoot = normalizeRuntimeRoot();
  const runtimeProjectsRoot = path.resolve(
    runtimeRoot,
    CLOUDCLI_RUNTIME_ROOT_SEGMENT,
    resolvedTenantCode,
    resolvedUserName,
    workspaceName,
    'home',
    '.claude',
    'projects',
  );
  const normalizedSuffix = normalizedTargetPath
    .slice(CLOUDCLI_HOME_PREFIX.length)
    .replace(/^\/+/, '');
  const resolvedPath = path.resolve(runtimeProjectsRoot, normalizedSuffix);

  const runtimeProjectsRootWithSep = `${runtimeProjectsRoot}${path.sep}`;
  if (resolvedPath !== runtimeProjectsRoot && !resolvedPath.startsWith(runtimeProjectsRootWithSep)) {
    return null;
  }

  return resolvedPath;
}

function resolveTenantCode(req) {
  const tenantId = req.tenant?.id ?? resolveTenantIdFromRequest(req);
  if (!tenantId) {
    return null;
  }
  const tenant = multitenancyDb.tenants.getTenantById(tenantId);
    return tenant?.code || tenant?.slug || null;
}

function resolveEditableWorkspace(req, { projectName, requireEdit = true } = {}) {
  const tenantId = req.tenant?.id ?? resolveTenantIdFromRequest(req);
  if (!tenantId) return null;
  const userId = req.user?.id ?? req.user?.userId;
  const targetName = projectName || req.params?.projectName;
  if (!targetName) return null;
  const normalizedTenantId = Number.parseInt(String(tenantId), 10);
  if (!Number.isInteger(normalizedTenantId) || normalizedTenantId <= 0) return null;

  const workspaceId = Number.parseInt(req.query.workspaceId, 10);
  if (workspaceId > 0) {
    return workspaceAccess.requireWorkspace({
      tenantId: normalizedTenantId,
      userId,
      workspaceId,
      requireEdit,
    });
  }

  const workspace = multitenancyDb.workspaces.getWorkspaceByTenantSlugForUser({
    tenantId: normalizedTenantId,
    userId,
    slug: targetName,
  });
  if (!workspace) return null;
  if (requireEdit && workspace.accessRole !== 'owner' && workspace.accessRole !== 'edit') {
    const error = new Error('Workspace edit access denied');
    error.statusCode = 403;
    throw error;
  }

  return {
    workspace,
    accessRole: workspace.accessRole,
  };
}

function parsePositiveRequestInteger(value) {
    if (Array.isArray(value)) {
        return parsePositiveRequestInteger(value[0]);
    }
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveWorkspaceDeleteContext(req, { projectName } = {}) {
    if (req.tenant) {
        return resolveEditableWorkspace(req, { projectName });
    }

    const workspaceId = parsePositiveRequestInteger(req.query?.workspaceId);
    const userId = req.user?.id ?? req.user?.userId;
    if (!workspaceId || !userId) {
        return null;
    }

    const workspace = multitenancyDb.workspaces.getWorkspaceById(workspaceId);
    if (!workspace || !['active', 'deleted'].includes(workspace.status)) {
        return null;
    }
    if (projectName && workspace.slug !== projectName) {
        return null;
    }
    if (workspace.status === 'deleted') {
        if (Number(workspace.owner_user_id) === Number(userId)) {
            return { workspace, accessRole: 'owner' };
        }
        const acl = multitenancyDb.workspaceAcl.getAclEntry(workspaceId, userId);
        if (acl?.permission === 'edit') {
            return { workspace, accessRole: 'edit' };
        }
        return null;
    }

    return workspaceAccess.requireWorkspace({
        tenantId: workspace.tenant_id,
        userId,
        workspaceId,
        requireEdit: true,
    });
}

async function resolveWorkspaceDeleteTarget(workspacePath) {
    const resolvedRoot = await fsPromises.realpath(WORKSPACES_ROOT);
    const resolvedTarget = path.resolve(workspacePath);
    let realTarget = resolvedTarget;

    try {
        realTarget = await fsPromises.realpath(resolvedTarget);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    const relativePath = path.relative(resolvedRoot, realTarget);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        const error = new Error('Workspace delete path must stay within WORKSPACES_ROOT');
        error.statusCode = 400;
        throw error;
    }

    return resolvedTarget;
}

async function pruneEmptyWorkspaceParents(startPath) {
    const resolvedRoot = await fsPromises.realpath(WORKSPACES_ROOT);
    let current = path.dirname(path.resolve(startPath));

    while (current && current !== resolvedRoot) {
        const relativePath = path.relative(resolvedRoot, current);
        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
            return;
        }

        try {
            await fsPromises.rmdir(current);
        } catch {
            return;
        }
        current = path.dirname(current);
    }
}

async function deleteWorkspaceFilesystem(workspace) {
    const deleteTarget = await resolveWorkspaceDeleteTarget(workspace.path);
    await fsPromises.rm(deleteTarget, { recursive: true, force: true });
    await pruneEmptyWorkspaceParents(deleteTarget);
    clearProjectDirectoryCache();
    return deleteTarget;
}

function attachTenantContextIfNeeded(req, res, next) {
  const tenantId = resolveTenantIdFromRequest(req);
  if (!tenantId) {
    if (IS_PLATFORM) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    return next();
  }
  return tenantContext(req, res, next);
}

// Broadcast progress to all connected WebSocket clients
function broadcastProgress(progress) {
    const message = JSON.stringify({
        type: 'loading_progress',
        ...progress
    });
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastFilesChanged({ projectName, workspaceId, changedPath, reason }) {
    const message = JSON.stringify({
        type: 'files_changed',
        projectName,
        workspaceId,
        changedPath,
        reason,
        timestamp: new Date().toISOString(),
    });

    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Setup file system watchers for Claude, Cursor, and Codex project/session folders
async function setupProjectsWatcher() {
    const chokidar = (await import('chokidar')).default;

    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    await Promise.all(
        projectsWatchers.map(async (watcher) => {
            try {
                await watcher.close();
            } catch (error) {
                console.error('[WARN] Failed to close watcher:', error);
            }
        })
    );
    projectsWatchers = [];

    const debouncedUpdate = (eventType, filePath, provider, rootPath) => {
        if (projectsWatcherDebounceTimer) {
            clearTimeout(projectsWatcherDebounceTimer);
        }

        projectsWatcherDebounceTimer = setTimeout(async () => {
            // Prevent reentrant calls
            if (isGetProjectsRunning) {
                return;
            }

            try {
                isGetProjectsRunning = true;

                // Clear project directory cache when files change
                clearProjectDirectoryCache();

                // Get updated projects list
                const updatedProjects = await getProjects(broadcastProgress);

                // Notify all connected clients about the project changes
                const updateMessage = JSON.stringify({
                    type: 'projects_updated',
                    projects: updatedProjects,
                    timestamp: new Date().toISOString(),
                    changeType: eventType,
                    changedFile: path.relative(rootPath, filePath),
                    watchProvider: provider
                });

                connectedClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(updateMessage);
                    }
                });

            } catch (error) {
                console.error('[ERROR] Error handling project changes:', error);
            } finally {
                isGetProjectsRunning = false;
            }
        }, WATCHER_DEBOUNCE_MS);
    };

    for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
        try {
            // chokidar v4 emits ENOENT via the "error" event for missing roots and will not auto-recover.
            // Ensure provider folders exist before creating the watcher so watching stays active.
            await fsPromises.mkdir(rootPath, { recursive: true });

            // Initialize chokidar watcher with optimized settings
            const watcher = chokidar.watch(rootPath, {
                ignored: WATCHER_IGNORED_PATTERNS,
                persistent: true,
                ignoreInitial: true, // Don't fire events for existing files on startup
                followSymlinks: false,
                depth: 10, // Reasonable depth limit
                awaitWriteFinish: {
                    stabilityThreshold: 100, // Wait 100ms for file to stabilize
                    pollInterval: 50
                }
            });

            // Set up event listeners
            watcher
                .on('add', (filePath) => debouncedUpdate('add', filePath, provider, rootPath))
                .on('change', (filePath) => debouncedUpdate('change', filePath, provider, rootPath))
                .on('unlink', (filePath) => debouncedUpdate('unlink', filePath, provider, rootPath))
                .on('addDir', (dirPath) => debouncedUpdate('addDir', dirPath, provider, rootPath))
                .on('unlinkDir', (dirPath) => debouncedUpdate('unlinkDir', dirPath, provider, rootPath))
                .on('error', (error) => {
                    console.error(`[ERROR] ${provider} watcher error:`, error);
                })
                .on('ready', () => {
                });

            projectsWatchers.push(watcher);
        } catch (error) {
            console.error(`[ERROR] Failed to setup ${provider} watcher for ${rootPath}:`, error);
        }
    }

    if (projectsWatchers.length === 0) {
        console.error('[ERROR] Failed to setup any provider watchers');
    }
}


const app = express();
const server = http.createServer(app);

const ptySessionsMap = new Map();
const activeProviderCommands = new Map();
let activeProviderCommandCounter = 0;
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 10) || 30 * 60 * 1000;
const GRACEFUL_SHUTDOWN_POLL_MS = parseInt(process.env.GRACEFUL_SHUTDOWN_POLL_MS, 10) || 1000;
let isShuttingDown = false;

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
    server,
    verifyClient: (info) => {
        if (isShuttingDown) {
            console.log('[WARN] Rejecting WebSocket connection while server is draining');
            return false;
        }

        console.log('WebSocket connection attempt to:', info.req.url);

        // Platform mode: always allow connection
        if (IS_PLATFORM) {
            const user = authenticateWebSocket(null); // Will return first user
            if (!user) {
                console.log('[WARN] Platform mode: No user found in database');
                return false;
            }
            info.req.user = user;
            const tenant = resolveWebSocketTenant({ request: info.req, user });
            if (!tenant) {
                console.log('[WARN] Platform mode WebSocket tenant authentication failed');
                return false;
            }
            info.req.tenant = tenant;
            console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
            return true;
        }

        // Normal mode: verify token
        // Extract token from query parameters or headers
        const url = new URL(info.req.url, 'http://localhost');
        const token = url.searchParams.get('token') ||
            info.req.headers.authorization?.split(' ')[1];

        // Verify token
        const user = authenticateWebSocket(token);
        if (!user) {
            console.log('[WARN] WebSocket authentication failed');
            return false;
        }

        // Store user info in the request for later use
        info.req.user = user;
        const tenant = resolveWebSocketTenant({ request: info.req, user });
        if (!tenant) {
            console.log('[WARN] WebSocket tenant authentication failed');
            return false;
        }
        info.req.tenant = tenant;
        console.log('[OK] WebSocket authenticated for user:', user.username);
        return true;
    }
});

// Make WebSocket server available to routes
app.locals.wss = wss;
app.locals.chatClients = connectedClients;
const scheduledSessionTasks = createScheduledSessionTaskService({clients: connectedClients});
app.locals.scheduledSessionTasks = scheduledSessionTasks;

app.use(cors({ exposedHeaders: ['X-Refreshed-Token'] }));
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Public health check endpoint (no authentication required)
app.get('/health', (req, res) => {
    if (isShuttingDown) {
        res.status(503).json({
            status: 'draining',
            timestamp: new Date().toISOString(),
            installMode
        });
        return;
    }

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        installMode
    });
});

app.get('/health/active-work', (req, res) => {
    const summary = getActiveWorkSummary();
    const active = getActiveWorkCount(summary);

    res.json({
        active,
        hasActiveWork: active > 0,
        isShuttingDown,
        summary,
        timestamp: new Date().toISOString()
    });
});

// Dynamic API responses must always reflect current state.
app.use('/api', noApiCache, validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Multitenancy routes (protected)
app.use('/api/tenants', authenticateToken, tenantsRoutes);
app.use('/api/admin', authenticateToken, adminRoutes);
app.use('/api/skill-market', authenticateToken, skillMarketRoutes);
app.use('/api/workspaces', authenticateToken, workspacesRoutes);
app.use('/api/workspaces', authenticateToken, workspaceSkillsRoutes);
app.use('/api/workspaces', authenticateToken, workspaceMcpToolsRoutes);
app.use('/api/workspaces', authenticateToken, workspaceToolsRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// CodeHub API Routes (protected)
app.use('/api/codehub', authenticateToken, codehubRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// TaskMaster API Routes (protected)
app.use('/api/taskmaster', authenticateToken, taskmasterRoutes);

// MCP utilities
app.use('/api/mcp-utils', authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Codex API Routes (protected)
if (IS_PLATFORM) {
    app.use('/api/codex', authenticateToken, tenantContext, codexRoutes);
} else {
    app.use('/api/codex', authenticateToken, codexRoutes);
}

// Gemini API Routes (protected)
if (IS_PLATFORM) {
    app.use('/api/gemini', authenticateToken, tenantContext, geminiRoutes);
} else {
    app.use('/api/gemini', authenticateToken, geminiRoutes);
}

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// Unified session messages route (protected)
app.use('/api/sessions', authenticateToken, messagesRoutes);

// Scheduled session task route (protected)
app.use('/api/scheduled-tasks', authenticateToken, scheduledTasksRoutes);

// Unified provider MCP routes (protected)
app.use('/api/providers', authenticateToken, providerRoutes);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint
app.post('/api/system/update', authenticateToken, async (req, res) => {
    try {
        // Get the project root directory (parent of server directory)
        const projectRoot = APP_ROOT;

        console.log('Starting system update from directory:', projectRoot);

        // Platform deployments use their own update workflow from the project root.
        const updateCommand = IS_PLATFORM
        // In platform, husky and dev dependencies are not needed
            ? 'npm run update:platform'
            : installMode === 'git'
                ? 'git checkout main && git pull && npm install'
                : 'npm install -g @cloudcli-ai/cloudcli@latest';

        const updateCwd = IS_PLATFORM || installMode === 'git'
            ? projectRoot
            : os.homedir();

        const child = spawn('sh', ['-c', updateCommand], {
            cwd: updateCwd,
            env: process.env
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            console.log('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            console.error('Update error:', text);
        });

        child.on('close', (code) => {
            if (code === 0) {
                res.json({
                    success: true,
                    output: output || 'Update completed successfully',
                    message: 'Update completed. Please restart the server to apply changes.'
                });
            } else {
                res.status(500).json({
                    success: false,
                    error: 'Update command failed',
                    output: output,
                    errorOutput: errorOutput
                });
            }
        });

        child.on('error', (error) => {
            console.error('Update process error:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        });

    } catch (error) {
        console.error('System update error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/projects', authenticateToken, tenantContext, async (req, res) => {
    try {
        const rows = multitenancyDb.workspaces.listVisibleWorkspaces({
            tenantId: req.tenant.id,
            userId: req.user.id,
        });
        const projects = mapWorkspaceRowsToProjects(rows, {
            tenantId: req.tenant.id,
            userId: req.user.id,
            listSessions: multitenancyDb.sessions.listSessions,
        });
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectName/sessions', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        if (req.tenant) {
            const { limit = 5, offset = 0 } = req.query;
            const normalizedLimit = parseInt(String(limit), 10);
            const normalizedOffset = parseInt(String(offset), 10);
            const pageLimit = Number.isInteger(normalizedLimit) && normalizedLimit > 0 ? normalizedLimit : 5;
            const pageOffset = Number.isInteger(normalizedOffset) && normalizedOffset >= 0 ? normalizedOffset : 0;

            const resolvedWorkspace = resolveEditableWorkspace(req, { projectName: req.params.projectName, requireEdit: false });
            if (!resolvedWorkspace?.workspace) {
                return res.status(404).json({ error: 'Project not found' });
            }

            const { workspace } = resolvedWorkspace;
            const rows = multitenancyDb.sessions.listSessions({
                tenantId: req.tenant.id,
                userId: req.user?.id ?? req.user?.userId,
                workspaceId: workspace.id,
                provider: 'claude',
            });
            const total = rows.length;
            const sessions = rows
                .slice(pageOffset, pageOffset + pageLimit)
                .map((session) => ({
                    id: session.provider_session_id,
                    summary: session.summary || 'New Session',
                    lastActivity: session.updated_at,
                    isFavorited: session.is_favorited === 1,
                    __provider: 'claude',
                    __workspaceId: workspace.id,
                }));
            applyScheduledSessionTaskFlags(sessions, 'claude', {
                tenantId: req.tenant.id,
                userId: req.user?.id ?? req.user?.userId,
                workspaceId: workspace.id,
            });

            res.json({
                sessions,
                hasMore: pageOffset + pageLimit < total,
                total,
                offset: pageOffset,
                limit: pageLimit,
            });
            return;
        }

        const { limit = 5, offset = 0 } = req.query;
        const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
        applyCustomSessionNames(result.sessions, 'claude');
        res.json(result);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        if (req.tenant) {
            res.status(statusCode).json({ error: error.message });
            return;
        }
        res.status(500).json({ error: error.message });
    }
});

// Favorite/unfavorite session endpoint
app.put('/api/sessions/:sessionId/favorite', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const normalizedSessionId = normalizeOpaqueSessionId(sessionId);
        if (!normalizedSessionId) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        const { provider = 'claude', favorited = true, projectName } = req.body || {};
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }

        const userId = req.user?.id ?? req.user?.userId;
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        if (req.tenant) {
            const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: false });
            const ownedSession = multitenancyDb.sessions.findOwnedSession({
                tenantId: req.tenant.id,
                userId,
                provider,
                providerSessionId: normalizedSessionId,
                workspaceId: workspace.id,
            });
            if (!ownedSession) {
                return res.status(404).json({ error: 'Session not found' });
            }

            const result = multitenancyDb.sessionFavorites.setFavorite({
                tenantId: req.tenant.id,
                workspaceId: workspace.id,
                userId,
                provider,
                providerSessionId: normalizedSessionId,
                favorited: favorited !== false,
            });

            return res.json({ success: true, isFavorited: result.isFavorited });
        }

        if (!projectName || typeof projectName !== 'string') {
            return res.status(400).json({ error: 'projectName is required' });
        }

        const result = multitenancyDb.sessionFavorites.setFavorite({
            userId,
            projectName,
            provider,
            providerSessionId: normalizedSessionId,
            favorited: favorited !== false,
        });

        return res.json({ success: true, isFavorited: result.isFavorited });
    } catch (error) {
        console.error(`[API] Error updating favorite for session ${req.params.sessionId}:`, error);
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({ error: error.message });
    }
});

// Rename project endpoint
app.put('/api/projects/:projectName/rename', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        if (req.tenant) {
            const { displayName } = req.body;
            if (!displayName || typeof displayName !== 'string') {
                return res.status(400).json({ error: 'Display name is required' });
            }

            const { projectName } = req.params;
            const resolvedWorkspace = resolveEditableWorkspace(req, { projectName });
            if (!resolvedWorkspace) {
                return res.status(404).json({ error: 'Project not found' });
            }

            const { workspace } = resolvedWorkspace;
            multitenancyDb.workspaces.updateDisplayName({
                workspaceId: workspace.id,
                displayName: displayName.trim(),
            });
            res.json({ success: true });
            return;
        }

        const { displayName } = req.body;
        await renameProject(req.params.projectName, displayName);
        res.json({ success: true });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// Delete session endpoint
app.delete('/api/projects/:projectName/sessions/:sessionId', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        const projectName = validateClaudeProjectName(req.params.projectName);
        const provider = req.body?.provider || 'claude';
        const sessionId = provider === 'claude'
            ? validateClaudeSessionId(req.params.sessionId)
            : req.params.sessionId;

        if (req.tenant) {
            console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);

            const resolvedWorkspace = resolveEditableWorkspace(req, { projectName });
            const { workspace } = resolvedWorkspace ?? {};
            if (!workspace) {
                return res.status(404).json({ error: 'Project not found' });
            }

            if (!provider || !VALID_PROVIDERS.includes(provider)) {
                return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
            }

            // Stopping a running Claude command makes runLimitedProviderCommand
            // release its concurrency-limit lease through the existing finally block.
            if (provider === 'claude') {
                await abortClaudeSDKSession(sessionId);
                const runtime = multitenancyDb.runtimes.findByProviderSession({
                    tenantId: req.tenant.id,
                    userId: req.user?.id ?? req.user?.userId,
                    workspaceId: workspace.id,
                    provider,
                    providerSessionId: sessionId,
                }) || multitenancyDb.runtimes.findByOwner({
                    tenantId: req.tenant.id,
                    userId: req.user?.id ?? req.user?.userId,
                    workspaceId: workspace.id,
                    provider,
                    workspaceHostPath: workspace.path,
                });
                if (runtime?.runtime_home_path) {
                    await deleteClaudeDisplayCommands({
                        runtimeHomePath: runtime.runtime_home_path,
                        sessionId,
                    });
                    await deleteSessionFromProjectsRoot(
                        path.join(runtime.runtime_home_path, '.claude', 'projects'),
                        sessionId,
                    );
                }
            }

            const renamed = multitenancyDb.sessions.markDeleted({
                tenantId: req.tenant.id,
                userId: req.user?.id ?? req.user?.userId,
                provider,
                providerSessionId: sessionId,
                workspaceId: workspace?.id,
            });
            if (!renamed) {
                return res.status(404).json({ error: 'Session not found' });
            }
            console.log(`[API] Session ${sessionId} deleted successfully`);
            res.json({ success: true });
            return;
        }

        console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);
        if (provider === 'claude') {
            await abortClaudeSDKSession(sessionId);
        }
        await deleteSession(projectName, sessionId);
        sessionNamesDb.deleteName(sessionId, 'claude');
        console.log(`[API] Session ${sessionId} deleted successfully`);
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error deleting session ${req.params.sessionId}:`, error);
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// Rename session endpoint
app.put('/api/sessions/:sessionId/rename', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        if (req.tenant) {
            const { sessionId } = req.params;
            const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
            if (!safeSessionId || safeSessionId !== String(sessionId)) {
                return res.status(400).json({ error: 'Invalid sessionId' });
            }

            const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
            const { summary, provider } = req.body;
            if (!summary || typeof summary !== 'string' || summary.trim() === '') {
                return res.status(400).json({ error: 'Summary is required' });
            }
            if (summary.trim().length > 500) {
                return res.status(400).json({ error: 'Summary must not exceed 500 characters' });
            }
            if (!provider || !VALID_PROVIDERS.includes(provider)) {
                return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
            }

            const renamed = multitenancyDb.sessions.renameSummary({
                tenantId: req.tenant.id,
                userId: req.user?.id ?? req.user?.userId,
                provider,
                providerSessionId: safeSessionId,
                workspaceId: workspace.id,
                summary: summary.trim(),
            });
            if (!renamed) {
                return res.status(404).json({ error: 'Session not found' });
            }
            res.json({ success: true });
            return;
        }

        const { sessionId } = req.params;
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }
        const { summary, provider } = req.body;
        if (!summary || typeof summary !== 'string' || summary.trim() === '') {
            return res.status(400).json({ error: 'Summary is required' });
        }
        if (summary.trim().length > 500) {
            return res.status(400).json({ error: 'Summary must not exceed 500 characters' });
        }
        if (!provider || !VALID_PROVIDERS.includes(provider)) {
            return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}` });
        }
        sessionNamesDb.setName(safeSessionId, provider, summary.trim());
        res.json({ success: true });
    } catch (error) {
        console.error(`[API] Error renaming session ${req.params.sessionId}:`, error);
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
});

// Delete project endpoint
// force=true to allow removal even when sessions exist
// deleteData=true to also delete legacy session/memory files on disk (destructive)
// Platform workspaces always remove their Docker runtimes and workspace filesystem.
app.delete('/api/projects/:projectName', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    try {
        const projectName = validateClaudeProjectName(req.params.projectName);
        const resolvedWorkspace = resolveWorkspaceDeleteContext(req, { projectName });
        const { workspace } = resolvedWorkspace ?? {};
        if (req.tenant && !workspace) {
            return res.status(404).json({ error: 'Project not found' });
        }
        if (workspace) {
            const force = req.query.force === 'true';
            const deleteData = req.query.deleteData === 'true';

            if (deleteData) {
                try {
                    await deleteProject(projectName, force, deleteData, { skipSessionCheck: true });
                } catch (error) {
                    console.error(`[WARN] Platform project cleanup for ${projectName} failed:`, error);
                }
            }

            const runtimeCleanup = await agentSessionRuntimeManager.cleanupWorkspaceRuntimes({
                tenantId: workspace.tenant_id,
                workspaceId: workspace.id,
            });
            const deletedPath = await deleteWorkspaceFilesystem(workspace);
            multitenancyDb.workspaces.markDeleted({ workspaceId: workspace.id });
            res.json({
                success: true,
                cleanup: {
                    runtimes: runtimeCleanup.cleaned,
                    workspacePath: deletedPath,
                },
            });
            return;
        }

        const force = req.query.force === 'true';
        const deleteData = req.query.deleteData === 'true';
        await deleteProject(projectName, force, deleteData);
        res.json({ success: true });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ error: error.message });
    }
});

function extractSearchableConversationText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (typeof message?.text === 'string') return message.text;
    return '';
}

function truncateConversationSummary(text, fallback = 'New Session') {
    if (typeof text !== 'string' || !text.trim()) return fallback;
    const normalized = text.trim().replace(/\s+/g, ' ');
    return normalized.length > 50 ? `${normalized.substring(0, 50)}...` : normalized;
}

async function searchTenantConversations({
    query,
    limit,
    tenantId,
    userId,
    onProjectResult = null,
    signal = null,
}) {
    const safeQuery = typeof query === 'string' ? query.trim() : '';
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 50, 200));
    const { terms, allWordsMatch, buildSnippet } = createConversationSearchHelpers(safeQuery);
    if (terms.length === 0) return { results: [], totalMatches: 0, query: safeQuery };

    const isAborted = () => signal?.aborted === true;
    const results = [];
    let totalMatches = 0;

    const workspaceRows = multitenancyDb.workspaces.listVisibleWorkspaces({ tenantId, userId });
    let scannedProjects = 0;
    const totalProjects = workspaceRows.length;

    for (const workspace of workspaceRows) {
        if (totalMatches >= safeLimit || isAborted()) break;

        const projectResult = {
            projectName: workspace.slug,
            projectDisplayName: workspace.display_name || workspace.slug,
            sessions: [],
        };

        const sessionRows = multitenancyDb.sessions.listSessions({
            tenantId,
            workspaceId: workspace.id,
            userId,
        });

        for (const session of sessionRows) {
            if (totalMatches >= safeLimit || isAborted()) break;
            if (!session?.provider || !session?.provider_session_id) continue;

            let messages = [];
            if (session.provider === 'claude') {
                const runtime = multitenancyDb.runtimes.findByProviderSession({
                    tenantId,
                    workspaceId: workspace.id,
                    userId,
                    provider: session.provider,
                    providerSessionId: session.provider_session_id,
                }) || multitenancyDb.runtimes.findByOwner({
                    tenantId,
                    workspaceId: workspace.id,
                    userId,
                    provider: session.provider,
                    workspaceHostPath: workspace.path,
                });
                try {
                    if (runtime?.runtime_home_path) {
                        const jsonlHistory = await sessionsService.fetchHistory(session.provider, session.provider_session_id, {
                            projectName: workspace.slug || '',
                            projectPath: workspace.path || '',
                            runtimeHomePath: runtime.runtime_home_path,
                            limit: null,
                            offset: 0,
                        });
                        messages = jsonlHistory.messages || [];
                    }
                } catch (error) {
                    console.warn(`Skipping Claude JSONL history for ${session.provider_session_id}:`, error.message);
                }
            } else {
                try {
                    const dbHistory = multitenancyDb.sessionMessages.listMessages({
                        tenantId,
                        workspaceId: workspace.id,
                        userId,
                        provider: session.provider,
                        providerSessionId: session.provider_session_id,
                        limit: null,
                        offset: 0,
                    });
                    messages = dbHistory.messages || [];
                    if (messages.length === 0) {
                        const providerHistory = await sessionsService.fetchHistory(session.provider, session.provider_session_id, {
                            projectName: workspace.slug || '',
                            projectPath: workspace.path || '',
                            workspaceId: workspace.id,
                            limit: null,
                            offset: 0,
                        });
                        messages = providerHistory.messages || [];
                    }
                } catch (error) {
                    console.warn(`Skipping provider history for ${session.provider}:${session.provider_session_id}:`, error.message);
                }
            }

            // Transitional fallback for sessions created before runtime JSONL
            // became the canonical Claude history source.
            if (messages.length === 0) {
                try {
                    const legacyHistory = multitenancyDb.sessionMessages.listMessages({
                        tenantId,
                        workspaceId: workspace.id,
                        userId,
                        provider: session.provider,
                        providerSessionId: session.provider_session_id,
                        limit: null,
                        offset: 0,
                    });
                    messages = legacyHistory.messages || [];
                } catch (error) {
                    console.warn(`Skipping legacy history for ${session.provider}:${session.provider_session_id}:`, error.message);
                }
            }

            const matches = [];
            let firstUserText = '';

            for (const message of messages) {
                if (totalMatches >= safeLimit || isAborted()) break;

                const role = message.role === 'user' || message.role === 'assistant'
                    ? message.role
                    : null;
                if (!role) continue;

                const text = extractSearchableConversationText(message);
                if (!text) continue;
                if (role === 'user' && !firstUserText) firstUserText = text;

                const textLower = text.toLowerCase();
                if (!allWordsMatch(textLower)) continue;

                if (matches.length < 2) {
                    const { snippet, highlights } = buildSnippet(text, textLower);
                    matches.push({
                        role,
                        snippet,
                        highlights,
                        timestamp: message.timestamp || null,
                        provider: session.provider,
                        messageUuid: message.id || null,
                    });
                    totalMatches++;
                }
            }

            if (matches.length > 0) {
                projectResult.sessions.push({
                    sessionId: session.provider_session_id,
                    provider: session.provider,
                    sessionSummary: truncateConversationSummary(session.summary || firstUserText),
                    matches,
                });
            }
        }

        scannedProjects++;
        if (projectResult.sessions.length > 0) {
            results.push(projectResult);
            onProjectResult?.({ projectResult, totalMatches, scannedProjects, totalProjects });
        } else if (onProjectResult && scannedProjects % 10 === 0) {
            onProjectResult({ projectResult: null, totalMatches, scannedProjects, totalProjects });
        }
    }

    return { results, totalMatches, query: safeQuery };
}

// Search conversations content (SSE streaming)
app.get('/api/search/conversations', authenticateToken, attachTenantContextIfNeeded, async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const parsedLimit = Number.parseInt(String(req.query.limit), 10);
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.max(1, Math.min(parsedLimit, 100));

    if (query.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const abortController = new AbortController();
    req.on('close', () => { closed = true; abortController.abort(); });

    try {
        const emitSearchEvent = ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
            if (closed) return;
            if (projectResult) {
                res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
            } else {
                res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
            }
        };

        if (req.tenant) {
            const userId = req.user?.id ?? req.user?.userId;
            await searchTenantConversations({
                query,
                limit,
                tenantId: req.tenant.id,
                userId,
                onProjectResult: emitSearchEvent,
                signal: abortController.signal,
            });
        } else {
            await searchConversations(query, limit, emitSearchEvent, abortController.signal);
        }
        if (!closed) {
            res.write(`event: done\ndata: {}\n\n`);
        }
    } catch (error) {
        console.error('Error searching conversations:', error);
        if (!closed) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
        }
    } finally {
        if (!closed) {
            res.end();
        }
    }
});

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        if (!canAccessHostFilesystem(req.user)) {
            return res.status(403).json({ error: 'Host filesystem browsing is restricted to system administrators' });
        }

        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken, async (req, res) => {
    try {
        if (!canAccessHostFilesystem(req.user)) {
            return res.status(403).json({ error: 'Host filesystem changes are restricted to system administrators' });
        }

        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            await applyWorkspaceOwnership({
                workspaceRoot: targetPath,
                targetPaths: [targetPath],
                recursive: false,
                includeParents: false,
                reason: 'host_folder_create',
            });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const { resolvedPath: resolved } = resolveWorkspacePathForRequest(req, filePath, { requireEdit: false });

        const content = await fsPromises.readFile(resolved, 'utf8');
        res.json({ content, path: resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectName/files/content', authenticateToken, async (req, res) => {
    try {
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        const { resolvedPath: resolved } = resolveWorkspacePathForRequest(req, filePath, { requireEdit: false });

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            if (error.statusCode) {
                return handleWorkspaceError(res, error);
            }
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectName/file', authenticateToken, async (req, res) => {
    try {
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const {
            workspace,
            resolvedPath: resolved,
            runtimeMounted,
        } = resolveWorkspacePathForRequest(req, filePath, { requireEdit: true });

        // Write the new content
        await fsPromises.writeFile(resolved, content, 'utf8');
        if (!runtimeMounted) {
            await applyWorkspaceOwnership({
                workspaceRoot: workspace.path,
                targetPaths: [resolved],
                reason: 'file_manager_save',
                context: { workspaceId: workspace.id },
            });
        }

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: false });
        const actualPath = workspace.path;

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        }
        return res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectName/files/quota', authenticateToken, async (req, res) => {
    try {
        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: false });
        const quota = await getWorkspaceStorageQuota({ workspace, userStore: userDb });
        res.json({
            success: true,
            ...quota,
        });
    } catch (error) {
        console.error('[ERROR] File quota error:', error.message);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        }
        return res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectRoot)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

function resolveWorkspacePathForRequest(req, targetPath, { requireEdit = false } = {}) {
    const { workspace, accessRole } = resolveWorkspaceForRequest(req, { requireEdit });
    const mappedPath = resolveRuntimeMountedFilePath({
      targetPath,
      tenantCode: req.tenant?.code ?? req.tenant?.slug ?? resolveTenantCode(req),
      userName: req.user?.username ?? req.user?.name ?? req.user?.userName ?? req.user?.id,
      workspace,
    });
    if (mappedPath) {
      return { workspace, accessRole, resolvedPath: mappedPath, runtimeMounted: true };
    }

    const validation = validatePathInProject(workspace.path, targetPath || '');
    if (!validation.valid) {
        const error = new Error(validation.error);
        error.statusCode = 403;
        throw error;
    }
    return { workspace, accessRole, resolvedPath: validation.resolved, runtimeMounted: false };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

// POST /api/projects/:projectName/files/create - Create new file or directory
app.post('/api/projects/:projectName/files/create', authenticateToken, async (req, res) => {
    try {
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
        const projectRoot = workspace.path;

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        }
        await applyWorkspaceOwnership({
            workspaceRoot: projectRoot,
            targetPaths: [resolvedPath],
            recursive: type === 'directory',
            reason: 'file_manager_create',
            context: { workspaceId: workspace.id, type },
        });

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
        broadcastFilesChanged({
            projectName: req.params.projectName,
            workspaceId: workspace.id,
            changedPath: targetPath,
            reason: 'create',
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectName/files/rename - Rename file or directory
app.put('/api/projects/:projectName/files/rename', authenticateToken, async (req, res) => {
    try {
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
        const projectRoot = workspace.path;

        // Validate old path
        const oldValidation = validatePathInProject(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, resolvedNewPath);
        await applyWorkspaceOwnership({
            workspaceRoot: projectRoot,
            targetPaths: [resolvedNewPath],
            recursive: true,
            reason: 'file_manager_rename',
            context: { workspaceId: workspace.id },
        });

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
        broadcastFilesChanged({
            projectName: req.params.projectName,
            workspaceId: workspace.id,
            changedPath: path.relative(projectRoot, resolvedNewPath),
            reason: 'rename',
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectName/files/move - Move file or directory to another directory
app.put('/api/projects/:projectName/files/move', authenticateToken, async (req, res) => {
    try {
        const { sourcePath, targetDirectory } = req.body;

        if (!sourcePath) {
            return res.status(400).json({ error: 'sourcePath is required' });
        }

        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
        const result = await moveWorkspaceItem({
            workspaceRoot: workspace.path,
            sourcePath,
            targetDirectory: targetDirectory || '',
        });

        res.json({
            success: true,
            oldPath: result.oldPath,
            newPath: result.newPath,
            relativePath: result.relativePath,
            type: result.type,
            message: 'Moved successfully',
        });
        broadcastFilesChanged({
            projectName: req.params.projectName,
            workspaceId: workspace.id,
            changedPath: result.relativePath,
            reason: 'move',
        });
    } catch (error) {
        console.error('Error moving file/directory:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectName/files - Delete file or directory
app.delete('/api/projects/:projectName/files', authenticateToken, async (req, res) => {
    try {
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
        const projectRoot = workspace.path;

        // Validate path
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
        broadcastFilesChanged({
            projectName: req.params.projectName,
            workspaceId: workspace.id,
            changedPath: targetPath,
            reason: 'delete',
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.statusCode) {
            return handleWorkspaceError(res, error);
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectName/files/upload - Upload files
// Dynamic import of multer for file uploads
const MAX_FILE_UPLOAD_COUNT = 500;

const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                cb(null, os.tmpdir());
            },
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        limits: {
            fileSize: 50 * 1024 * 1024, // 50MB limit
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Use multer middleware
    uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { targetPath, relativePaths } = req.body;

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const { workspace } = resolveWorkspaceForRequest(req, { requireEdit: true });
            const projectRoot = workspace.path;
            const uploadBytes = req.files.reduce((total, file) => total + (Number(file.size) || 0), 0);
            const quota = await getWorkspaceStorageQuota({ workspace, userStore: userDb });

            try {
                assertWorkspaceUploadFitsQuota(quota, uploadBytes);
            } catch (quotaError) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
                return res.status(quotaError.statusCode || 413).json({
                    error: quotaError.message,
                    ...quotaError.details,
                });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            let uploadOperationError = null;
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            try {
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname
                const fileName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                console.log('[DEBUG] Processing file:', fileName, '(originalname:', file.originalname + ')');
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path
                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios)
                await fsPromises.copyFile(file.path, destPath);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: destPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }
            } catch (error) {
                uploadOperationError = error;
            }

            try {
                await applyWorkspaceOwnership({
                    workspaceRoot: projectRoot,
                    targetPaths: [resolvedTargetDir, ...uploadedFiles.map((file) => file.path)],
                    reason: 'file_manager_upload',
                    context: { workspaceId: workspace.id, files: uploadedFiles.length },
                });
            } catch (ownershipError) {
                if (uploadOperationError) {
                    console.error('[workspace-ownership] Failed after partial file upload:', ownershipError);
                } else {
                    uploadOperationError = ownershipError;
                }
            }
            if (uploadOperationError) {
                throw uploadOperationError;
            }

            res.json({
                success: true,
                files: uploadedFiles,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} file(s) successfully`
            });
            broadcastFilesChanged({
                projectName: req.params.projectName,
                workspaceId: workspace.id,
                changedPath: targetDir,
                reason: 'upload',
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (error.statusCode) {
                return handleWorkspaceError(res, error);
            } else if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    });
};

app.post('/api/projects/:projectName/files/upload', authenticateToken, uploadFilesHandler);

/**
 * Proxy an authenticated client WebSocket to a plugin's internal WS server.
 * Auth is enforced by verifyClient before this function is reached.
 */
function handlePluginWsProxy(clientWs, pathname) {
    const pluginName = pathname.replace('/plugin-ws/', '');
    if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
        clientWs.close(4400, 'Invalid plugin name');
        return;
    }

    const port = getPluginPort(pluginName);
    if (!port) {
        clientWs.close(4404, 'Plugin not running');
        return;
    }

    const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    upstream.on('open', () => {
        console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
    });

    // Relay messages bidirectionally
    upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });
    clientWs.on('message', (data) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    });

    // Propagate close in both directions
    upstream.on('close', () => { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); });
    clientWs.on('close', () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });

    upstream.on('error', (err) => {
        console.error(`[Plugins] WS proxy error for "${pluginName}":`, err.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(4502, 'Upstream error');
    });
    clientWs.on('error', () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
    });
}

// WebSocket connection handler that routes based on URL path
wss.on('connection', (ws, request) => {
    const url = request.url;
    console.log('[INFO] Client connected to:', url);

    // Parse URL to get pathname without query parameters
    const urlObj = new URL(url, 'http://localhost');
    const pathname = urlObj.pathname;

    if (pathname === '/shell') {
        handleShellConnection(ws, request);
    } else if (pathname === '/ws') {
        handleChatConnection(ws, request);
    } else if (pathname.startsWith('/plugin-ws/')) {
        handlePluginWsProxy(ws, pathname);
    } else {
        console.log('[WARN] Unknown WebSocket path:', pathname);
        ws.close();
    }
});

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 *
 * Provider files use `createNormalizedMessage()` from `shared/utils.js` and
 * adapter `normalizeMessage()` to produce unified NormalizedMessage events.
 * The writer simply serialises and sends.
 */
class WebSocketWriter {
    constructor(ws, userId = null) {
        this.ws = ws;
        this.sessionId = null;
        this.userId = userId;
        this.isWebSocketWriter = true;  // Marker for transport detection
    }

    send(data) {
        if (this.ws.readyState === 1) { // WebSocket.OPEN
            this.ws.send(JSON.stringify(data));
        }
    }

    updateWebSocket(newRawWs) {
        this.ws = newRawWs;
    }

    setSessionId(sessionId) {
        this.sessionId = sessionId;
    }

    getSessionId() {
        return this.sessionId;
    }
}

function authorizeCommandWorkspace(data, request, writer) {
    const tenant = request?.tenant;
    const userId = request?.user?.id ?? request?.user?.userId;
    const workspaceId = Number(data.options?.workspaceId);
    const provider = data.type?.replace('-command', '') || 'claude';

    if (!tenant?.id || !workspaceId || !userId) {
        writer.send(createNormalizedMessage({
            kind: 'error',
            content: 'tenantId and workspaceId are required',
            provider
        }));
        return false;
    }

    try {
        const { workspace } = workspaceAccess.requireWorkspace({
            tenantId: tenant.id,
            userId,
            workspaceId,
            requireEdit: true,
        });
        data.options = {
            ...data.options,
            tenantId: tenant.id,
            workspaceId,
            userId,
            cwd: workspace.path,
            projectPath: workspace.path,
        };
        return true;
    } catch (error) {
        writer.send(createNormalizedMessage({
            kind: 'error',
            content: error.message,
            provider
        }));
        return false;
    }
}

function createLogRequestId() {
    return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createChatSessionLogContext({ data, provider, request }) {
    const options = data.options || {};
    const command = typeof data.command === 'string' ? data.command : '';
    return {
        requestId: createLogRequestId(),
        provider,
        sessionMode: options.sessionId ? 'resume' : 'new',
        sessionId: options.sessionId || null,
        tenantId: options.tenantId ?? request?.tenant?.id ?? null,
        workspaceId: options.workspaceId ?? null,
        userId: options.userId ?? request?.user?.id ?? request?.user?.userId ?? null,
        username: request?.user?.username ?? null,
        cwd: options.cwd || options.projectPath || null,
        model: options.model || null,
        permissionMode: options.permissionMode || null,
        messageLength: command.length,
        prompt: command,
        imageCount: Array.isArray(options.images) ? options.images.length : 0,
    };
}

function logChatSessionEvent(event, context, extra = {}) {
    if (!context) return;
    console.log('[chat-session]', JSON.stringify({
        event,
        ...context,
        ...extra,
    }));
}

function resolveSessionLimitLogUser({ userId, username, request, writer }) {
    const normalizedUserId = Number(userId ?? request?.user?.id ?? request?.user?.userId ?? writer?.userId);
    const fallbackUsername = username ?? request?.user?.username ?? writer?.username ?? null;
    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
        return {
            userId: null,
            username: fallbackUsername,
        };
    }

    try {
        const user = userDb.getUserById(normalizedUserId);
        return {
            userId: normalizedUserId,
            username: user?.username ?? fallbackUsername,
        };
    } catch (error) {
        console.warn('[SessionLimit] Failed to resolve username for concurrency limit log:', error?.message || error);
        return {
            userId: normalizedUserId,
            username: fallbackUsername,
        };
    }
}

async function runLimitedProviderCommand({ data, provider, writer, run, logContext = null }) {
    let lease;
    let activeCommandId = null;
    const startedAt = Date.now();
    if (logContext?.requestId) {
        data.options = {
            ...(data.options || {}),
            logRequestId: logContext.requestId,
        };
    }
    logChatSessionEvent('received', logContext);
    try {
        lease = sessionConcurrencyLimiter.acquire({
            userId: data.options?.userId ?? writer.userId,
        });
    } catch (error) {
        if (!isSessionLimitExceededError(error)) {
            throw error;
        }

        const rejectedUser = resolveSessionLimitLogUser({
            userId: error.userId ?? data.options?.userId ?? writer.userId,
            username: logContext?.username,
            writer,
        });
        console.warn('[SessionLimit] User concurrency limit reached', JSON.stringify({
            username: rejectedUser.username,
            userId: rejectedUser.userId,
            provider,
            activeCount: error.activeCount,
            limit: error.limit,
            source: error.source,
            requestId: logContext?.requestId || null,
        }));

        writer.send(createNormalizedMessage({
            kind: 'error',
            content: createSessionLimitExceededMessage(error),
            code: error.code,
            provider,
            sessionId: data.options?.sessionId || null,
            currentConcurrentRequests: error.activeCount,
            sessionLimit: error.limit,
        }));
        logChatSessionEvent('rejected', logContext, {
            reason: error.code || 'session_limit_exceeded',
            currentConcurrentRequests: error.activeCount,
            sessionLimit: error.limit,
            durationMs: Date.now() - startedAt,
        });
        return;
    }

    // Claude keeps its SDK stream alive while idle for fast follow-up turns.
    // Tie the concurrency lease to processing, not to that reusable stream.
    const acquireConcurrencyLease = () => {
        if (lease) return;
        lease = sessionConcurrencyLimiter.acquire({
            userId: data.options?.userId ?? writer.userId,
        });
    };
    const releaseConcurrencyLease = () => {
        lease?.release();
        lease = null;
    };
    if (provider === 'claude') {
        data.options = {
            ...(data.options || {}),
            onConcurrencyResume: acquireConcurrencyLease,
            onConcurrencyIdle: releaseConcurrencyLease,
        };
    }

    try {
        activeCommandId = `${provider}:${Date.now()}:${++activeProviderCommandCounter}`;
        activeProviderCommands.set(activeCommandId, {
            provider,
            sessionId: data.options?.sessionId || null,
            userId: data.options?.userId ?? writer.userId ?? null,
            requestId: logContext?.requestId || null,
            startedAt
        });
        logChatSessionEvent('dispatch', logContext);
        await run();
        logChatSessionEvent('completed', logContext, {
            durationMs: Date.now() - startedAt,
        });
    } catch (error) {
        logChatSessionEvent('failed', logContext, {
            durationMs: Date.now() - startedAt,
            error: error?.message || String(error),
        });
        throw error;
    } finally {
        if (provider !== 'claude' && data.options?.workspaceId && data.options?.cwd) {
            void applyWorkspaceOwnership({
                workspaceRoot: data.options.cwd,
                targetPaths: [data.options.cwd],
                recursive: true,
                includeParents: false,
                reason: 'provider_command_completed',
                context: {
                    provider,
                    workspaceId: data.options.workspaceId,
                    sessionId: data.options.sessionId || null,
                },
            }).catch((error) => {
                console.error('[workspace-ownership] Failed after provider command:', error);
            });
        }
        if (activeCommandId) {
            activeProviderCommands.delete(activeCommandId);
        }
        releaseConcurrencyLease();
    }
}

// Handle chat WebSocket connections
function handleChatConnection(ws, request) {
    console.log('[INFO] Chat WebSocket connected');

    ws.userId = request?.user?.id ?? request?.user?.userId ?? null;
    ws.tenantId = request?.tenant?.id ?? null;

    // Add to connected clients for project updates
    connectedClients.add(ws);

    // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
    const writer = new WebSocketWriter(ws, request?.user?.id ?? request?.user?.userId ?? null);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'claude-command') {
                if (!authorizeCommandWorkspace(data, request, writer)) return;
                const logContext = createChatSessionLogContext({ data, provider: 'claude', request });
                if (data.options?.sessionId) {
                    const pushedToExistingSession = pushClaudeSupplement({
                        sessionId: data.options.sessionId,
                        content: data.command,
                        displayContent: data.options.displayCommand,
                        clientMessageId: data.clientMessageId,
                        mode: 'now',
                        writer,
                    });
                    if (pushedToExistingSession.success) {
                        logChatSessionEvent('pushed_to_existing_stream', logContext);
                        return;
                    }
                    if (pushedToExistingSession.code === 'SESSION_LIMIT_EXCEEDED') {
                        writer.send(createNormalizedMessage({
                            kind: 'error',
                            content: createSessionLimitExceededMessage(pushedToExistingSession),
                            code: pushedToExistingSession.code,
                            provider: 'claude',
                            sessionId: data.options.sessionId,
                            currentConcurrentRequests: pushedToExistingSession.activeCount,
                            sessionLimit: pushedToExistingSession.limit,
                        }));
                        return;
                    }
                }

                // Use Claude Agents SDK
                void runLimitedProviderCommand({
                    data,
                    provider: 'claude',
                    writer,
                    run: () => queryClaudeSDK(data.command, data.options, writer),
                    logContext,
                }).catch((error) => {
                    console.error('[ERROR] Claude command failed:', error?.message || error);
                    writer.send(createNormalizedMessage({
                        kind: 'error',
                        content: error?.message || String(error),
                        provider: 'claude',
                        sessionId: data.options?.sessionId || null,
                    }));
                });
            } else if (data.type === 'claude-supplement') {
                const result = pushClaudeSupplement({
                    sessionId: data.sessionId,
                    content: data.content,
                    clientMessageId: data.clientMessageId,
                    mode: data.mode,
                    writer,
                });
                if (!result.success) {
                    writer.send({
                        type: 'claude-supplement-ack',
                        sessionId: data.sessionId || null,
                        clientMessageId: data.clientMessageId || null,
                        status: 'failed',
                        error: result.error,
                        timestamp: new Date().toISOString(),
                    });
                    writer.send(createNormalizedMessage({
                        kind: 'error',
                        content: result.error,
                        provider: 'claude',
                        sessionId: data.sessionId || null,
                    }));
                }
            } else if (data.type === 'cursor-command') {
                if (!authorizeCommandWorkspace(data, request, writer)) return;
                const logContext = createChatSessionLogContext({ data, provider: 'cursor', request });
                await runLimitedProviderCommand({
                    data,
                    provider: 'cursor',
                    writer,
                    run: () => spawnCursor(data.command, data.options, writer),
                    logContext,
                });
            } else if (data.type === 'codex-command') {
                if (!authorizeCommandWorkspace(data, request, writer)) return;
                const logContext = createChatSessionLogContext({ data, provider: 'codex', request });
                await runLimitedProviderCommand({
                    data,
                    provider: 'codex',
                    writer,
                    run: () => queryCodex(data.command, data.options, writer),
                    logContext,
                });
            } else if (data.type === 'gemini-command') {
                if (!authorizeCommandWorkspace(data, request, writer)) return;
                const logContext = createChatSessionLogContext({ data, provider: 'gemini', request });
                await runLimitedProviderCommand({
                    data,
                    provider: 'gemini',
                    writer,
                    run: () => spawnGemini(data.command, data.options, writer),
                    logContext,
                });
            } else if (data.type === 'cursor-resume') {
                // Backward compatibility: treat as cursor-command with resume and no prompt
                console.log('[DEBUG] Cursor resume session (compat):', data.sessionId);
                const resumeData = {
                    ...data,
                    options: {
                        ...(data.options || {}),
                        sessionId: data.sessionId,
                        userId: writer.userId,
                    },
                };
                const logContext = createChatSessionLogContext({ data: resumeData, provider: 'cursor', request });
                await runLimitedProviderCommand({
                    data: resumeData,
                    provider: 'cursor',
                    writer,
                    run: () => spawnCursor('', {
                        sessionId: data.sessionId,
                        resume: true,
                        cwd: data.options?.cwd
                    }, writer),
                    logContext,
                });
            } else if (data.type === 'abort-session') {
                console.log('[DEBUG] Abort session request:', data.sessionId);
                const provider = data.provider || 'claude';
                let success;

                if (provider === 'cursor') {
                    success = abortCursorSession(data.sessionId);
                } else if (provider === 'codex') {
                    success = abortCodexSession(data.sessionId);
                } else if (provider === 'gemini') {
                    success = abortGeminiSession(data.sessionId);
                } else {
                    // Use Claude Agents SDK
                    success = await abortClaudeSDKSession(data.sessionId);
                }

                writer.send(createNormalizedMessage({ kind: 'complete', exitCode: success ? 0 : 1, aborted: true, success, sessionId: data.sessionId, provider }));
            } else if (data.type === 'claude-permission-response') {
                // Relay UI approval decisions back into the SDK control flow.
                // This does not persist permissions; it only resolves the in-flight request,
                // introduced so the SDK can resume once the user clicks Allow/Deny.
                if (data.requestId) {
                    resolveToolApproval(data.requestId, {
                        allow: Boolean(data.allow),
                        updatedInput: data.updatedInput,
                        message: data.message,
                        rememberEntry: data.rememberEntry
                    });
                }
            } else if (data.type === 'cursor-abort') {
                console.log('[DEBUG] Abort Cursor session:', data.sessionId);
                const success = abortCursorSession(data.sessionId);
                writer.send(createNormalizedMessage({ kind: 'complete', exitCode: success ? 0 : 1, aborted: true, success, sessionId: data.sessionId, provider: 'cursor' }));
            } else if (data.type === 'check-session-status') {
                // Check if a specific session is currently processing
                const provider = data.provider || 'claude';
                const sessionId = data.sessionId;
                let isActive;

                if (provider === 'cursor') {
                    isActive = isCursorSessionActive(sessionId);
                } else if (provider === 'codex') {
                    isActive = isCodexSessionActive(sessionId);
                } else if (provider === 'gemini') {
                    isActive = isGeminiSessionActive(sessionId);
                } else {
                    // Use Claude Agents SDK
                    isActive = isClaudeSDKSessionActive(sessionId);
                    if (isActive) {
                        // Reconnect the session's writer to the new WebSocket so
                        // subsequent SDK output flows to the refreshed client.
                        reconnectSessionWriter(sessionId, ws);
                    }
                }

                writer.send({
                    type: 'session-status',
                    sessionId,
                    provider,
                    isProcessing: isActive
                });
            } else if (data.type === 'get-pending-permissions') {
                // Return pending permission requests for a session
                const sessionId = data.sessionId;
                if (sessionId && isClaudeSDKSessionActive(sessionId)) {
                    const pending = getPendingApprovalsForSession(sessionId);
                    writer.send({
                        type: 'pending-permissions-response',
                        sessionId,
                        data: pending
                    });
                }
            } else if (data.type === 'get-active-sessions') {
                // Get all currently active sessions
                const activeSessions = {
                    claude: getActiveClaudeSDKSessions(),
                    cursor: getActiveCursorSessions(),
                    codex: getActiveCodexSessions(),
                    gemini: getActiveGeminiSessions()
                };
                writer.send({
                    type: 'active-sessions',
                    sessions: activeSessions
                });
            }
        } catch (error) {
            console.error('[ERROR] Chat WebSocket error:', error.message);
            writer.send({
                type: 'error',
                error: error.message
            });
        }
    });

    ws.on('close', () => {
        console.log('🔌 Chat client disconnected');
        // Remove from connected clients
        connectedClients.delete(ws);
    });
}

// Handle shell WebSocket connections
function handleShellConnection(ws, request) {
    console.log('🐚 Shell client connected');
    let shellProcess = null;
    let ptySessionKey = null;
    let urlDetectionBuffer = '';
    const announcedAuthUrls = new Set();

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📨 Shell message received:', data.type);

            if (data.type === 'init') {
                let projectPath;
                try {
                    const tenant = request?.tenant;
                    const userId = request?.user?.id ?? request?.user?.userId;
                    const workspaceId = Number(data.workspaceId);
                    if (!tenant?.id || !workspaceId || !userId) {
                        ws.send(JSON.stringify({ type: 'error', message: 'tenantId and workspaceId are required' }));
                        return;
                    }
                    const { workspace } = workspaceAccess.requireWorkspace({
                        tenantId: tenant.id,
                        userId,
                        workspaceId,
                        requireEdit: true,
                    });
                    projectPath = workspace.path;
                } catch (error) {
                    ws.send(JSON.stringify({ type: 'error', message: error.message }));
                    return;
                }
                const sessionId = data.sessionId;
                const hasSession = data.hasSession;
                const provider = data.provider || 'claude';
                const initialCommand = data.initialCommand;
                const isPlainShell = data.isPlainShell || (!!initialCommand && !hasSession) || provider === 'plain-shell';
                urlDetectionBuffer = '';
                announcedAuthUrls.clear();

                // Login commands (Claude/Cursor auth) should never reuse cached sessions
                const isLoginCommand = initialCommand && (
                    initialCommand.includes('setup-token') ||
                    initialCommand.includes('cursor-agent login') ||
                    initialCommand.includes('auth login')
                );

                // Include command hash in session key so different commands get separate sessions
                const commandSuffix = isPlainShell && initialCommand
                    ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
                    : '';
                ptySessionKey = `${projectPath}_${sessionId || 'default'}${commandSuffix}`;

                // Kill any existing login session before starting fresh
                if (isLoginCommand) {
                    const oldSession = ptySessionsMap.get(ptySessionKey);
                    if (oldSession) {
                        console.log('🧹 Cleaning up existing login session:', ptySessionKey);
                        if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
                        if (oldSession.pty && oldSession.pty.kill) oldSession.pty.kill();
                        ptySessionsMap.delete(ptySessionKey);
                    }
                }

                const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
                if (existingSession) {
                    console.log('♻️  Reconnecting to existing PTY session:', ptySessionKey);
                    shellProcess = existingSession.pty;

                    clearTimeout(existingSession.timeoutId);

                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\x1b[36m[Reconnected to existing session]\x1b[0m\r\n`
                    }));

                    if (existingSession.buffer && existingSession.buffer.length > 0) {
                        console.log(`📜 Sending ${existingSession.buffer.length} buffered messages`);
                        existingSession.buffer.forEach(bufferedData => {
                            ws.send(JSON.stringify({
                                type: 'output',
                                data: bufferedData
                            }));
                        });
                    }

                    existingSession.ws = ws;

                    return;
                }

                console.log('[INFO] Starting shell in:', projectPath);
                console.log('📋 Session info:', hasSession ? `Resume session ${sessionId}` : (isPlainShell ? 'Plain shell mode' : 'New session'));
                console.log('🤖 Provider:', isPlainShell ? 'plain-shell' : provider);
                if (initialCommand) {
                    console.log('⚡ Initial command:', initialCommand);
                }

                // First send a welcome message
                let welcomeMsg;
                if (isPlainShell) {
                    welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
                } else {
                    const providerName = provider === 'cursor' ? 'Cursor' : (provider === 'codex' ? 'Codex' : (provider === 'gemini' ? 'Gemini' : 'Claude'));
                    welcomeMsg = hasSession ?
                        `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n` :
                        `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
                }

                ws.send(JSON.stringify({
                    type: 'output',
                    data: welcomeMsg
                }));

                try {
                    // Validate projectPath — resolve to absolute and verify it exists
                    const resolvedProjectPath = path.resolve(projectPath);
                    try {
                        const stats = fs.statSync(resolvedProjectPath);
                        if (!stats.isDirectory()) {
                            throw new Error('Not a directory');
                        }
                    } catch (pathErr) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
                        return;
                    }

                    // Validate sessionId — only allow safe characters
                    const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
                    if (sessionId && !safeSessionIdPattern.test(sessionId)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
                        return;
                    }

                    // Build shell command — use cwd for project path (never interpolate into shell string)
                    let shellCommand;
                    if (isPlainShell) {
                        // Plain shell mode - run the initial command in the project directory
                        shellCommand = initialCommand;
                    } else if (provider === 'cursor') {
                        if (hasSession && sessionId) {
                            shellCommand = `cursor-agent --resume="${sessionId}"`;
                        } else {
                            shellCommand = 'cursor-agent';
                        }
                    } else if (provider === 'codex') {
                        // Use codex command; attempt to resume and fall back to a new session when the resume fails.
                        if (hasSession && sessionId) {
                            if (os.platform() === 'win32') {
                                // PowerShell syntax for fallback
                                shellCommand = `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
                            } else {
                                shellCommand = `codex resume "${sessionId}" || codex`;
                            }
                        } else {
                            shellCommand = 'codex';
                        }
                    } else if (provider === 'gemini') {
                        const command = initialCommand || 'gemini';
                        let resumeId = sessionId;
                        if (hasSession && sessionId) {
                            try {
                                // Gemini CLI enforces its own native session IDs, unlike other agents that accept arbitrary string names.
                                // The UI only knows about its internal generated `sessionId` (e.g. gemini_1234).
                                // We must fetch the mapping from the backend session manager to pass the native `cliSessionId` to the shell.
                                const sess = sessionManager.getSession(sessionId);
                                if (sess && sess.cliSessionId) {
                                    resumeId = sess.cliSessionId;
                                    // Validate the looked-up CLI session ID too
                                    if (!safeSessionIdPattern.test(resumeId)) {
                                        resumeId = null;
                                    }
                                }
                            } catch (err) {
                                console.error('Failed to get Gemini CLI session ID:', err);
                            }
                        }

                        if (hasSession && resumeId) {
                            shellCommand = `${command} --resume "${resumeId}"`;
                        } else {
                            shellCommand = command;
                        }
                    } else {
                        // Claude (default provider)
                        const command = initialCommand || 'claude';
                        if (hasSession && sessionId) {
                            if (os.platform() === 'win32') {
                                shellCommand = `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
                            } else {
                                shellCommand = `claude --resume "${sessionId}" || claude`;
                            }
                        } else {
                            shellCommand = command;
                        }
                    }

                    console.log('🔧 Executing shell command:', shellCommand);

                    // Use appropriate shell based on platform
                    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
                    const shellArgs = os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];

                    // Use terminal dimensions from client if provided, otherwise use defaults
                    const termCols = data.cols || 80;
                    const termRows = data.rows || 24;
                    console.log('📐 Using terminal dimensions:', termCols, 'x', termRows);

                    shellProcess = pty.spawn(shell, shellArgs, {
                        name: 'xterm-256color',
                        cols: termCols,
                        rows: termRows,
                        cwd: resolvedProjectPath,
                        env: {
                            ...process.env,
                            TERM: 'xterm-256color',
                            COLORTERM: 'truecolor',
                            FORCE_COLOR: '3'
                        }
                    });

                    console.log('🟢 Shell process started with PTY, PID:', shellProcess.pid);

                    ptySessionsMap.set(ptySessionKey, {
                        pty: shellProcess,
                        ws: ws,
                        buffer: [],
                        timeoutId: null,
                        projectPath,
                        sessionId
                    });

                    // Handle data output
                    shellProcess.onData((data) => {
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (!session) return;

                        if (session.buffer.length < 5000) {
                            session.buffer.push(data);
                        } else {
                            session.buffer.shift();
                            session.buffer.push(data);
                        }

                        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
                            let outputData = data;

                            const cleanChunk = stripAnsiSequences(data);
                            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

                            outputData = outputData.replace(
                                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                                '[INFO] Opening in browser: $1'
                            );

                            const emitAuthUrl = (detectedUrl, autoOpen = false) => {
                                const normalizedUrl = normalizeDetectedUrl(detectedUrl);
                                if (!normalizedUrl) return;

                                const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
                                if (isNewUrl) {
                                    announcedAuthUrls.add(normalizedUrl);
                                    session.ws.send(JSON.stringify({
                                        type: 'auth_url',
                                        url: normalizedUrl,
                                        autoOpen
                                    }));
                                }

                            };

                            const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
                                .map((url) => normalizeDetectedUrl(url))
                                .filter(Boolean);

                            // Prefer the most complete URL if shorter prefix variants are also present.
                            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter((url, _, urls) =>
                                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
                            );

                            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

                            if (shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
                                const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                                    current.length > longest.length ? current : longest
                                );
                                emitAuthUrl(bestUrl, true);
                            }

                            // Send regular output
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: outputData
                            }));
                        }
                    });

                    // Handle process exit
                    shellProcess.onExit((exitCode) => {
                        void applyWorkspaceOwnership({
                            workspaceRoot: resolvedProjectPath,
                            targetPaths: [resolvedProjectPath],
                            recursive: true,
                            includeParents: false,
                            reason: 'shell_process_exit',
                            context: { provider: isPlainShell ? 'plain-shell' : provider, sessionId: sessionId || null },
                        }).catch((error) => {
                            console.error('[workspace-ownership] Failed after shell process exit:', error);
                        });
                        console.log('🔚 Shell process exited with code:', exitCode.exitCode, 'signal:', exitCode.signal);
                        const session = ptySessionsMap.get(ptySessionKey);
                        if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
                            session.ws.send(JSON.stringify({
                                type: 'output',
                                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ''}\x1b[0m\r\n`
                            }));
                        }
                        if (session && session.timeoutId) {
                            clearTimeout(session.timeoutId);
                        }
                        ptySessionsMap.delete(ptySessionKey);
                        shellProcess = null;
                    });

                } catch (spawnError) {
                    console.error('[ERROR] Error spawning process:', spawnError);
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`
                    }));
                }

            } else if (data.type === 'input') {
                // Send input to shell process
                if (shellProcess && shellProcess.write) {
                    try {
                        shellProcess.write(data.data);
                    } catch (error) {
                        console.error('Error writing to shell:', error);
                    }
                } else {
                    console.warn('No active shell process to send input to');
                }
            } else if (data.type === 'resize') {
                // Handle terminal resize
                if (shellProcess && shellProcess.resize) {
                    console.log('Terminal resize requested:', data.cols, 'x', data.rows);
                    shellProcess.resize(data.cols, data.rows);
                }
            }
        } catch (error) {
            console.error('[ERROR] Shell WebSocket error:', error.message);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'output',
                    data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`
                }));
            }
        }
    });

    ws.on('close', () => {
        console.log('🔌 Shell client disconnected');

        if (ptySessionKey) {
            const session = ptySessionsMap.get(ptySessionKey);
            if (session) {
                console.log('⏳ PTY session kept alive, will timeout in 30 minutes:', ptySessionKey);
                session.ws = null;

                session.timeoutId = setTimeout(() => {
                    console.log('⏰ PTY session timeout, killing process:', ptySessionKey);
                    if (session.pty && session.pty.kill) {
                        session.pty.kill();
                    }
                    ptySessionsMap.delete(ptySessionKey);
                }, PTY_SESSION_TIMEOUT);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[ERROR] Shell WebSocket error:', error);
    });
}
// Image upload endpoint
app.post('/api/projects/:projectName/upload-images', authenticateToken, async (req, res) => {
    try {
        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        // Configure multer for image uploads
        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                const uploadDir = path.join(os.tmpdir(), 'claude-ui-uploads', String(req.user.id));
                await fs.mkdir(uploadDir, { recursive: true });
                cb(null, uploadDir);
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024, // 5MB
                files: 5
            }
        });

        // Handle multipart form data
        upload.array('images', 5)(req, res, async (err) => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            try {
                // Process uploaded images
                const processedImages = await Promise.all(
                    req.files.map(async (file) => {
                        // Read file and convert to base64
                        const buffer = await fs.readFile(file.path);
                        const base64 = buffer.toString('base64');
                        const mimeType = file.mimetype;

                        // Clean up temp file immediately
                        await fs.unlink(file.path);

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${base64}`,
                            size: file.size,
                            mimeType: mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error) {
                console.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                res.status(500).json({ error: 'Failed to process images' });
            }
        });
    } catch (error) {
        console.error('Error in image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get token usage for a specific session
app.get('/api/projects/:projectName/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectName, sessionId } = req.params;
        const { provider = 'claude' } = req.query;
        const homeDir = os.homedir();

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        // Handle Gemini sessions - they are raw logs in our current setup
        if (provider === 'gemini') {
            return res.json({
                used: 0,
                total: 0,
                breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Gemini sessions'
            });
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(safeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            const lines = fileContent.trim().split('\n');
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow
            });
        }

        // Handle Claude sessions (default)
        // Extract actual project path
        let projectPath;
        try {
            projectPath = await extractProjectDirectory(projectName);
        } catch (error) {
            console.error('Error extracting project directory:', error);
            return res.status(500).json({ error: 'Failed to determine project path' });
        }

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

        // Constrain to projectDir
        const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
        const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
        let inputTokens = 0;
        let cacheCreationTokens = 0;
        let cacheReadTokens = 0;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    inputTokens = usage.input_tokens || 0;
                    cacheCreationTokens = usage.cache_creation_input_tokens || 0;
                    cacheReadTokens = usage.cache_read_input_tokens || 0;

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        // Calculate total context usage (excluding output_tokens, as per ccusage)
        const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            breakdown: {
                input: inputTokens,
                cacheCreation: cacheCreationTokens,
                cacheRead: cacheReadTokens
            }
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    const items = [];

    try {
        const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            // Debug: log all entries including hidden files


            const itemPath = path.join(dirPath, entry.name);
            const item = {
                name: entry.name,
                path: itemPath,
                type: entry.isDirectory() ? 'directory' : 'file'
            };

            // Get file stats for additional metadata
            try {
                const stats = await fsPromises.stat(itemPath);
                item.size = stats.size;
                item.modified = stats.mtime.toISOString();

                // Convert permissions to rwx format
                const mode = stats.mode;
                const ownerPerm = (mode >> 6) & 7;
                const groupPerm = (mode >> 3) & 7;
                const otherPerm = mode & 7;
                item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
                item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
            } catch (statError) {
                // If stat fails, provide default values
                item.size = 0;
                item.modified = null;
                item.permissions = '000';
                item.permissionsRwx = '---------';
            }

            if (entry.isDirectory() && currentDepth < maxDepth) {
                // Recursively get subdirectories but limit depth
                try {
                    // Check if we can access the directory before trying to read it
                    await fsPromises.access(item.path, fs.constants.R_OK);
                    item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
                } catch (e) {
                    // Silently skip directories we can't access (permission denied, etc.)
                    item.children = [];
                }
            }

            items.push(item);
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
    }

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;

function getActiveWorkSummary() {
    const providerCommands = {
        claude: 0,
        codex: 0,
        cursor: 0,
        gemini: 0
    };

    for (const command of activeProviderCommands.values()) {
        if (Object.prototype.hasOwnProperty.call(providerCommands, command.provider)) {
            providerCommands[command.provider] += 1;
        }
    }

    const providerSessions = {
        claude: getActiveClaudeSDKSessions().length,
        codex: getActiveCodexSessions().length,
        cursor: getActiveCursorSessions().length,
        gemini: getActiveGeminiSessions().length
    };

    return {
        providerCommands,
        providerSessions,
        shell: ptySessionsMap.size
    };
}

function getActiveWorkCount(summary = getActiveWorkSummary()) {
    const activeProviderCommands = Object.values(summary.providerCommands || {})
        .reduce((total, count) => total + count, 0);
    const activeProviderSessions = Object.values(summary.providerSessions || {})
        .reduce((total, count) => total + count, 0);
    return Math.max(activeProviderCommands, activeProviderSessions) + (summary.shell || 0);
}

function waitForActiveWorkToDrain(timeoutMs) {
    const startedAt = Date.now();

    return new Promise((resolve) => {
        const poll = () => {
            const summary = getActiveWorkSummary();
            const activeCount = getActiveWorkCount(summary);

            if (activeCount === 0) {
                resolve({drained: true, summary});
                return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
                resolve({drained: false, summary});
                return;
            }

            console.log('[Shutdown] Waiting for active work to finish:', summary);
            setTimeout(poll, GRACEFUL_SHUTDOWN_POLL_MS).unref?.();
        };

        poll();
    });
}

async function closeProjectsWatchers() {
    const watchers = projectsWatchers;
    projectsWatchers = [];

    if (projectsWatcherDebounceTimer) {
        clearTimeout(projectsWatcherDebounceTimer);
        projectsWatcherDebounceTimer = null;
    }

    await Promise.allSettled(watchers.map((watcher) => watcher.close()));
}

function closeHttpServer() {
    return new Promise((resolve) => {
        server.close((error) => {
            if (error) {
                console.error('[Shutdown] Error closing HTTP server:', error);
            }
            resolve();
        });
    });
}

function closeWebSockets() {
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close(1012, 'Server restarting');
        }
    }

    return new Promise((resolve) => {
        wss.close((error) => {
            if (error) {
                console.error('[Shutdown] Error closing WebSocket server:', error);
            }
            resolve();
        });
    });
}

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        return;
    }

    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}; draining active work before exit`);

    runtimeSweeper.stop();
    codeHubMrPoller.stop();
    closeHttpServer().catch((error) => {
        console.error('[Shutdown] Failed to close HTTP server:', error);
    });

    try {
        const result = await waitForActiveWorkToDrain(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        if (result.drained) {
            console.log('[Shutdown] Active work drained');
        } else {
            console.warn('[Shutdown] Grace period expired with active work remaining:', result.summary);
        }

        await closeProjectsWatchers();
        await closeWebSockets();
        await stopAllPlugins();
        process.exit(0);
    } catch (error) {
        console.error('[Shutdown] Graceful shutdown failed:', error);
        process.exit(1);
    }
}

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();
        runtimeSweeper.start();
        scheduledSessionTasks.start();
        codeHubMrPoller.start();

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        server.listen(SERVER_PORT, HOST, async () => {
            const appInstallPath = APP_ROOT;

            console.log('');
            console.log(c.dim('═'.repeat(63)));
            console.log(`  ${c.bright('CloudCLI Server - Ready')}`);
            console.log(c.dim('═'.repeat(63)));
            console.log('');
            console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
            console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
            console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
            console.log('');

            // Start watching the projects folder for changes
            await setupProjectsWatcher();

            // Start server-side plugin processes for enabled plugins
            startEnabledPluginServers().catch(err => {
                console.error('[Plugins] Error during startup:', err.message);
            });

            if (typeof process.send === 'function') {
                process.send('ready');
            }
        });

        // Clean up plugin processes on shutdown
        const shutdownPlugins = async () => {
            runtimeSweeper.stop();
            scheduledSessionTasks.stop();
            codeHubMrPoller.stop();
            await stopAllPlugins();
            process.exit(0);
        };
        process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
    } catch (error) {
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
