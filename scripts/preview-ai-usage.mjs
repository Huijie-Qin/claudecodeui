#!/usr/bin/env node
// Development-only fixture. Never imported by the production server.
// No business database, .env file, model, scheduler, or real user session is used.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';

import { createAiUsageAccessService } from '../server/services/ai-usage-access.js';
import { createAiUsageQueryService } from '../server/services/ai-usage-query.js';
import { readAiUsageConfig } from '../server/services/ai-usage-config.js';
import { runAiUsageWindow } from '../server/services/ai-usage-batches.js';
import { seedAiUsageSimulation, simulationCounts, simulationNight } from '../server/services/ai-usage-simulation-fixture.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entryId = '/__preview__/entry.js';
const scheduleStatus = () => ({ enabled: true, state: 'waiting', runAt: '02:00', windowEnd: '06:00', timeZone: 'Asia/Shanghai', nextRunAt: '2026-09-13T18:00:00.000Z' });

export async function createPreviewDatabase(nativeBinding, { seedCodeHub = false } = {}) {
  const db = new Database(':memory:', nativeBinding ? { nativeBinding } : {});
  try {
    seedAiUsageSimulation(db);
    db.exec("INSERT INTO users VALUES(1,'系统管理员',1,1)");
    if (seedCodeHub) {
      db.exec(`CREATE TABLE ai_mr_submissions(id INTEGER PRIMARY KEY,tenant_id,user_id,workspace_id,repository_url,commit_sha,additions,deletions,status,merged_at,created_at);
        INSERT INTO ai_mr_submissions VALUES
          (1,10,100,10,'https://example.invalid/demo/sql-project','sample-mr-1',50,100,'merged','2026-09-11T16:01:00Z','2026-09-01 00:00:00'),
          (2,10,101,11,'https://example.invalid/demo/sql-project','sample-mr-2',40,10,'merged','2026-09-12T01:00:00Z','2026-09-01 00:00:00'),
          (3,10,100,10,'https://example.invalid/demo/sql-project','sample-pending',9999,0,'opened',NULL,'2026-09-01 00:00:00');`);
    }
    const result = await runAiUsageWindow({ database: db, config: readAiUsageConfig({ AI_USAGE_ENABLED: 'true' }), now: simulationNight });
    assert.equal(result.published, 1, JSON.stringify(result));
    // The empty fixture tenant was excluded from the simulated nightly run.
    db.exec("UPDATE tenants SET status='active' WHERE id=20");
    const accessService = createAiUsageAccessService({ db });
    const queryService = createAiUsageQueryService({ db, getScheduleStatus: scheduleStatus });
    const access = accessService.resolve({ tenantId: 10, userId: 2 });
    assert.equal(queryService.skills(access, { pageSize: 100 }).total, simulationCounts.skills);
    assert.equal(queryService.hookRecords(access, 'hook-session-a').total, 400);
    return { db, accessService, queryService };
  } catch (error) { db.close(); throw error; }
}

