import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { createSkillSnippetService } from './skill-snippets.js';

const draft = { title: '数据规范', description: '用于报告', markdown: '## Evidence\n请引用原始数据，不要推算。' };
const etag = (item) => `"${item.contentHash}"`;

test('shared catalog persists fixed Markdown and searches all fields without SQL wildcard semantics', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = createSkillSnippetService(db);
  const item = service.create(draft, 7);
  assert.equal(service.list('数据规范')[0].id, item.id);
  assert.equal(service.list('报告')[0].id, item.id);
  assert.equal(service.list('EVIDENCE')[0].id, item.id);
  assert.equal(service.list('%').length, 0);
  assert.equal(service.list("' OR 1=1 --").length, 0);
  assert.equal(createSkillSnippetService(db).get(item.id).markdown, draft.markdown);
  assert.equal(db.prepare('SELECT created_by FROM skill_snippets').get().created_by, 7);
});

test('update and delete require current If-Match; stale writes including ABA cannot overwrite', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = createSkillSnippetService(db);
  const original = service.create(draft, 1);
  assert.throws(() => service.update(original.id, draft, 2), { statusCode: 428 });
  const updated = service.update(original.id, { markdown: 'updated' }, 2, etag(original));
  assert.throws(() => service.update(original.id, draft, 1, etag(original)), { statusCode: 412 });
  assert.throws(() => service.remove(original.id, 1, etag(original)), { statusCode: 412 });
  const restored = service.update(original.id, draft, 2, etag(updated));
  assert.notEqual(restored.contentHash, original.contentHash);
  assert.throws(() => service.remove(original.id, 1, '*'), { statusCode: 412 });
  service.remove(original.id, 2, etag(restored));
  assert.throws(() => service.get(original.id), { statusCode: 404 });
  assert.equal(service.list().length, 0);
  assert.deepEqual(db.prepare('SELECT action,user_id FROM skill_snippet_audit ORDER BY id').all(), [
    { action: 'create', user_id: 1 }, { action: 'update', user_id: 2 }, { action: 'update', user_id: 2 }, { action: 'delete', user_id: 2 },
  ]);
});

test('invalid fields, oversized UTF-8 and malformed searches are rejected atomically', (t) => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const service = createSkillSnippetService(db);
  for (const input of [null, [], {}, { ...draft, title: ' ' }, { ...draft, markdown: 1 }, { ...draft, description: '\0' }]) {
    assert.throws(() => service.create(input, 1), { statusCode: 400 });
  }
  assert.throws(() => service.create({ ...draft, title: '中'.repeat(41) }, 1), { statusCode: 413 });
  assert.throws(() => service.create({ ...draft, markdown: 'a'.repeat(65537) }, 1), { statusCode: 413 });
  assert.throws(() => service.list(['invalid']), { statusCode: 400 });
  assert.equal(service.list().length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM skill_snippet_audit').get().n, 0);
});
