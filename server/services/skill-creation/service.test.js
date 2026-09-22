import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { createSkillCreationService } from './service.js';
import { createSkillCreator, validateCreatedSkill } from './creator.js';

const markdown = '---\nname: weekly-report\ndescription: Generate factual weekly reports\n---\n# Weekly report\nAsk for missing data. Never invent numbers.';
const input = (overrides = {}) => ({ intent: 'create-skill', description: '生成门店周报', requestId: randomUUID(), conversationKey: 'claude:new', provider: 'claude', ...overrides });
async function fixture(t, options = {}) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-creation-test-'));
  const db = new Database(':memory:'); let writable = true;
  const scope = { tenantId: 1, workspaceId: 1, userId: 1, workspacePath };
  const config = { db, listSnippets: () => [], creator: async () => ({ markdown, snippets: [] }), own: async () => {}, authorize: (_scope, edit) => { if (edit && !writable) throw Object.assign(new Error('Read only'), { statusCode: 403 }); }, ...options };
  const service = createSkillCreationService(config); await service.ready();
  t.after(async () => { await service.stop(); db.close(); await fs.rm(workspacePath, { recursive: true, force: true }); });
  async function finish(id) { for (let i = 0; i < 200; i++) { const job = service.get(scope, id); if (['completed', 'failed', 'cancelled'].includes(job.status)) return job; await new Promise((r) => setTimeout(r, 5)); } throw new Error('Job did not finish'); }
  return { service, scope, db, config, finish, revoke: () => { writable = false; } };
}

test('explicit creation writes a complete skill and empty evals, duplicate requests do not generate again', async (t) => {
  let calls = 0; const f = await fixture(t, { creator: async () => { calls++; return { markdown }; } }); const request = input();
  const first = await f.service.start(f.scope, request), job = await f.finish(first.id);
  assert.equal(job.status, 'completed'); assert.equal(calls, 1);
  assert.equal((await f.service.start(f.scope, request)).id, job.id); assert.equal(calls, 1);
  const root = path.join(f.scope.workspacePath, '.claude/skills/weekly-report');
  assert.match(await fs.readFile(path.join(root, 'SKILL.md'), 'utf8'), /weekly-report/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'evals/evals.json'))), { skill_name: 'weekly-report', evals: [] });
  await assert.rejects(f.service.start(f.scope, { ...request, description: 'Different' }), /请求标识/);
  assert.throws(() => f.service.get({ ...f.scope, userId: 2 }, job.id), /不存在/);
  assert.equal(f.service.list({ ...f.scope, tenantId: 2 }, 'claude:new').length, 0);
});

test('name collision preserves the original skill and assigns a consistent suffix', async (t) => {
  const f = await fixture(t); const original = await f.finish((await f.service.start(f.scope, input())).id);
  const before = await fs.readFile(path.join(f.scope.workspacePath, original.result.path), 'utf8');
  const second = await f.finish((await f.service.start(f.scope, input())).id);
  assert.equal(second.result.name, 'weekly-report-2');
  assert.equal(await fs.readFile(path.join(f.scope.workspacePath, original.result.path), 'utf8'), before);
  const root = path.dirname(path.join(f.scope.workspacePath, second.result.path));
  assert.equal(validateCreatedSkill(await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')).name, 'weekly-report-2');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'evals/evals.json'))).skill_name, 'weekly-report-2');
});

test('plain chat intent and read-only access cannot create skills', async (t) => {
  const f = await fixture(t); await assert.rejects(f.service.start(f.scope, input({ intent: 'chat' })));
  f.revoke(); await assert.rejects(f.service.start(f.scope, input()), /Read only/);
});

test('cancel and revoked permissions leave no half-created skill', async (t) => {
  let release; const f = await fixture(t, { creator: () => new Promise((resolve) => { release = () => resolve({ markdown }); }) });
  const job = await f.service.start(f.scope, input());
  await assert.rejects(f.service.start(f.scope, input()), /已有技能创建/);
  f.service.cancel(f.scope, job.id); release();
  assert.equal((await f.finish(job.id)).status, 'cancelled');
  await assert.rejects(fs.access(path.join(f.scope.workspacePath, '.claude/skills/weekly-report')));
  const next = await f.service.start(f.scope, input()); f.revoke(); release();
  assert.equal((await f.finish(next.id)).status, 'failed');
  await assert.rejects(fs.access(path.join(f.scope.workspacePath, '.claude/skills/weekly-report')));
});

test('invalid output and symlinked skill directories are rejected without external writes', async (t) => {
  const f = await fixture(t, { creator: async () => ({ markdown: markdown.replace('weekly-report', '../../escape') }) });
  assert.equal((await f.finish((await f.service.start(f.scope, input())).id)).status, 'failed');
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'creation-external-')); t.after(() => fs.rm(external, { recursive: true, force: true }));
  const g = await fixture(t); await fs.symlink(external, path.join(g.scope.workspacePath, '.claude'));
  assert.equal((await g.finish((await g.service.start(g.scope, input())).id)).status, 'failed');
  assert.deepEqual(await fs.readdir(external), []);
});

