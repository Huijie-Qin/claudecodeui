#!/usr/bin/env node
// Isolated file-preview fixture: no production startup, database, .env or model calls.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import react from '@vitejs/plugin-react';
import { createServer as createViteServer } from 'vite';
import sharp from 'sharp';
import { utils, write } from 'xlsx';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'ccui-file-preview-'));
const port = Number(process.env.FILES_PREVIEW_PORT || 4403);
const origin = `http://127.0.0.1:${port}`;
const app = express();
const http = createServer(app);
const entry = '/__file_preview__/entry.js';
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const illustration = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="#e8e1ff"/><stop offset="1" stop-color="#cef5eb"/></linearGradient></defs>
  <rect width="1280" height="720" fill="url(#sky)"/>
  <circle cx="1000" cy="175" r="75" fill="#ffdd8e"/>
  <path d="M0 640 320 210 630 640ZM400 640 820 320 1150 640Z" fill="#8474cf"/>
  <path d="m236 325 84-115 88 122-85-38Z" fill="#fff"/>
  <path d="M0 560Q300 450 650 610T1280 530V720H0Z" fill="#5f9b91"/>
  <text x="70" y="95" font-family="sans-serif" font-size="38" fill="#353251">CCUI · Image preview</text>
  <text x="70" y="144" font-family="sans-serif" font-size="22" fill="#595574">1280 × 720 · PNG / SVG fixture</text>
