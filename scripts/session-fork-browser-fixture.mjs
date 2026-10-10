#!/usr/bin/env node
// Dedicated loopback browser fixture. The application UI and fork/history
// services are real; all identities, transcripts, model responses and DBs belong
// only to the temporary directory created here. Never loads .env or index.js.
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer } from 'ws';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SESSION_FORK_BROWSER_PORT || 4417);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port');
const origin = `http://127.0.0.1:${port}`;
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccui-fork-browser-')));
const runtimeHomePath = path.join(temporary, 'home');
const workspacePath = path.join(temporary, 'workspace');
const importDbPath = path.join(temporary, 'imports.sqlite');
// Prevent legacy DB auto-migration from copying the real account database.
await writeFile(importDbPath, '');
process.env.DATABASE_PATH = importDbPath;
await mkdir(runtimeHomePath);
await mkdir(workspacePath);
await writeFile(path.join(workspacePath, 'color.txt'), 'blue\n');

// Work around the bundled Node 24/native addon GC-finalizer issue in this
// throwaway harness only. Production files are not modified.
const fixtureStatements = [];
if (process.versions.node.startsWith('24.')) {
  const native = createRequire(import.meta.url)('better-sqlite3/build/Release/better_sqlite3.node');
  const prepare = native.Database.prototype.prepare;
  native.Database.prototype.prepare = function (...args) {
    const statement = prepare.apply(this, args);
    fixtureStatements.push(statement);
    return statement;
  };
}

const [
  { DATABASE_SCHEMA_SQL }, { MULTITENANCY_SCHEMA_SQL }, { createMultitenancyDb },
  { ClaudeSessionsProvider }, { createSessionForkRouter }, { createSessionForkService },
  { createWorkspaceAccessService }, { createSessionMessageHistoryService },
  { mapWorkspaceRowsToProjects }, { createClaudeSessionExecutionQueue, buildClaudeSessionExecutionKey },
  { appendClaudeCompletedReply }, { createClaudeCompletedReplyTracker },
] = await Promise.all([
  import('../server/database/schema.js'), import('../server/database/multitenancy-schema.js'),
  import('../server/database/multitenancy-db.js'),
  import('../server/modules/providers/list/claude/claude-sessions.provider.ts'),
  import('../server/routes/session-forks.js'), import('../server/services/session-fork.js'),
  import('../server/services/workspace-access.js'), import('../server/services/session-message-history.js'),
  import('../server/services/workspace-projects.js'), import('../server/services/claude-session-execution.js'),
  import('../server/services/claude-fork-checkpoint-store.js'), import('../server/services/claude-fork-checkpoint.js'),
]);
const database = new Database(path.join(temporary, 'fixture.sqlite'));
database.exec(DATABASE_SCHEMA_SQL);
database.exec(MULTITENANCY_SCHEMA_SQL);
database.prepare('INSERT INTO users(id,username,password_hash) VALUES(1,?,?)').run('fork-browser', 'fixture-only-no-password-hash');
const mt = createMultitenancyDb(database);
const tenant = mt.tenants.createTenant({ code: 'fork-browser', name: '分支验收 · 隔离测试租户' });
mt.memberships.upsertMembership({ tenantId: tenant.id, userId: 1, role: 'member', permission: 'edit', status: 'active' });
const workspace = mt.workspaces.createWorkspace({ tenantId: tenant.id, ownerUserId: 1,
  slug: 'fork-browser', displayName: '分支到新聊天 · 页面验收', path: workspacePath });