const previewEntry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import i18n from '/src/i18n/config.js';
import AiUsagePanel from '/src/components/ai-usage/AiUsagePanel.tsx';
import '/src/index.css';
function Preview() {
  const [tenantId, setTenantId] = useState(10);
  const [userId, setUserId] = useState(2);
  const [dark, setDark] = useState(false);
  const selectUser = (value) => { document.cookie = 'ai-usage-preview-user=' + value + '; Path=/; SameSite=Strict'; setUserId(Number(value)); };
  return React.createElement('div', { className: 'min-h-screen bg-background text-foreground' },
    React.createElement('header', { style: { position: 'sticky', top: 0, zIndex: 30, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 20px', background: '#fff7ed', color: '#9a3412', borderBottom: '1px solid #fed7aa', fontSize: 13 } },
      React.createElement('strong', null, '仅测试数据 · 内存数据库 · 非真实业务报表'),
      React.createElement('span', null, '3,556 条模拟业务数据 · 已跑夜间统计 · 本人跨日 5 分钟'),
      React.createElement('select', { 'aria-label': '预览租户', value: tenantId, onChange: (event) => setTenantId(Number(event.target.value)), style: { padding: 6, borderRadius: 6 } },
        React.createElement('option', { value: 10 }, '示例租户（已发布）'), React.createElement('option', { value: 20 }, '空租户（尚未统计）')),
      React.createElement('select', { 'aria-label': '预览身份', value: userId, onChange: (event) => selectUser(event.target.value), style: { padding: 6, borderRadius: 6 } },
        React.createElement('option', { value: 1 }, '系统管理员'), React.createElement('option', { value: 2 }, '租户管理员'), React.createElement('option', { value: 3 }, '普通用户')),
      React.createElement('button', { onClick: () => { document.documentElement.classList.toggle('dark', !dark); setDark(!dark); }, style: { padding: 6, border: '1px solid #fdba74', borderRadius: 6 } }, dark ? '浅色' : '深色')
    ),
    React.createElement(AiUsagePanel, { key: tenantId + ':' + userId, tenantId })
  );
}
document.cookie = 'ai-usage-preview-user=2; Path=/; SameSite=Strict';
createRoot(document.getElementById('root')).render(React.createElement(I18nextProvider, { i18n }, React.createElement(Preview)));
`;

export async function startAiUsagePreview({ port = 4399, nativeBinding = process.env.AI_USAGE_PREVIEW_NATIVE_BINDING, seedCodeHub = false } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Preview port must be between 1024 and 65535');
  const { db, accessService } = await createPreviewDatabase(nativeBinding, { seedCodeHub });
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), 'ccui-ai-usage-preview-'));
  const dependencyRoot = await realpath(path.join(projectRoot, 'node_modules'));
  const app = express();
  const httpServer = createHttpServer(app);
  const vite = await createViteServer({
    root: projectRoot, configFile: false, envFile: false, envDir: false, publicDir: false,
    cacheDir: cacheDirectory, appType: 'custom',
    plugins: [react(), { name: 'ai-usage-fixture-entry', resolveId: (id) => id === entryId ? entryId : null, load: (id) => id === entryId ? previewEntry : null }],
    define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
    resolve: { alias: { '@': path.join(projectRoot, 'src') } },
    server: { middlewareMode: true, hmr: { server: httpServer, host: '127.0.0.1', port }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], fs: { allow: [projectRoot, cacheDirectory, dependencyRoot], deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.sqlite*', '**/.git/**'] } },
  });
  const origin = `http://127.0.0.1:${port}`;
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.status(403).send('Preview is restricted to its loopback origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-AI-Usage-Preview', 'fixture-only');
    next();
  });
  let routerFactory;
  let reportRouter;
  app.use('/api/ai-usage', express.json({ limit: '16kb' }), (req, res, next) => {
    const match = String(req.headers.cookie || '').match(/(?:^|;\s*)ai-usage-preview-user=(1|2|3)(?:;|$)/);
    req.user = { id: Number(match?.[1] || 2) }; // Isolated fixture identity; never a real auth bypass.
    next();
  }, async (req, res, next) => {
    try {
      // Development-only SSR loading lets backend report edits take effect
      // without stopping the preview or discarding its in-memory nightly batch.
      const { createAiUsageRouter } = await vite.ssrLoadModule('/server/routes/ai-usage.js');
      if (routerFactory !== createAiUsageRouter) {
        routerFactory = createAiUsageRouter;
        reportRouter = createAiUsageRouter({ db, accessService, getScheduleStatus: scheduleStatus });
      }
      reportRouter(req, res, next);
    } catch (error) { next(error); }
  });
  app.get('/', async (req, res, next) => {
    try { res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 报表 · 仅测试数据</title></head><body><div id="root"></div><script type="module" src="${entryId}"></script></body></html>`)); }
    catch (error) { next(error); }
  });
  // Only source modules/styles and dependency modules are served. Never expose
  // server sources, business data, dotfiles, or arbitrary workspace artifacts.
  app.use((req, res, next) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); } catch { return res.sendStatus(400); }
    if (pathname.includes('..') || /(?:^|\/)\.[^/]/.test(pathname.replaceAll('/.vite/', '/vite/').replaceAll('/.pnpm/', '/pnpm/')) || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(pathname)) return res.sendStatus(404);
    if (pathname.startsWith('/@fs/')) {
      const file = pathname.slice('/@fs'.length);
      if (![path.join(projectRoot, 'src') + '/', path.join(projectRoot, 'shared') + '/', path.join(projectRoot, 'node_modules') + '/', dependencyRoot + '/', cacheDirectory + '/'].some((prefix) => file.startsWith(prefix))) return res.sendStatus(404);
    } else if (![entryId, '/src/', '/shared/', '/node_modules/', '/@vite/', '/@id/', '/@react-refresh'].some((prefix) => pathname.startsWith(prefix))) return res.sendStatus(404);
    next();
  });
  app.use(vite.middlewares);
  try {
    await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    await vite.close(); db.close(); await rm(cacheDirectory, { recursive: true, force: true }); throw error;
  }
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await vite.close(); await new Promise((resolve) => httpServer.close(resolve)); db.close();
    // Exact temporary cache created above; never a workspace or user data path.
    await rm(cacheDirectory, { recursive: true, force: true });
  };
  return { url: origin, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview = await startAiUsagePreview({ port: Number(process.env.AI_USAGE_PREVIEW_PORT || 4399), seedCodeHub: process.env.AI_USAGE_PREVIEW_CODEHUB === 'true' });
  console.log(`Fixture-only AI report preview: ${preview.url}`);
  console.log('In-memory data only. No .env, business database, scheduled task, or model is used.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void preview.close().then(() => process.exit(0)); });
}