test('restart recognizes a committed journal and never repeats successful generation', async (t) => {
  const f = await fixture(t); const request = input(); const job = await f.finish((await f.service.start(f.scope, request)).id);
  const row = JSON.parse(f.db.prepare('SELECT data FROM skill_creation_jobs WHERE id=?').get(job.id).data);
  row.status = 'saving'; f.db.prepare('UPDATE skill_creation_jobs SET data=? WHERE id=?').run(JSON.stringify(row), job.id);
  const recovered = createSkillCreationService({ ...f.config, creator: () => { throw new Error('must not regenerate'); } }); await recovered.ready();
  assert.equal((await recovered.start(f.scope, request)).status, 'completed');
  assert.equal(recovered.get(f.scope, job.id).result.name, 'weekly-report');
});

test('creator considers every catalog batch and only reads frozen selected snippets', async () => {
  const snippets = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, title: `Snippet ${i}`, description: 'x'.repeat(2000), markdown: `Frozen body ${i}` }));
  const visited = []; let generation;
  const creator = createSkillCreator({ instructions: async () => 'Creator instructions', modelCall: async ({ prompt }) => {
    const value = JSON.parse(prompt);
    if (value.catalog) { visited.push(...value.catalog.map((s) => s.id)); return { structured: { selected: value.catalog.filter((s) => s.id === 's29').map((s) => ({ id: s.id, reason: '相关' })), note: '跳过无关片段' } }; }
    generation = value; return { text: markdown };
  } });
  const result = await creator({ scope: {}, description: '周报', snippets, signal: new AbortController().signal, onPhase: () => {} });
  assert.equal(visited.length, 30); assert.deepEqual(generation.references.map((s) => s.markdown), ['Frozen body 29']); assert.equal(result.snippets[0].id, 's29');
});

test('creator refuses invented snippet IDs and model failures', async () => {
  const args = { scope: {}, description: '周报', snippets: [{ id: 'real', title: 'x', description: 'y', markdown: 'z' }], signal: new AbortController().signal, onPhase: () => {} };
  const creator = createSkillCreator({ instructions: async () => '', modelCall: async () => ({ structured: { selected: [{ id: 'fake', reason: 'x' }], note: '' } }) });
  await assert.rejects(creator(args), /不存在/);
  const failing = createSkillCreator({ instructions: async () => '', modelCall: async () => { throw new Error('No credentials'); } });
  await assert.rejects(failing({ ...args, snippets: [] }), /No credentials/);
});

test('model output cannot choose executable frontmatter engines', () => {
  delete globalThis.skillCreationInjected;
  assert.throws(() => validateCreatedSkill('---js\n(globalThis.skillCreationInjected=true)\n---\nbody'), /YAML/);
  assert.equal(globalThis.skillCreationInjected, undefined);
});

test('failure during file commit cleans staging and leaves no completed skill', async (t) => {
  const f = await fixture(t, { own: async () => { throw new Error('Ownership denied'); } });
  const job = await f.finish((await f.service.start(f.scope, input())).id);
  assert.equal(job.status, 'failed'); assert.match(job.error, /Ownership denied/);
  assert.deepEqual(await fs.readdir(path.join(f.scope.workspacePath, '.claude/skills')), []);
});

