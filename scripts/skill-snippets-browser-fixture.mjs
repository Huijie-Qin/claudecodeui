// Local-only UI fixture: real snippet routes and SQLite; in-memory workspace files.
import path from 'node:path';

import Database from 'better-sqlite3';
import express from 'express';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

import { requireSystemAdmin } from '../server/middleware/system-admin.js';
import { createSkillSnippetsRouter } from '../server/routes/skill-snippets.js';
import { createSkillSnippetService } from '../server/services/skill-snippets.js';

const db = new Database(':memory:');
const service = createSkillSnippetService(db);
service.create({ title: '数据真实性', description: '生成报告时避免编造数据', markdown: '## 数据规范\n\n缺少数据时请明确说明，不要推算增长比例。\n\n- 引用原始数据\n- 标注不确定项' }, 1);
service.create({ title: '输出格式', description: '统一结果结构', markdown: '## 输出要求\n\n先给结论，再给证据和建议。' }, 1);
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 1, is_system_admin: (req.headers.cookie || '').includes('snippet-role=admin') ? 1 : 0 }; next(); });
app.use('/api', createSkillSnippetsRouter({ service, requireSystemAdmin }));
let content = '---\nname: weekly\ndescription: 每周报告\n---\n\n# 周报\n\n整理输入数据。';
const skill = { name: 'weekly', displayName: '周报', description: '片段插入验收', kind: 'unmanaged', status: 'enabled', enabled: true, manageable: true, origin: 'local', files: [{ path: 'SKILL.md', type: 'file' }] };
app.get('/api/skill-market/skills', (req, res) => res.json({ skills: [], hasMore: false }));
app.get('/api/skill-market/skills/weekly/publish-state', (req, res) => res.json({ canPublish: false }));
app.get('/api/workspaces/1/skills', (req, res) => res.json({ canManage: true, workspaceId: 1, skills: [skill,
  { ...skill, name: 'data-summary', displayName: '数据汇总', description: '整理数据并生成摘要' },
  { ...skill, name: 'imported-review', displayName: '导入的审查技能', origin: 'market', kind: 'managed', description: '已导入当前工作区的市场技能' },
  { ...skill, name: 'system-helper', kind: 'system', displayName: '系统技能（不应出现在插入列表）' },
], summary: { total: 3, local: 2, market: 1 } }));
app.get('/api/workspaces/1/mcp-tools/insertion-catalog', (req, res) => res.json({ workspaceId: 1, tools: [
  { name: 'mcp__docs__search', description: '检索资料', serverName: 'docs', serverDisplayName: '文档服务' },
  { name: 'mcp__data__query', description: '查询数据', serverName: 'data', serverDisplayName: '数据服务' },
] }));
app.get('/api/workspaces/1/skills/weekly', (req, res) => res.json({ skill }));
app.get('/api/workspaces/1/skills/weekly/files', (req, res) => res.json({ file: { path: 'SKILL.md', content } }));
app.put('/api/workspaces/1/skills/weekly/files', (req, res) => { content = req.body.content; res.json({ file: { path: 'SKILL.md', content } }); });
app.get('/api/*path', (req, res) => res.status(404).json({ error: 'Not part of this fixture' }));
const vite = await createServer({ configFile: false, plugins: [react()], resolve: { alias: { '@': path.resolve('src') } }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/', async (req, res) => {
  res.set('Set-Cookie', `snippet-role=${req.query.role === 'member' ? 'member' : 'admin'}; Path=/; SameSite=Strict`);
  res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root" style="height:100vh"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/index.css'; import '/src/i18n/config.js';
import {ThemeProvider} from '/src/contexts/ThemeContext.jsx'; import Panel from '/src/components/skills-market/SkillsWorkspacePanel.tsx';
createRoot(document.getElementById('root')).render(React.createElement(ThemeProvider,null,React.createElement(Panel,{selectedProject:{name:'snippet-demo',path:'/demo',workspaceId:1},isReadOnly:location.search.includes('readonly')})));
</script></body></html>`));
});
const port = Number(process.env.SKILL_SNIPPET_FIXTURE_PORT) || 5189;
const server = app.listen(port, '127.0.0.1', () => console.log(`Snippet UI fixture: http://127.0.0.1:${port} (add ?role=member or ?readonly)`));
async function stop() { server.close(); await vite.close(); db.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