const scope = { tenantId: tenant.id, userId: 1, workspaceId: workspace.id, provider: 'claude' };
const sourceSessionId = randomUUID();
const ids = Array.from({ length: 8 }, () => randomUUID());
const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', workspacePath.replace(/[^a-zA-Z0-9-]/g, '-'));
await mkdir(projectDirectory, { recursive: true });
const rows = [
  { type: 'user', message: { role: 'user', content: '请记住：方案颜色是蓝色（blue），帮我读取 color.txt 确认。' } },
  { type: 'assistant', message: { id: 'msg_fixture_tool', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool_fixture_read', name: 'Read', input: { file_path: path.join(workspacePath, 'color.txt') } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_fixture_read', content: 'blue' }] } },
  { type: 'assistant', message: { id: 'msg_fixture_blue', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '已确认：方案颜色是蓝色（blue）。文件读取结果也是 blue。\n\n可以从这条已完成回复分支到新聊天。' }] } },
  { type: 'user', message: { role: 'user', content: '后续修改：方案颜色改为红色（red）。这条消息应只留在原聊天。' } },
  { type: 'assistant', message: { id: 'msg_fixture_red', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '原聊天现在采用红色（red）。从上面的蓝色回复分支时，不应带入这条后续回复。' }] } },
].map((row, index) => ({ ...row, sessionId: sourceSessionId, uuid: ids[index], parentUuid: ids[index - 1] || null,
  cwd: workspacePath, timestamp: new Date(Date.now() - 600_000 + index * 30_000).toISOString() }));
const sourcePath = path.join(projectDirectory, `${sourceSessionId}.jsonl`);
const sourceBytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
await writeFile(sourcePath, sourceBytes);
mt.sessions.upsertSession({ ...scope, providerSessionId: sourceSessionId, summary: '颜色方案：蓝色 → 后续红色', status: 'completed' });
mt.runtimes.createRuntime({ ...scope, runtimeId: 'fork-browser-runtime', containerName: 'fixture-local', image: 'local',
  workspaceHostPath: workspacePath, runtimeHomePath });
mt.runtimes.bindProviderSession({ runtimeId: 'fork-browser-runtime', providerSessionId: sourceSessionId });
mt.runtimes.updateStatus({ runtimeId: 'fork-browser-runtime', status: 'idle' });
for (const sourceMessageUuid of [ids[3], ids[5]]) await appendClaudeCompletedReply({ runtimeHomePath, projectPath: workspacePath, sessionId: sourceSessionId, sourceMessageUuid });
const incompleteSessionId = randomUUID();
const incompleteRows = [
  { type: 'user', uuid: ids[6], parentUuid: null, message: { role: 'user', content: '未完成回复验收：不要显示分支按钮。' } },
  { type: 'assistant', uuid: ids[7], parentUuid: ids[6], message: { id: 'msg_incomplete', role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: '这条回复因输出中断而未完成，不应出现分支按钮。' }] } },
].map(row => ({ ...row, sessionId: incompleteSessionId, cwd: workspacePath, timestamp: new Date().toISOString() }));
await writeFile(path.join(projectDirectory, `${incompleteSessionId}.jsonl`), incompleteRows.map(row => JSON.stringify(row)).join('\n') + '\n');
mt.sessions.upsertSession({ ...scope, providerSessionId: incompleteSessionId, summary: '未完成回复 · 不可分支', status: 'failed' });

