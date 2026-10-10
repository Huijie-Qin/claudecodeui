// Local UI fixture: real routes, SQLite, worker and file commits; deterministic model responses.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Keep native statements alive in this fixture: the bundled Node runtime has a
// better-sqlite3 weak-finalizer incompatibility under Vite's memory pressure.
const retainedStatements = [];
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (...args) { const statement = prepare.apply(this, args); retainedStatements.push(statement); return statement; };

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-eval-browser-'));
process.env.DATABASE_PATH = path.join(temp, 'auth.db');
await fs.writeFile(process.env.DATABASE_PATH, '');
const { createSkillEvaluationDb } = await import('../server/database/skill-evaluation-db.js');
const { createSkillEvaluationService } = await import('../server/services/skill-evals/service.js');
const { createSkillEvaluationsRouter } = await import('../server/routes/skill-evaluations.js');
const workspacePath = path.join(temp, 'workspace'), skillRoot = path.join(workspacePath, '.claude/skills/weekly');
await fs.mkdir(skillRoot, { recursive: true });
const skill = '---\nname: weekly\ndescription: Generate a weekly report\n---\nWrite a weekly report.';
await fs.writeFile(path.join(skillRoot, 'SKILL.md'), skill);
const db = new Database(':memory:');
const service = createSkillEvaluationService({ repository: createSkillEvaluationDb(db), storageRoot: path.join(temp, 'reports'), runtime: {
  preflight: async () => ({ model: 'fixture', image: 'fixture' }), cleanupJob: async () => {},
  runCase: async ({ files, testCase, onEvent, signal }) => {
    const good = Buffer.from(files['SKILL.md'], 'base64').toString().includes('Never invent');
    const events = [];
    const append = async (event) => {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { evidence: { events, artifacts: {}, complete: false } });
      const record = { ...event, id: `message:${events.length + 1}`, seq: events.length + 1, at: new Date().toISOString() };
      events.push(record); onEvent?.(record);
      await new Promise((resolve) => setTimeout(resolve, 800));
    };
    await append({ role: 'user', kind: 'text', text: testCase.prompt });
    await append({ role: 'assistant', kind: 'text', text: '正在读取技能说明并检查本周输入数据。' });
    await append({ role: 'tool', kind: 'tool_use', tool: 'shell', input: 'cat /skill/SKILL.md' });
    await append({ role: 'tool', kind: 'tool_result', text: skill, parent: 'message:3' });
    await append({ role: 'assistant', kind: 'task_started', text: '检查数据完整性' });
    await append({ role: 'assistant', kind: 'text', text: '未找到本周数据。', parent: 'message:5' });
    await append({ role: 'assistant', kind: 'task_completed', text: '数据检查完成。', parent: 'message:5' });
    await append({ role: 'assistant', kind: 'text', text: good ? '请提供本周数据，我会据此生成周报。' : '本周收入增长了 20%。' });
    return { complete: true, events, artifacts: { 'report.md': Buffer.from('# 周报\n\n' + events.at(-1).text).toString('base64') } };
  },
  modelCall: async ({ prompt }) => {
    const data = JSON.parse(prompt);
    if (data.reports) return { structured: { reason: '补充缺少数据时的处理规则', changes: [{ path: 'SKILL.md', operation: 'write', content: skill + '\nNever invent numbers; ask for missing data.' }] } };
    if (data.existing) return { structured: { cases: [{ prompt: '生成周报，但是没有提供本周数据', expected_output: '要求提供数据，不能编造数字', files: [] }] } };
    return { structured: { checks: data.checks.map((c) => ({ id: c.id, status: data.events.some((e) => e.text?.includes('20%')) ? 'failed' : 'passed', reason: '根据实际输出核对是否编造数据', evidenceRefs: ['message:8', 'message:4', 'artifact:report.md'] })) } };
  },
} });
const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: 1 }; next(); });
app.use('/api/workspaces', createSkillEvaluationsRouter({ service, tenantMiddleware: (req, res, next) => { req.tenant = { id: 1 }; next(); }, access: { requireWorkspace: () => ({ workspace: { path: workspacePath }, accessRole: 'owner' }) } }));
const vite = await createServer({ configFile: false, plugins: [react()], resolve: { alias: { '@': path.resolve('src') } }, server: { middlewareMode: true }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/', async (req, res) => res.type('html').send(await vite.transformIndexHtml('/', `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import '/src/index.css'; import i18n from '/src/i18n/config.js'; import Panel from '/src/components/skills-market/evaluation/SkillEvaluationPanel.tsx';
i18n.changeLanguage('zh-CN'); createRoot(document.getElementById('root')).render(React.createElement(Panel,{workspaceId:1,name:'weekly',canManage:!location.search.includes('readonly'),onFilesChanged:()=>{}}));
</script></body></html>`)));
service.startWorker();
const port = Number(process.env.SKILL_EVAL_FIXTURE_PORT) || 5188;
const server = app.listen(port, '127.0.0.1', () => console.log(`Evaluation UI fixture: http://127.0.0.1:${port}`));
async function stop() { await service.stopWorker(); server.close(); await vite.close(); db.close(); await fs.rm(temp, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
