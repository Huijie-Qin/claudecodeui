import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import matter from 'gray-matter';

import { fail, hash, redact } from '../skill-evals/contracts.js';
import { withSkillLock } from '../skill-evals/coordination.js';
import { applyWorkspaceOwnership } from '../workspace-ownership.js';

import { validateCreatedSkill } from './creator.js';

const active = new Set(['queued', 'selecting', 'generating', 'saving', 'cancelling']);
export function createSkillCreationService({ db, creator, listSnippets, authorize, authorizeSession = () => {}, own = applyWorkspaceOwnership, registerConversation = () => null, onConversationBound = () => {} }) {
  db.exec(`CREATE TABLE IF NOT EXISTS skill_creation_jobs (
    id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    request_id TEXT NOT NULL, conversation_key TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE(tenant_id,workspace_id,user_id,request_id)
  )`);
  const controllers = new Map(), tasks = new Map(); let recovering;
  const save = (job) => db.prepare('UPDATE skill_creation_jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
  const publicJob = ({ id, requestId, conversationKey, sessionId, provider, description, status, createdAt, completedAt, result, error }) => ({ id, requestId, conversationKey, sessionId, provider, description, status, createdAt, completedAt, result, error });
  function get(scope, id) {
    authorize(scope, false);
    const row = db.prepare('SELECT data FROM skill_creation_jobs WHERE id=? AND tenant_id=? AND workspace_id=? AND user_id=?').get(id, scope.tenantId, scope.workspaceId, scope.userId);
    if (!row) throw fail('创建任务不存在。', 'CREATION_NOT_FOUND', 404);
    return JSON.parse(row.data);
  }
  function check(job, signal) { if (signal?.aborted || JSON.parse(db.prepare('SELECT data FROM skill_creation_jobs WHERE id=?').get(job.id).data).status === 'cancelling') throw fail('已取消创建。', 'CREATION_CANCELLED'); const permission = authorize(job, true); if (permission?.workspace?.path && path.resolve(permission.workspace.path) !== path.resolve(job.workspacePath)) throw fail('工作区路径已改变，请重新创建。'); authorizeSession(job); }
  async function runtimeRoot(workspacePath) {
    const workspace = await fs.realpath(workspacePath);
    let current = workspace;
    for (const segment of ['.claude', 'skills']) {
      current = path.join(current, segment);
      try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('技能目录不能是符号链接。');
    }
    return current;
  }
  async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  async function commit(job, generated, signal) {
    return withSkillLock(job.workspacePath, '*', async () => {
      check(job, signal);
      const root = await runtimeRoot(job.workspacePath);
      const parsed = validateCreatedSkill(generated.markdown);
      let name = parsed.name, suffix = 1;
      while (await exists(path.join(root, name)) || await exists(path.join(job.workspacePath, '.cloudcli/skills/sources', name))) {
        if (++suffix > 10000) throw fail('无法分配唯一技能名称。');
        name = `${parsed.name.slice(0, 58)}-${suffix}`;
      }
      const data = matter(parsed.markdown);
      const markdown = matter.stringify(data.content.replaceAll(`.claude/skills/${parsed.name}/`, `.claude/skills/${name}/`), { ...data.data, name });
      const evals = JSON.stringify({ skill_name: name, evals: [] }, null, 2) + '\n';
      const staged = path.join(root, `.creation-${job.id}.stage`), target = path.join(root, name);
      job.result = { name, path: `.claude/skills/${name}/SKILL.md`, snippets: generated.snippets || [], note: generated.note || '' };
      job.commit = { staged, target, markdownHash: hash(markdown), evalsHash: hash(evals) };
      job.status = 'saving'; save(job);
      try {
        await fs.mkdir(staged, { mode: 0o700 });
        await fs.mkdir(path.join(staged, 'evals'));
        await fs.writeFile(path.join(staged, 'SKILL.md'), markdown, { flag: 'wx', mode: 0o600 });
        await fs.writeFile(path.join(staged, 'evals/evals.json'), evals, { flag: 'wx', mode: 0o600 });
        await own({ workspaceRoot: job.workspacePath, targetPaths: [staged], recursive: true, reason: 'skill_creation' });
        check(job, signal);
        if (await exists(target)) throw fail('同名技能已被创建，请重试。', 'CREATION_NAME_CONFLICT', 409);
        await fs.rename(staged, target);
        // Journal precedes rename; restart can recognize the committed files without generating twice.
        job.status = 'completed'; job.completedAt = new Date().toISOString(); delete job.snippets; save(job);
      } finally { await fs.rm(staged, { recursive: true, force: true }); }
    });
  }
  async function reconcile(job) {
    if (!job.commit) return false;
    try {
      const [markdown, evals] = await Promise.all([fs.readFile(path.join(job.commit.target, 'SKILL.md')), fs.readFile(path.join(job.commit.target, 'evals/evals.json'))]);
      if (hash(markdown) === job.commit.markdownHash && hash(evals) === job.commit.evalsHash) {
        job.status = 'completed'; job.completedAt = new Date().toISOString(); delete job.snippets; save(job); return true;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return false;
  }
  async function run(job) {
    const controller = new AbortController(); controllers.set(job.id, controller);
    let interruption;
    const timer = setTimeout(() => { interruption = fail('创建超时，请缩小需求后重试。', 'CREATION_TIMEOUT'); controller.abort(); }, 10 * 60 * 1000);
    const permissions = setInterval(() => { try { check(job, controller.signal); } catch (error) { interruption = error; controller.abort(); } }, 3000);
    try {
      check(job, controller.signal);
      const generated = await creator({ scope: job, description: job.description, snippets: job.snippets, signal: controller.signal,
        onPhase: (status) => { check(job, controller.signal); job.status = status; save(job); } });
      await commit(job, generated, controller.signal);
    } catch (error) {
      if (!await reconcile(job)) {
        const reason = interruption || error;
        job.status = reason.code === 'CREATION_CANCELLED' || (controller.signal.aborted && !interruption) ? 'cancelled' : 'failed'; job.error = redact(reason.message);
        job.completedAt = new Date().toISOString(); delete job.result; delete job.snippets; save(job);
      }
    } finally { clearTimeout(timer); clearInterval(permissions); controllers.delete(job.id); }
  }
  function persistConversation(job) {
    if (job.sessionId && !job.sessionId.startsWith('pending:')) return;
    const sessionId = registerConversation(job);
    if (!sessionId) return;
    job.sessionId = sessionId;
    job.conversationKey = `${job.provider}:${sessionId}`;
    db.prepare('UPDATE skill_creation_jobs SET conversation_key=?,data=? WHERE id=?').run(job.conversationKey, JSON.stringify(job), job.id);
  }
  async function recover() {
    for (const { data } of db.prepare('SELECT data FROM skill_creation_jobs').all()) {
      const job = JSON.parse(data);
      // Recover old draft-only records into searchable, durable conversations too.
      try { persistConversation(job); } catch { /* Removed workspaces/users must not block server startup. */ }
      if (!active.has(job.status)) continue;
      if (!await reconcile(job)) { job.status = 'failed'; job.error = '服务已重启，创建未完成。可以重试。'; delete job.result; delete job.snippets; save(job); }
      if (job.commit?.staged) await fs.rm(job.commit.staged, { recursive: true, force: true });
    }
  }
  return {
    ready() { return recovering ||= recover(); },
    async start(scope, input) {
      await this.ready(); authorize(scope, true);
      if (input?.intent !== 'create-skill' || typeof input.description !== 'string' || !input.description.trim() || input.description.length > 20000
        || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId || '') || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.conversationKey || '')
        || !['claude', 'codex', 'cursor', 'gemini'].includes(input.provider)) throw fail('请填写有效的技能描述。');
      if (redact(input.description) !== input.description) throw fail('描述包含疑似凭据，请移除后再创建。');
      const requestHash = hash(JSON.stringify([input.description, input.conversationKey, input.sessionId || null, input.provider]));
      const existing = db.prepare('SELECT data FROM skill_creation_jobs WHERE tenant_id=? AND workspace_id=? AND user_id=? AND request_id=?').get(scope.tenantId, scope.workspaceId, scope.userId, input.requestId);
      if (existing) { const job = JSON.parse(existing.data); if (job.requestHash !== requestHash) throw fail('请求标识已用于不同内容。', 'CREATION_CONFLICT', 409); return publicJob(job); }
      const job = { ...scope, id: randomUUID(), requestId: input.requestId, requestHash, conversationKey: input.conversationKey,
        sessionId: input.sessionId || null, provider: input.provider, description: input.description, status: 'queued', createdAt: new Date().toISOString() };
      authorizeSession(job);
      const jobs = db.prepare('SELECT data FROM skill_creation_jobs WHERE tenant_id=? AND workspace_id=? AND user_id=?').all(scope.tenantId, scope.workspaceId, scope.userId).map((row) => JSON.parse(row.data));
      if (jobs.some((j) => active.has(j.status))) throw fail('当前工作区已有技能创建任务，请等待完成。', 'CREATION_BUSY', 409);
      job.snippets = listSnippets();
      if (Buffer.byteLength(JSON.stringify(job.snippets)) > 4 * 1024 * 1024) throw fail('公共片段库过大，暂时无法完整读取，请联系管理员。');
      db.transaction(() => {
        db.prepare('INSERT INTO skill_creation_jobs VALUES (?,?,?,?,?,?,?)').run(job.id, job.tenantId, job.workspaceId, job.userId, job.requestId, job.conversationKey, JSON.stringify(job));
        persistConversation(job);
      })();
      const task = run(job); tasks.set(job.id, task); void task.finally(() => tasks.delete(job.id)).catch(() => {}); return publicJob(job);
    },
    get(scope, id) { return publicJob(get(scope, id)); },
    list(scope, conversationKey) {
      authorize(scope, false);
      return db.prepare('SELECT data FROM skill_creation_jobs WHERE tenant_id=? AND workspace_id=? AND user_id=? AND conversation_key=? ORDER BY rowid DESC').all(scope.tenantId, scope.workspaceId, scope.userId, conversationKey).map(({ data }) => publicJob(JSON.parse(data))).reverse();
    },
    bindSession(scope, { conversationKey, sessionId, provider } = {}) {
      authorize(scope, true);
      if (!['claude', 'codex', 'cursor', 'gemini'].includes(provider) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 120
        || typeof conversationKey !== 'string' || !(conversationKey.startsWith(`${provider}:draft-`) || conversationKey.startsWith(`${provider}:skill-creation:`) || conversationKey.startsWith(`${provider}:pending:`))) throw fail('会话标识无效。');
      authorizeSession({ ...scope, sessionId, provider });
      const destination = `${provider}:${sessionId}`;
      db.transaction(() => {
        const rows = db.prepare('SELECT data FROM skill_creation_jobs WHERE tenant_id=? AND workspace_id=? AND user_id=? AND conversation_key=?').all(scope.tenantId, scope.workspaceId, scope.userId, conversationKey);
        const sourceConversations = new Map();
        for (const { data } of rows) {
          const job = JSON.parse(data);
          if (active.has(job.status) || (job.sessionId && !job.sessionId.startsWith('skill-creation:') && !job.sessionId.startsWith('pending:') && job.sessionId !== sessionId)) throw fail('创建任务暂时无法关联会话。', 'CREATION_BUSY', 409);
          if (job.sessionId?.startsWith('skill-creation:') || job.sessionId?.startsWith('pending:')) { authorizeSession(job); sourceConversations.set(job.sessionId, { ...job }); }
          job.sessionId = sessionId; job.conversationKey = destination;
          db.prepare('UPDATE skill_creation_jobs SET conversation_key=?,data=? WHERE id=?').run(destination, JSON.stringify(job), job.id);
        }
        for (const source of sourceConversations.values()) onConversationBound(source, sessionId);
      })();
      return this.list(scope, destination);
    },
    cancel(scope, id) {
      authorize(scope, true); const job = get(scope, id);
      if (active.has(job.status)) { controllers.get(id)?.abort(); job.status = 'cancelling'; save(job); }
      return publicJob(job);
    },
    async stop() { for (const controller of controllers.values()) controller.abort(); await Promise.allSettled(tasks.values()); },
  };
}