const provider = new ClaudeSessionsProvider();
const history = createSessionMessageHistoryService({ multitenancy: mt, hookConfigs: {}, providerSessions: {
  fetchHistory: (_provider, id, options) => provider.fetchHistory(id, options),
} });
const queue = createClaudeSessionExecutionQueue();
const active = new Set();
const forkService = createSessionForkService({ multitenancy: mt, access: createWorkspaceAccessService(mt), history,
  isSessionActive: id => active.has(id),
  withSessionLock: async (options, operation) => {
    const key = buildClaudeSessionExecutionKey(options);
    if (active.has(options.sessionId) || queue.hasPending(key)) throw Object.assign(new Error('Session is busy'), { statusCode: 409, code: 'SESSION_BUSY' });
    return queue.run(key, operation);
  },
  registerFork: ({ session, runtimeId, messages }) => database.transaction(() => {
    const row = mt.sessions.upsertSession(session);
    if (messages.length) mt.sessionMessages.upsertMessages({ ...scope, providerSessionId: session.providerSessionId, runtimeId, messages });
    return row;
  })(),
});
let browserModel;
const getModel = async () => {
  if (!browserModel) {
    const { createForkBrowserModel } = await import('./session-fork-browser-model.mjs');
    browserModel = await createForkBrowserModel({ runtimeHomePath, cwd: workspacePath });
  }
  return browserModel;
};
const projects = () => mapWorkspaceRowsToProjects([{ ...workspace, accessRole: 'owner' }], {
  tenantId: tenant.id, userId: 1, listSessions: mt.sessions.listSessions,
  listScheduledTasks: () => [], getScheduledTaskMap: () => new Map(),
});
const user = { id: 1, username: 'fork-browser', is_active: 1, is_system_admin: 0 };
const fixtureToken = 'ccui-session-fork-browser-fixture-only';
const requestLog = [];
const app = express();
const http = createServer(app);
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
  res.setHeader('Cache-Control', 'no-store');
  if (req.path.startsWith('/api/')) res.once('finish', () => requestLog.push({ method: req.method, path: req.originalUrl, status: res.statusCode }));
  next();
});
app.use(express.json({ limit: '1mb' }));
app.get('/api/auth/status', (_req, res) => res.json({ needsSetup: false }));
app.post('/api/auth/login', (req, res) => req.body.username === 'fork-browser' && req.body.password === 'fixture-only'
  ? res.json({ user, token: fixtureToken }) : res.status(401).json({ error: '测试账号 fork-browser / fixture-only' }));
