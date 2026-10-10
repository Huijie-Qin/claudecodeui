import { createHash, randomUUID } from 'node:crypto';

const fail = (message, statusCode, code) => Object.assign(new Error(message), { statusCode, code });
const fields = { title: 120, description: 2000, markdown: 65536 };

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('片段内容无效。', 400, 'SNIPPET_INVALID');
  const result = {};
  for (const [key, limit] of Object.entries(fields)) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0')) {
      throw fail('名称、用途说明和 Markdown 正文均不能为空。', 400, 'SNIPPET_INVALID');
    }
    if (Buffer.byteLength(input[key], 'utf8') > limit) throw fail(`${key} 超过 ${limit} 字节限制。`, 413, 'SNIPPET_TOO_LARGE');
    result[key] = key === 'markdown' ? input[key] : input[key].trim();
  }
  return result;
}

export function createSkillSnippetService(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_snippets (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, markdown TEXT NOT NULL,
      created_by INTEGER NOT NULL, updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_snippet_audit (
      id INTEGER PRIMARY KEY, snippet_id TEXT NOT NULL, action TEXT NOT NULL,
      user_id INTEGER NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const project = (row) => row && ({ id: row.id, title: row.title, description: row.description, markdown: row.markdown,
    createdAt: row.created_at, updatedAt: row.updated_at, contentHash: row.content_hash });
  const get = (id) => {
    const row = db.prepare('SELECT * FROM skill_snippets WHERE id=?').get(id);
    if (!row) throw fail('片段不存在或已删除。', 404, 'SNIPPET_NOT_FOUND');
    return project(row);
  };
  const check = (current, ifMatch) => {
    if (!ifMatch) throw fail('缺少并发校验信息，请重新打开片段。', 428, 'SNIPPET_PRECONDITION_REQUIRED');
    if (ifMatch !== `"${current.contentHash}"`) throw fail('片段已被其他管理员修改，请重新加载后再操作。', 412, 'SNIPPET_CONFLICT');
  };
  const audit = (id, action, userId, hash, time) => db.prepare(
    'INSERT INTO skill_snippet_audit(snippet_id,action,user_id,content_hash,created_at) VALUES(?,?,?,?,?)',
  ).run(id, action, userId, hash, time);
  return {
    get,
    list(q = '') {
      if (typeof q !== 'string' || q.length > 500) throw fail('搜索词过长或无效。', 400, 'SNIPPET_INVALID_QUERY');
      const query = q.trim().normalize('NFC').toLowerCase();
      return db.prepare('SELECT * FROM skill_snippets ORDER BY updated_at DESC, id').all().map(project)
        .filter((item) => [item.title, item.description, item.markdown].some((value) => value.normalize('NFC').toLowerCase().includes(query)));
    },
    create: db.transaction((input, userId) => {
      const value = validate(input);
      const id = randomUUID();
      const time = new Date().toISOString();
      const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex');
      db.prepare('INSERT INTO skill_snippets VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, value.title, value.description, value.markdown, userId, userId, time, time, hash);
      audit(id, 'create', userId, hash, time);
      return get(id);
    }),
    update: db.transaction((id, input, userId, ifMatch) => {
      const current = get(id);
      check(current, ifMatch);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('片段内容无效。', 400, 'SNIPPET_INVALID');
      const value = validate({ ...current, ...input });
      const time = new Date().toISOString();
      // Include the previous digest to reject stale writes even after A -> B -> A edits.
      const hash = createHash('sha256').update(JSON.stringify([current.contentHash, value])).digest('hex');
      db.prepare('UPDATE skill_snippets SET title=?,description=?,markdown=?,updated_by=?,updated_at=?,content_hash=? WHERE id=?')
        .run(value.title, value.description, value.markdown, userId, time, hash, id);
      audit(id, 'update', userId, hash, time);
      return get(id);
    }),
    remove: db.transaction((id, userId, ifMatch) => {
      const current = get(id);
      check(current, ifMatch);
      db.prepare('DELETE FROM skill_snippets WHERE id=?').run(id);
      audit(id, 'delete', userId, current.contentHash, new Date().toISOString());
    }),
  };
}
