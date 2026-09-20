#!/usr/bin/env node
// Isolated UI fixture: no production auth, database, .env, schedulers or models.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
// The bundled Node 24/addon combination can crash in a GC finalizer. Keep the
// small fixture's statements alive until this preview exits (not production).
const fixtureStatements = [];
if (process.versions.node.startsWith('24.')) {
  const native = createRequire(import.meta.url)('better-sqlite3/build/Release/better_sqlite3.node');
  const prepare = native.Database.prototype.prepare;
  native.Database.prototype.prepare = function (...args) { const statement = prepare.apply(this, args); fixtureStatements.push(statement); return statement; };
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ccui-tenant-preview-'));
const importDatabasePath = path.join(temporary, 'imports.sqlite');
const importDatabase = new Database(importDatabasePath); // Prevent legacy DB migration on import.
process.env.DATABASE_PATH = importDatabasePath;
const [{ MULTITENANCY_SCHEMA_SQL }, { HOOK_CONFIG_SCHEMA_SQL }, { createHookConfigService }, { createAgentTemplateService }, { createAgentTemplateFolderAssetStore }, { createTenantManagementRouter }, { createPreviewDatabase }, { createAiUsageRouter }] = await Promise.all([
  import('../server/database/multitenancy-schema.js'), import('../server/database/hook-config-schema.js'),
  import('../server/services/hook-configs.js'), import('../server/services/agent-templates.js'),
  import('../server/services/agent-template-folder-assets.js'), import('../server/routes/tenant-management.js'),
  import('./preview-ai-usage.mjs'), import('../server/routes/ai-usage.js'),
]);
const database = new Database(':memory:');
database.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,is_active INTEGER DEFAULT 1,is_system_admin INTEGER DEFAULT 0);
  ${MULTITENANCY_SCHEMA_SQL} ${HOOK_CONFIG_SCHEMA_SQL}
  INSERT INTO users(id,username,is_system_admin) VALUES(1,'系统管理员',1),(2,'林晨 · 租户管理员',0),(3,'陈晓 · 普通成员',0);
  INSERT INTO tenants(id,code,name) VALUES(10,'example','示例租户'),(20,'other','其他租户');
  INSERT INTO tenant_users(tenant_id,user_id,role,permission,status) VALUES(10,2,'tenant_admin','edit','active'),(20,2,'member','edit','active'),(10,3,'member','edit','active');`);
const config = new Map();
const hooks = createHookConfigService({ database, configStore: { get: (key) => config.get(key), set: (key, value) => config.set(key, value) }, hookMcpCatalog: { listServers: () => [], listToolResources: () => [] } });
const templates = createAgentTemplateService(database, { folderAssets: createAgentTemplateFolderAssetStore({ rootPath: path.join(temporary, 'template-assets') }) });
const hook = hooks.createHook({ ownerTenantId: 10, userId: 2, input: { name: 'SQL 产出记录', description: '统计对话中的 SQL 产出；演示配置，不执行模型。', eventName: 'Stop', matcher: {}, extensionLogic: { language: 'javascript', code: 'export async function run() { return { output: { sqlLineCount: 0 } }; }', outputs: [{ name: 'sqlLineCount', type: 'number' }] }, postActions: [], claudeResponse: { bindings: {} } } });
hooks.publishHook({ hookId: hook.id, userId: 2 });
hooks.replaceHookBindings({ hookId: hook.id, scope: 'tenants', tenantIds: [10], defaultEnabled: false, boundBy: 2 });
templates.saveTemplate({ ownerTenantId: 10, userId: 2, input: { name: 'SQL 分析助手', category: '数据分析', claudeMarkdown: '# SQL 分析助手\n协助分析本租户的 SQL。', tenantIds: [10], skillPresetRefs: [], mcpPresetRefs: [], hookRefs: [], guideText: '请描述分析需求' } });
const report = await createPreviewDatabase();
const port = Number(process.env.TENANT_MANAGEMENT_PREVIEW_PORT || 4402);
const origin = `http://127.0.0.1:${port}`;
const app = express();
const http = createServer(app);
const entry = '/__tenant_preview__/entry.js';
const source = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route,useNavigate} from 'react-router-dom'; import {useTranslation} from 'react-i18next';
import '/src/i18n/config.js'; import '/src/index.css';
import {AuthProvider,useAuth} from '/src/components/auth/context/AuthContext.tsx';
import {TenantProvider,useTenant} from '/src/contexts/TenantContext.tsx';
import TenantManagementPage from '/src/components/tenant-management/TenantManagementPage.tsx';
import AiUsagePage from '/src/components/ai-usage/AiUsagePage.tsx';
import AdminPage from '/src/components/admin/AdminPage.tsx';
import SidebarFooter from '/src/components/sidebar/view/subcomponents/SidebarFooter.tsx';
localStorage.setItem('auth-token','fixture-only'); localStorage.setItem('currentTenantId','10');
function Shell(){const {user}=useAuth();const {tenants,currentTenant,selectTenant}=useTenant(); const nav=useNavigate();const {t}=useTranslation('sidebar');
return React.createElement('div',{className:'flex h-screen bg-background text-foreground'},React.createElement('aside',{className:'flex w-64 shrink-0 flex-col border-r border-border p-2'},React.createElement('h1',{className:'p-4 text-lg font-semibold'},'租户管理预览'),React.createElement('div',{className:'flex-1'}),React.createElement(SidebarFooter,{tenants,currentTenant,onTenantSwitch:selectTenant,t,onShowSettings:()=>{},showAdminEntry:user?.is_system_admin===1,onShowAdminPanel:()=>nav('/admin')})),React.createElement('main',{className:'max-w-3xl space-y-5 p-8'},React.createElement('h2',{className:'text-2xl font-semibold'},'租户管理功能预览'),React.createElement('p',null,'从左下角进入租户管理，可配置 Hook、查看租户 AI 使用报表、配置 Agent 模板。'),React.createElement('p',{className:'text-sm text-muted-foreground'},'仅模拟数据。管理配置和报表使用独立测试数据，修改不会触发模型执行或改变已发布报表。'),React.createElement('label',{className:'flex items-center gap-3'},'预览身份',React.createElement('select',{'aria-label':'预览身份',className:'rounded border p-2 bg-background',value:user?.id||2,onChange:e=>{document.cookie='tenant-preview-user='+e.target.value+'; Path=/; SameSite=Strict';location.href='/';}},React.createElement('option',{value:1},'系统管理员'),React.createElement('option',{value:2},'租户管理员'),React.createElement('option',{value:3},'普通成员'))),React.createElement('p',{className:'text-sm text-muted-foreground'},'系统管理员可进入 Admin → 租户权限，修改模拟成员的租户角色；再切换身份查看入口变化。')));}
createRoot(document.getElementById('root')).render(React.createElement(AuthProvider,null,React.createElement(TenantProvider,null,React.createElement(BrowserRouter,null,React.createElement(Routes,null,React.createElement(Route,{path:'/',element:React.createElement(Shell)}),React.createElement(Route,{path:'/tenant-management',element:React.createElement(TenantManagementPage)}),React.createElement(Route,{path:'/ai-usage',element:React.createElement(AiUsagePage)}),React.createElement(Route,{path:'/admin',element:React.createElement(AdminPage)}))))));
`;
const vite = await createViteServer({ root, configFile: false, envFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite'), appType: 'custom',
  plugins: [react(), { name: 'tenant-preview', resolveId: (id) => id === entry ? entry : null, load: (id) => id === entry ? source : null }],
  define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { middlewareMode: true, hmr: { server: http, host: '127.0.0.1', port }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], fs: { allow: [root, temporary], deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.sqlite*', '**/.git/**'] } },
});
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
  res.setHeader('Cache-Control', 'no-store');
  const userId = Number(String(req.headers.cookie || '').match(/(?:^|;\s*)tenant-preview-user=(1|2|3)(?:;|$)/)?.[1] || 2);
  req.user = database.prepare('SELECT * FROM users WHERE id=?').get(userId);
  next();
});
app.use(express.json({ limit: '20mb' }));
app.get('/api/auth/status', (_req, res) => res.json({ needsSetup: false }));
app.get('/api/auth/user', (req, res) => res.json({ user: req.user }));
app.get('/api/user/onboarding-status', (_req, res) => res.json({ hasCompletedOnboarding: true }));
app.get('/api/tenants/me', (req, res) => res.json({ tenants: req.user.is_system_admin ? database.prepare("SELECT *, 'system_admin' AS role, 'edit' AS permission FROM tenants").all() : database.prepare("SELECT t.*,m.role,m.permission FROM tenants t JOIN tenant_users m ON m.tenant_id=t.id WHERE m.user_id=? AND m.status='active'").all(req.user.id) }));
app.post('/api/tenants/:id/agent-list-check', (_req, res) => res.json({ success: true }));
app.use('/api/tenant-management', createTenantManagementRouter({ database, hooks, templates, skills: { listConfigurationSkills: async () => ({ skills: [] }) } }));
const reportAccess = { resolve: (input) => { const live = database.prepare('SELECT role FROM tenant_users WHERE user_id=? AND tenant_id=?').get(input.userId, input.tenantId); if (Number(input.userId) !== 1 && live?.role !== 'tenant_admin') throw Object.assign(new Error('需要租户管理员权限'), { statusCode: 403 }); return report.accessService.resolve({ ...input, userId: 2 }); } };
app.use('/api/ai-usage', createAiUsageRouter({ db: report.db, accessService: reportAccess, queryService: report.queryService }));
// Only the Admin membership UI is wired in this fixture, never other Admin actions.
app.use('/api/admin', (req, res, next) => req.user.is_system_admin ? next() : res.status(403).json({ error: 'System admin access required' }));
app.get('/api/admin/tenants', (_req, res) => res.json({ tenants: database.prepare('SELECT * FROM tenants').all() }));
app.get('/api/admin/users', (_req, res) => res.json({ users: database.prepare('SELECT * FROM users').all() }));
app.get('/api/admin/memberships', (_req, res) => res.json({ memberships: database.prepare('SELECT m.*,u.username,u.is_system_admin,t.name AS tenant_name FROM tenant_users m JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id').all() }));
app.put('/api/admin/tenants/:tenantId/users/:userId', (req, res) => {
  const previous = database.prepare('SELECT * FROM tenant_users WHERE tenant_id=? AND user_id=?').get(req.params.tenantId, req.params.userId);
  const role = req.body.role || previous?.role || 'member';
  if (!['tenant_admin', 'member'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  database.prepare("INSERT INTO tenant_users(tenant_id,user_id,role,permission,status) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,permission=excluded.permission,status=excluded.status").run(req.params.tenantId, req.params.userId, role, req.body.permission || previous?.permission || 'view', req.body.status || 'active');
  res.json({ membership: database.prepare('SELECT * FROM tenant_users WHERE tenant_id=? AND user_id=?').get(req.params.tenantId, req.params.userId) });
});
app.use('/api', (_req, res) => res.status(404).json({ error: '此预览不提供该功能' }));
for (const route of ['/', '/tenant-management', '/ai-usage', '/admin']) app.get(route, async (_req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml(route, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>租户管理 · 仅模拟数据</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`)); } catch (error) { next(error); }
});
app.use((req, res, next) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); } catch { return res.sendStatus(400); }
  if (pathname.includes('..') || /(?:^|\/)\.[^/]/.test(pathname.replaceAll('/.vite/', '/vite/').replaceAll('/.pnpm/', '/pnpm/')) || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(pathname)) return res.sendStatus(404);
  const allowed = ['/src/', '/shared/', '/node_modules/', '/@vite/', '/@id/', '/@react-refresh', entry];
  if (pathname.startsWith('/@fs/')) {
    if (![`${root}/src/`, `${root}/shared/`, `${root}/node_modules/`, `${temporary}/`].some((prefix) => pathname.slice(4).startsWith(prefix))) return res.sendStatus(404);
  } else if (!allowed.some((prefix) => pathname.startsWith(prefix))) return res.sendStatus(404);
  next();
});
app.use(vite.middlewares);
await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
console.log(`Tenant management fixture preview: ${origin}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await vite.close(); http.close(); database.close(); report.db.close(); importDatabase.close(); await rm(temporary, { recursive: true, force: true }); process.exit(0); });
