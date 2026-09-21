import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { requireSystemAdmin } from '../middleware/system-admin.js';
import { createSkillSnippetService } from '../services/skill-snippets.js';

import { createSkillSnippetsRouter } from './skill-snippets.js';

test('snippet HTTP routes enforce authentication, global reads, admin writes and conditional mutations', async (t) => {
  const db = new Database(':memory:');
  const service = createSkillSnippetService(db);
  const app = express();
  app.use(express.json());
  app.use('/api', createSkillSnippetsRouter({ service, requireSystemAdmin, authenticateToken: (req, res, next) => {
    if (req.get('X-Test-User')) req.user = { id: 1, is_system_admin: req.get('X-Test-User') === 'admin' ? 1 : 0 };
    next();
  } }));
  app.get('/api/unrelated', (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });
  t.after(() => { server.close(); db.close(); });
  const request = (path, { method = 'GET', user, body, etag } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(user ? { 'X-Test-User': user } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await request('/unrelated')).status, 200);
  assert.equal((await request('/skill-snippets')).status, 401);
  const draft = { title: '公共规范', description: '跨租户使用', markdown: 'Never invent data.' };
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal((await request(`/admin/skill-snippets${method === 'POST' ? '' : '/unknown'}`, { method, user: 'tenant-admin', body: { ...draft, is_system_admin: 1 } })).status, 403);
  }
  const created = await request('/admin/skill-snippets', { method: 'POST', user: 'admin', body: draft });
  assert.equal(created.status, 201);
  const etag = created.headers.get('etag');
  const { snippet } = await created.json();
  const list = await request('/skill-snippets?tenantId=999&q=INVENT', { user: 'member' });
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const payload = await list.json();
  assert.equal(payload.canManage, false);
  assert.deepEqual(payload.snippets.map((s) => s.id), [snippet.id]);
  const detail = await request(`/skill-snippets/${snippet.id}`, { user: 'member' });
  assert.equal(detail.headers.get('etag'), etag);
  assert.equal((await detail.json()).snippet.markdown, draft.markdown);
  assert.equal((await request(`/admin/skill-snippets/${snippet.id}`, { method: 'PATCH', user: 'admin', body: draft })).status, 428);
  const updated = await request(`/admin/skill-snippets/${snippet.id}`, { method: 'PATCH', user: 'admin', body: { markdown: 'Revised.' }, etag });
  assert.equal(updated.status, 200);
  assert.equal((await request(`/admin/skill-snippets/${snippet.id}`, { method: 'DELETE', user: 'admin', etag })).status, 412);
  assert.equal((await request(`/admin/skill-snippets/${snippet.id}`, { method: 'DELETE', user: 'admin', etag: updated.headers.get('etag') })).status, 204);
  assert.equal((await request(`/skill-snippets/${snippet.id}`, { user: 'member' })).status, 404);
});