</svg>`);
const png = await sharp(illustration).png().toBuffer();

const workbook = utils.book_new();
const summary = utils.aoa_to_sheet([
  ['项目', '数量', '单价', '日期', '备注'],
  ['图片预览', 3, 12.5, new Date('2026-09-20T00:00:00Z'), '正常文本'],
  ['工作表预览', 4, 8.25, new Date('2026-09-21T00:00:00Z'), '<script>alert("fixture")</script>'],
  ['含缓存公式', null, null, null, '缓存结果应显示 7'],
  ['无缓存公式', null, null, null, '显示公式，不进行重算'],
], { cellDates: true, dateNF: 'yyyy-mm-dd' });
summary.B4 = { t: 'n', f: 'SUM(B2:B3)', v: 7 };
summary.B5 = { t: 'n', f: 'SUM(B2:B3)' };
summary.C2.z = '0.00';
summary.C3.z = '0.00';
utils.book_append_sheet(workbook, summary, '销售概览');
utils.book_append_sheet(workbook, utils.aoa_to_sheet([]), '空白工作表');
const wide = utils.aoa_to_sheet(Array.from({ length: 1100 }, (_, row) => (
  Array.from({ length: 110 }, (_, column) => row === 0 ? `字段 ${column + 1}` : `R${row + 1}C${column + 1}`)
)));
utils.book_append_sheet(workbook, wide, '大表 1100×110');
const empty = utils.book_new();
utils.book_append_sheet(empty, utils.aoa_to_sheet([]), '空白工作表');
const files = new Map([
  ['/workspace/sample.png', { type: 'image/png', body: png }],
  ['/workspace/sample.svg', { type: 'image/svg+xml', body: illustration }],
  ['/workspace/broken.png', { type: 'image/png', body: Buffer.from('Not an image') }],
  ['/workspace/sample.xlsx', { type: workbookType, body: write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) }],
  ['/workspace/empty.xlsx', { type: workbookType, body: write(empty, { type: 'buffer', bookType: 'xlsx' }) }],
  ['/workspace/broken.xlsx', { type: workbookType, body: Buffer.from('This is not an XLSX file.') }],
  ['/workspace/oversized.xlsx', { type: workbookType, body: Buffer.alloc(11 * 1024 * 1024) }],
]);

const source = `
import React, {useEffect,useState} from 'react'; import {createRoot} from 'react-dom/client';
import '/src/i18n/config.js'; import '/src/index.css';
import '/src/features/data-agent-v2/dataAgentV2.css';
import DataAgentFileTabs from '/src/features/data-agent-v2/DataAgentFileTabs.tsx';
import {useFileEditorTabs} from '/src/features/data-agent-v2/useFileEditorTabs.ts';
import {Markdown} from '/src/components/chat/view/subcomponents/Markdown.tsx';
import {useEditorSidebar} from '/src/components/code-editor/hooks/useEditorSidebar.ts';
import EditorSidebar from '/src/components/code-editor/view/EditorSidebar.tsx';
localStorage.setItem('auth-token','fixture-only'); localStorage.setItem('currentTenantId','10');
const project={name:'demo',displayName:'文件预览示例',path:'/workspace',fullPath:'/workspace',workspaceId:42,tenantId:10,accessRole:'view'};
const samples=[['sample.png','PNG 图片'],['sample.svg','SVG 图片'],['sample.xlsx','多工作表 XLSX'],['empty.xlsx','空白 XLSX'],['broken.xlsx','损坏 XLSX'],['oversized.xlsx','超限 XLSX'],['broken.png','损坏图片'],['missing.xlsx','文件不存在']];
function Fixture(){
  const manager=useFileEditorTabs(project); const [expanded,setExpanded]=useState(false); const [dark,setDark]=useState(false); const [narrow,setNarrow]=useState(false); const [version,setVersion]=useState('v1');
  const [mobile,setMobile]=useState(()=>window.matchMedia('(max-width: 768px)').matches);
  const editor=useEditorSidebar({selectedProject:project,isMobile:mobile});
  useEffect(()=>{const media=window.matchMedia('(max-width: 768px)');const update=()=>setMobile(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useEffect(()=>{document.documentElement.classList.toggle('dark',dark);},[dark]);
  return React.createElement('div',{className:'data-agent-v2',style:{flexDirection:'column'}},
    React.createElement('header',{style:{padding:'14px 20px',borderBottom:'1px solid var(--da-border)',flexShrink:0}},
      React.createElement('div',{style:{display:'flex',gap:12,alignItems:'center',justifyContent:'space-between',marginBottom:10}},
        React.createElement('div',null,React.createElement('strong',null,'图片与 Excel 基础预览'),React.createElement('p',{style:{fontSize:12,color:'var(--da-muted)',margin:'3px 0 0'}},'本地只读示例 · v1 聊天链接与编辑器 / v2 文件 Tab')),
        React.createElement('div',{style:{display:'flex',gap:8}},
          React.createElement('button',{type:'button',className:'rounded border px-3 py-1 text-sm',onClick:()=>setVersion(value=>value==='v1'?'v2':'v1')},version==='v1'?'切换到 v2':'切换到 v1'),
          React.createElement('button',{type:'button',className:'rounded border px-3 py-1 text-sm',onClick:()=>setNarrow(value=>!value)},narrow?'完整宽度':'窄栏预览'),
          React.createElement('button',{type:'button',className:'rounded border px-3 py-1 text-sm',onClick:()=>setDark(value=>!value)},dark?'浅色模式':'深色模式'))),
      React.createElement('div',{style:{display:'flex',gap:6,flexWrap:'wrap'}},samples.map(([file,label])=>React.createElement('button',{key:file,type:'button',className:'rounded border px-3 py-1 text-sm hover:bg-muted',onClick:()=>version==='v1'?editor.handleFileOpen('/workspace/'+file,null,'files'):manager.openFile('/workspace/'+file)},label)))),
    React.createElement('div',{style:{display:'flex',flex:1,minHeight:0,width:narrow?380:'100%',maxWidth:'100%',alignSelf:'center',borderLeft:'1px solid var(--da-border)',borderRight:'1px solid var(--da-border)'}},
      version==='v1'?React.createElement(React.Fragment,null,
        React.createElement('section',{style:{width:280,minWidth:180,padding:20,overflow:'auto'}},
          React.createElement('h2',{className:'mb-3 font-semibold'},'v1 聊天文件预览'),
          React.createElement(Markdown,{onFileOpen:path=>editor.handleFileOpen(path,null,'chat')},'[打开生成的图片](/workspace/sample.png)\\n\\n[打开生成的工作簿](/workspace/sample.xlsx)\\n\\n[外部网站](https://example.com/report.xlsx)')),
        React.createElement(EditorSidebar,{...editor,onResizeStart:editor.handleResizeStart,onCloseEditor:editor.handleCloseEditor,onToggleEditorExpand:editor.handleToggleEditorExpand,isMobile:mobile,projectPath:project.path,isReadOnly:true,fillSpace:true,onOpenFile:path=>editor.handleFileOpen(path,null,'chat')})):
        React.createElement(DataAgentFileTabs,{manager,project,isReadOnly:true,isMobile:mobile,expanded,onToggleExpand:()=>setExpanded(value=>!value)})));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;

const vite = await createViteServer({
  root, configFile: false, envFile: false, publicDir: false, cacheDir: path.join(temporary, 'vite'), appType: 'custom',
  plugins: [react(), { name: 'file-preview-fixture', resolveId: (id) => id === entry ? entry : null, load: (id) => id === entry ? source : null }],
  define: { 'import.meta.env.VITE_IS_PLATFORM': '"false"', 'import.meta.env.SQL_CHECK_BASE_URL': '""' },
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { middlewareMode: true, hmr: { server: http, host: '127.0.0.1', port }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], fs: { allow: [root, temporary], deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.sqlite*', '**/.git/**'] } },
});
app.use((req, res, next) => {
  if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/api/projects/:name/files/content', (req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-only') return res.status(401).json({ error: '此预览需要示例登录凭证' });
  if (req.params.name !== 'demo' || req.query.workspaceId !== '42' || req.query.tenantId !== '10') return res.status(403).json({ error: '工作区或租户不匹配' });
  const file = files.get(req.query.path);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Length', file.body.length);
  res.send(file.body);
});
app.use('/api', (_req, res) => res.status(404).json({ error: '此只读预览不提供该功能' }));
app.get('/', async (_req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>文件预览 · 仅示例数据</title></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`)); } catch (error) { next(error); }
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
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await close(); process.exit(0); });
try {
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  console.log(`File preview fixture: ${origin}`);
} catch (error) {
  await close();
  throw error;
}