app.post('/api/auth/logout', (_req, res) => res.json({ success: true }));
app.use('/api', (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${fixtureToken}`) return res.status(401).json({ error: 'Fixture login required' });
  req.user = user;
  next();
});
app.get('/api/auth/user', (_req, res) => res.json({ user }));
app.get('/api/user/onboarding-status', (_req, res) => res.json({ hasCompletedOnboarding: true }));
app.get('/api/tenants/me', (_req, res) => res.json({ tenants: [{ ...tenant, role: 'member', permission: 'edit' }] }));
app.post('/api/tenants/:id/agent-list-check', (_req, res) => res.json({ success: true }));
app.get('/api/projects', (_req, res) => res.json(projects()));
app.get('/api/projects/:project/sessions', (_req, res) => res.json({ sessions: projects()[0].sessions, hasMore: false }));
app.get('/api/sessions/:sessionId/messages', async (req, res, next) => {
  try {
    const ownedSession = mt.sessions.findOwnedSession({ ...scope, providerSessionId: req.params.sessionId });
    if (!ownedSession) return res.status(404).json({ error: 'Session not found' });
    res.json(await history.fetchHistory({ ...scope, providerSessionId: req.params.sessionId, ownedSession,
      limit: req.query.limit ? Number(req.query.limit) : null, offset: Number(req.query.offset || 0) }));
  } catch (error) { next(error); }
});
app.use('/api/sessions', createSessionForkRouter(forkService));
app.get('/api/plugins', (_req, res) => res.json({ plugins: [] }));
app.get('/api/taskmaster/installation-status', (_req, res) => res.json({ installation: { isInstalled: false }, isReady: false }));
app.get('/api/mcp-utils/taskmaster-server', (_req, res) => res.json({ hasMCPServer: false, hasConfig: false }));
app.get('/api/taskmaster/tasks/:projectName', (req, res) => res.json({ projectName: req.params.projectName, tasks: [] }));
app.get('/api/settings/feature-flags', (_req, res) => res.json({ features: { agentGraph: false } }));
app.get('/api/settings/server-env', (_req, res) => res.json({ platform: process.platform }));
app.get('/api/settings/model-response-hooks', (_req, res) => res.json({ success: true, config: {} }));
app.get('/api/cursor/config', (_req, res) => res.json({ models: [] }));
app.post('/api/commands/list', (_req, res) => res.json({ builtIn: [], custom: [] }));
app.get('/api/projects/:project/sessions/:sessionId/token-usage', (_req, res) => res.json({}));
app.post('/api/projects/:project/agent-list-check', (_req, res) => res.json({ success: true }));
app.get('/api/scheduled-tasks', (_req, res) => res.json({ tasks: [] }));
app.get('/api/workspaces/:workspaceId/hooks', (_req, res) => res.json({ hooks: [] }));
app.get('/api/agent-templates', (_req, res) => res.json({ templates: [] }));
app.get('/api/skill-market', (_req, res) => res.json({ skills: [], total: 0 }));
app.get('/api/projects/:project/files', (_req, res) => res.json([]));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not available in this isolated fork fixture' }));

const sha256 = text => createHash('sha256').update(text).digest('hex');
app.get('/__fork-test__/evidence', async (_req, res, next) => {
  try {
    const sourceNow = await readFile(sourcePath, 'utf8');
    const forks = mt.sessions.listSessions(scope).filter(row => JSON.parse(row.metadata_json || '{}').fork)
      .map(row => ({ sessionId: row.provider_session_id, ...JSON.parse(row.metadata_json).fork }));
    res.json({ temporary, sourceSessionId, sourceMessageUuid: ids[3], incompleteSessionId,
      sourceUnchanged: sha256(sourceNow) === sha256(sourceBytes), sourceHash: sha256(sourceNow), originalSourceHash: sha256(sourceBytes),
      forkCount: forks.length, forks, modelRequests: browserModel?.requests || [], requestLog });
  } catch (error) { next(error); }
});

const webSockets = new WebSocketServer({ noServer: true });
const projectUpdate = () => ({ type: 'projects_updated', projects: projects(), tenantId: tenant.id });
app.post('/__fork-test__/broadcast-projects', (_req, res) => {
  const update = JSON.stringify(projectUpdate());
  for (const socket of webSockets.clients) if (socket.readyState === 1) socket.send(update);
  res.json({ success: true, clients: webSockets.clients.size });
});
http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, origin);
  if (url.pathname !== '/ws') return; // Vite handles its own HMR upgrade.
  if (req.headers.host !== `127.0.0.1:${port}` || url.searchParams.get('token') !== fixtureToken) return socket.destroy();
  webSockets.handleUpgrade(req, socket, head, ws => webSockets.emit('connection', ws, req));
});
webSockets.on('connection', ws => {
  const send = message => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  send(projectUpdate());
  ws.on('message', async bytes => {
    let message;
    try {
      message = JSON.parse(bytes.toString());
      if (message.type === 'get-active-sessions') return send({ type: 'active-sessions', sessions: { claude: [...active], codex: [], cursor: [], gemini: [] } });
      if (message.type === 'check-session-status') return send({ type: 'session-status', sessionId: message.sessionId, provider: 'claude', isProcessing: active.has(message.sessionId) });
      if (message.type === 'get-pending-permissions') return send({ type: 'pending-permissions-response', sessionId: message.sessionId, data: [] });
      if (message.type !== 'claude-command') return;
      const sessionId = message.options?.sessionId;
      const row = mt.sessions.findOwnedSession({ ...scope, providerSessionId: sessionId });
      if (!row || sessionId === sourceSessionId || sessionId === incompleteSessionId) {
        throw new Error('本验收环境只允许在新分支中续聊，以便检验原聊天保持不变。');
      }
      const key = buildClaudeSessionExecutionKey({ ...scope, sessionId });
      await queue.run(key, async () => {
        active.add(sessionId);
        const tracker = createClaudeCompletedReplyTracker();
        try {
          const model = await getModel();
          await model.resume({ sessionId, prompt: message.command, onMessage: async raw => {
            const completedUuid = tracker.observe(raw);
            if (completedUuid) await appendClaudeCompletedReply({ runtimeHomePath, projectPath: workspacePath, sessionId, sourceMessageUuid: completedUuid });
            for (const normalized of provider.normalizeMessage(raw, sessionId)) send(normalized);
          } });
          mt.sessions.upsertSession({ ...scope, providerSessionId: sessionId, summary: row.summary, status: 'completed', metadata: JSON.parse(row.metadata_json || '{}') });
          send({ id: randomUUID(), kind: 'complete', sessionId, provider: 'claude', exitCode: 0, success: true, aborted: false });
        } finally {
          active.delete(sessionId);
        }
      });
    } catch (error) {
      console.error('[ForkFixtureWS]', error.message);
      send({ id: randomUUID(), kind: 'error', provider: 'claude', sessionId: message?.options?.sessionId, error: error.message, content: error.message });
      send({ id: randomUUID(), kind: 'complete', provider: 'claude', sessionId: message?.options?.sessionId, exitCode: 1, success: false });
    }
  });
});

const entry = '/__fork-test__/entry.js';
const entrySource = `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from '/src/App.tsx'; import '/src/index.css'; localStorage.setItem('i18nextLng','zh-CN'); localStorage.setItem('tasks-enabled','false'); createRoot(document.getElementById('root')).render(React.createElement(App));`;
const vite = await createViteServer({ root: appRoot, configFile: false, envFile: false, publicDir: false,
  cacheDir: path.join(temporary, 'vite'), appType: 'custom',
  plugins: [react(), { name: 'session-fork-fixture', resolveId: id => id === entry ? entry : null, load: id => id === entry ? entrySource : null }],
  define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
  resolve: { alias: { '@': path.join(appRoot, 'src') } },
  server: { middlewareMode: true, hmr: { server: http, host: '127.0.0.1', port }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'],
    fs: { allow: [appRoot, temporary], deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.sqlite*', '**/.git/**'] } },
});
for (const route of ['/', '/session/:id', '/data-agent', '/data-agent/*']) app.get(route, async (req, res, next) => {
  try {
    res.type('html').send(await vite.transformIndexHtml(req.path, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分支到新聊天 · 隔离页面验收</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`));
  } catch (error) { next(error); }
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());
// Explicitly serve only the assets referenced by the app's provider logo and
// authentication components; publicDir stays disabled for every other file.
for (const asset of ['logo.svg', 'icons/claude-ai-icon.svg', 'icons/codex.svg', 'icons/codex-white.svg',
  'icons/cursor.svg', 'icons/cursor-white.svg', 'icons/gemini-ai-icon.svg']) {
  app.get(`/${asset}`, (_req, res) => res.sendFile(path.join(appRoot, 'public', asset)));
}
app.use((req, res, next) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); } catch { return res.sendStatus(400); }
  if (pathname.includes('..') || /(?:^|\/)\.[^/]/.test(pathname.replaceAll('/.vite/', '/vite/').replaceAll('/.pnpm/', '/pnpm/')) || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(pathname)) return res.sendStatus(404);
  if (pathname.startsWith('/@fs/')) {
    const target = pathname.slice(4);
    if (![`${appRoot}/src/`, `${appRoot}/shared/`, `${appRoot}/node_modules/`, `${temporary}/vite/`].some(prefix => target.startsWith(prefix))) return res.sendStatus(404);
  } else if (![entry, '/src/', '/shared/', '/node_modules/', '/@vite/', '/@id/', '/@react-refresh'].some(prefix => pathname.startsWith(prefix))) return res.sendStatus(404);
  next();
});
app.use(vite.middlewares);
app.use((error, _req, res, _next) => { console.error(error); res.status(error.statusCode || 500).json({ error: error.message }); });
await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
console.log(JSON.stringify({ fixture: origin, username: 'fork-browser', password: 'fixture-only',
  original: `${origin}/session/${sourceSessionId}`, dataAgent: `${origin}/data-agent/session/${sourceSessionId}`,
  incomplete: `${origin}/session/${incompleteSessionId}`, evidence: `${origin}/__fork-test__/evidence`, temporary }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  for (const ws of webSockets.clients) ws.terminate();
  await browserModel?.close();
  await vite.close();
  http.close();
  database.close();
  await rm(temporary, { recursive: true, force: true });
  process.exit(0);
});
