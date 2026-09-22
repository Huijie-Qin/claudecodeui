import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createSkillEvaluationsRouter } from '../../routes/skill-evaluations.js';

async function fixture(t, service, role = 'owner') {
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 7 }; next(); });
  app.use(createSkillEvaluationsRouter({ service,
    tenantMiddleware: (req, res, next) => { req.tenant = { id: 2 }; next(); },
    access: { requireWorkspace: (args) => {
      if (args.requireEdit && role === 'view') throw Object.assign(new Error('Read only'), { statusCode: 403 });
      return { workspace: { path: '/tmp/test' }, accessRole: role };
    } },
  }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (url, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
test('read-only users can inspect cases but cannot start, cancel, generate, mutate or upload', async (t) => {
  const request = await fixture(t, { listCases: async () => ({ document: { evals: [] } }) }, 'view');
  assert.equal((await request('/9/skills/example/eval-cases')).status, 200);
  for (const url of ['/9/skills/example/evaluations', '/9/skill-jobs/job/cancel', '/9/skills/example/eval-case-jobs', '/9/skills/example/eval-cases', '/9/skills/example/eval-inputs', '/9/skills/example/eval-cases/from-invocation']) assert.equal((await request(url, 'POST', {})).status, 403);
});
test('start uses server-owned identity and returns an asynchronous job', async (t) => {
  let received;
  const request = await fixture(t, { start: async (scope) => { received = scope; return { id: 'job' }; } });
  const response = await request('/9/skills/example/evaluations', 'POST', { tenantId: 999, userId: 999 });
  assert.equal(response.status, 202); assert.equal(received.tenantId, 2); assert.equal(received.userId, 7); assert.equal(received.workspaceId, 9);
});
test('replaced report returns 410 and artifact downloads cannot execute inline', async (t) => {
  const request = await fixture(t, { get: () => { throw Object.assign(new Error('Replaced'), { statusCode: 410, code: 'EVAL_REPLACED' }); }, artifact: async () => Buffer.from('<script>bad()</script>') });
  assert.equal((await request('/9/skill-jobs/old')).status, 410);
  const response = await request('/9/skill-jobs/current/artifacts/1?name=output.html');
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-disposition'), 'attachment'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
