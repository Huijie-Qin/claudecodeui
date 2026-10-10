#!/usr/bin/env node
// Isolated UI-only fixture: no credentials, business database, .env or API writes.
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const dependencyRoot = await realpath(path.join(root, 'node_modules'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ccui-hook-bindings-preview-'));
const port = Number(process.env.HOOK_BINDINGS_PREVIEW_PORT || 4421);
const origin = `http://127.0.0.1:${port}`;
const entry = '/__hook_bindings__/entry.js';
const app = express();
const http = createServer(app);
const source = `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import i18n from '/src/i18n/config.js'; import '/src/index.css';
import HookUserBindingsDialog from '/src/components/admin/hook-config/HookUserBindingsDialog.tsx';
const hook = {id:'demo-hook',name:'会话归档与 SQL 质量检查',version:3};
const users = ['林晨','陈晓','王璐','李明','张晓宇','赵一鸣','周雨桐','吴嘉宁','郑文博','徐子涵','孙思远','已停用用户'].map((username,i)=>({id:i+1,username,isActive:i!==11,isSystemAdmin:i===0,bound:i<3}));
const tenants = ['数据研发部','产品与设计中心','业务运营部','测试租户（已停用）'].map((name,i)=>({id:i+1,name,code:['data-dev','product-design','operations','inactive'][i],active:i!==3,activeUserCount:[26,18,41,0][i],bound:i===0}));
function Preview(){
  const [open,setOpen]=useState(true),[scope,setScope]=useState('users'),[enabled,setEnabled]=useState(true),[show,setShow]=useState(true);
  const [userIds,setUserIds]=useState([1,2,3]),[tenantIds,setTenantIds]=useState([1]),[saved,setSaved]=useState(null),[error,setError]=useState(null),[saving,setSaving]=useState(false),[fail,setFail]=useState(false),[dark,setDark]=useState(false);
  const toggle=(setter,id)=>setter(ids=>ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]);
  const save=(overwrite)=>{setSaving(true);setError(null);setTimeout(()=>{setSaving(false);if(fail){setError('模拟保存失败，可保留选择后重试');return;}setSaved({scope,userIds:scope==='users'?userIds:[],tenantIds:scope==='tenants'?tenantIds:[],defaultEnabled:enabled,defaultShowInChat:show,overwriteUserPreferences:overwrite});setOpen(false);},250);};
  return React.createElement('main',{className:'min-h-screen bg-muted/30 p-8 text-foreground'},
    React.createElement('h1',{className:'text-2xl font-semibold'},'用户与启用 · 交互预览'),
    React.createElement('p',{className:'mt-2 text-sm text-muted-foreground'},'使用实际弹窗组件，仅模拟数据。保存只更新页面状态，不修改账号权限或实际配置。'),
    React.createElement('div',{className:'my-6 flex flex-wrap items-center gap-4'},
      React.createElement('button',{className:'rounded border bg-background px-4 py-2',onClick:()=>{setError(null);setOpen(true);}},'用户与启用'),
      React.createElement('label',{className:'flex items-center gap-2'},React.createElement('input',{type:'checkbox',checked:fail,onChange:e=>setFail(e.target.checked)}),'模拟保存失败'),
      React.createElement('button',{className:'rounded border bg-background px-4 py-2',onClick:()=>{document.documentElement.classList.toggle('dark',!dark);setDark(!dark);}},dark?'浅色模式':'深色模式'),
      React.createElement('button',{className:'rounded border bg-background px-4 py-2',onClick:()=>i18n.changeLanguage(i18n.language.startsWith('en')?'zh-CN':'en')},'中文 / English')),
    React.createElement('h2',{className:'font-medium'},'模拟保存参数'),React.createElement('pre',{'aria-label':'模拟保存参数',className:'mt-3 rounded border bg-background p-4'},saved?JSON.stringify(saved,null,2):'尚未保存'),
    React.createElement(HookUserBindingsDialog,{hook:open?hook:null,scope,defaultEnabled:enabled,defaultShowInChat:show,users,tenants,selectedUserIds:userIds,selectedTenantIds:tenantIds,loading:false,saving,error,
      onClose:()=>setOpen(false),onScopeChange:setScope,onDefaultEnabledChange:setEnabled,onDefaultShowInChatChange:setShow,onOverwrite:()=>save(true),onSave:()=>save(false),
      onToggle:id=>toggle(setUserIds,id),onToggleTenant:id=>toggle(setTenantIds,id),onBatchChange:(ids,selected)=>{const setter=scope==='users'?setUserIds:setTenantIds;setter(previous=>selected?[...new Set([...previous,...ids])]:previous.filter(id=>!ids.includes(id)));},
      onClear:()=>{if(scope==='all_users'){setScope('users');setUserIds([]);setTenantIds([]);}else if(scope==='users')setUserIds([]);else setTenantIds([]);}}));
}
createRoot(document.getElementById('root')).render(React.createElement(Preview));
`;
const vite = await createViteServer({ root, configFile: false, envFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite'), appType: 'custom',
  plugins: [react(), { name: 'hook-bindings-preview', resolveId: id => id === entry ? entry : null, load: id => id === entry ? source : null }],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { middlewareMode: true, hmr: { server: http, host: '127.0.0.1', port }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], fs: { allow: [root, temporary, dependencyRoot], deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.sqlite*', '**/.git/**'] } },
});
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
  res.setHeader('Cache-Control', 'no-store'); next();
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'UI-only fixture' }));
app.get('/', async (_req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>用户与启用 · 模拟预览</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`)); } catch (error) { next(error); }
});
app.use((req, res, next) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, origin).pathname); } catch { return res.sendStatus(400); }
  if (pathname.includes('..') || /(?:^|\/)\.[^/]/.test(pathname.replaceAll('/.vite/', '/vite/').replaceAll('/.pnpm/', '/pnpm/')) || /\.(?:db|sqlite|sqlite3)(?:-|$)/i.test(pathname)) return res.sendStatus(404);
  if (pathname.startsWith('/@fs/')) {
    if (![`${root}/src/`, `${root}/shared/`, `${root}/node_modules/`, `${dependencyRoot}/`, `${temporary}/`].some(prefix => pathname.slice(4).startsWith(prefix))) return res.sendStatus(404);
  } else if (!['/src/', '/shared/', '/node_modules/', '/@vite/', '/@id/', '/@react-refresh', entry].some(prefix => pathname.startsWith(prefix))) return res.sendStatus(404);
  next();
});
app.use(vite.middlewares);
await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
console.log(`Hook bindings preview: ${origin}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await vite.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
  await rm(temporary, { recursive: true, force: true }); process.exit(0);
});