test('draft jobs bind only to an owned session and cannot move between conversations', async (t) => {
  const f = await fixture(t, { authorizeSession: (scope) => { if (scope.sessionId && scope.sessionId !== 'owned') throw new Error('Not owned'); } });
  const request = input({ conversationKey: 'claude:draft-123' });
  const job = await f.finish((await f.service.start(f.scope, request)).id);
  assert.throws(() => f.service.bindSession(f.scope, { conversationKey: request.conversationKey, sessionId: 'foreign', provider: 'claude' }), /Not owned/);
  assert.equal(f.service.list(f.scope, request.conversationKey).length, 1);
  assert.equal(f.service.bindSession({ ...f.scope, userId: 2 }, { conversationKey: request.conversationKey, sessionId: 'owned', provider: 'claude' }).length, 0);
  const bound = f.service.bindSession(f.scope, { conversationKey: request.conversationKey, sessionId: 'owned', provider: 'claude' });
  assert.equal(bound[0].id, job.id); assert.equal(f.service.list(f.scope, request.conversationKey).length, 0);
  assert.equal(f.service.bindSession(f.scope, { conversationKey: request.conversationKey, sessionId: 'owned', provider: 'claude' })[0].id, job.id);
  assert.equal((await f.service.start(f.scope, request)).id, job.id);
  await assert.rejects(f.service.start(f.scope, input({ sessionId: 'foreign' })), /Not owned/);
});

test('accepted creation gets a persistent conversation before completion and survives service restart', async (t) => {
  let release; const registered = [];
  const f = await fixture(t, { registerConversation: job => { registered.push(job.id); return `skill-creation:${job.id}`; }, creator: () => new Promise(resolve => { release = () => resolve({ markdown }); }) });
  const request = input({ conversationKey: 'claude:draft-persistent' });
  const started = await f.service.start(f.scope, request);
  assert.equal(started.sessionId, `skill-creation:${started.id}`);
  assert.equal(started.conversationKey, `claude:${started.sessionId}`);
  assert.equal(f.service.list(f.scope, started.conversationKey)[0].description, request.description);
  release(); await f.finish(started.id);
  const restored = createSkillCreationService(f.config); await restored.ready();
  assert.equal(restored.list(f.scope, started.conversationKey)[0].status, 'completed');
  assert.equal((await restored.start(f.scope, request)).id, started.id);
  assert.equal(registered.length, 1);
  assert.deepEqual(restored.list({ ...f.scope, userId: 2 }, started.conversationKey), []);
});

test('legacy draft history is registered once and multiple records bind together to ordinary chat', async (t) => {
  const f = await fixture(t);
  const first = await f.finish((await f.service.start(f.scope, input({ conversationKey: 'claude:draft-legacy' }))).id);
  const second = await f.finish((await f.service.start(f.scope, input({ conversationKey: 'claude:draft-legacy' }))).id);
  let retired = false, retiredCount = 0;
  const restored = createSkillCreationService({ ...f.config,
    registerConversation: () => 'skill-creation:legacy',
    authorizeSession: job => { if (job.sessionId === 'skill-creation:legacy' && retired) throw new Error('Session retired'); },
    onConversationBound: () => { retired = true; retiredCount++; },
  });
  await restored.ready();
  assert.deepEqual(restored.list(f.scope, 'claude:skill-creation:legacy').map(job => job.id), [first.id, second.id]);
  const moved = restored.bindSession(f.scope, { conversationKey: 'claude:skill-creation:legacy', provider: 'claude', sessionId: 'native-session' });
  assert.equal(moved.length, 2); assert.equal(retiredCount, 1);
  assert.equal(restored.list(f.scope, 'claude:skill-creation:legacy').length, 0);
  assert.equal(restored.bindSession(f.scope, { conversationKey: 'claude:skill-creation:legacy', provider: 'claude', sessionId: 'native-session' }).length, 2);
});

test('previously completed jobs on hidden pending sessions register their existing conversation on startup', async (t) => {
  const f = await fixture(t);
  const job = await f.finish((await f.service.start(f.scope, input({ sessionId: 'pending:old', conversationKey: 'claude:pending:old' }))).id);
  const registered = [];
  const restored = createSkillCreationService({ ...f.config, registerConversation: job => { registered.push(job.sessionId); return job.sessionId; } });
  await restored.ready();
  assert.deepEqual(registered, ['pending:old']);
  assert.equal(restored.list(f.scope, 'claude:pending:old')[0].id, job.id);
});
