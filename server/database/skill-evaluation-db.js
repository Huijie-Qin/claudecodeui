import { fail } from '../services/skill-evals/contracts.js';

export function createSkillEvaluationDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_eval_jobs (
      id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, skill_key TEXT NOT NULL, request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, status TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(tenant_id,workspace_id,user_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS skill_eval_latest (
      tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL, skill_key TEXT NOT NULL,
      job_id TEXT NOT NULL, generation INTEGER NOT NULL,
      PRIMARY KEY(tenant_id,workspace_id,skill_key)
    );
    CREATE TABLE IF NOT EXISTS skill_eval_case_meta (
      workspace_path TEXT NOT NULL, skill_key TEXT NOT NULL, next_id INTEGER NOT NULL DEFAULT 1,
      protected_ids TEXT NOT NULL DEFAULT '[]', sources TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(workspace_path,skill_key)
    );
    CREATE INDEX IF NOT EXISTS skill_eval_queue ON skill_eval_jobs(status,deleted,created_at);
    CREATE TABLE IF NOT EXISTS skill_eval_worker (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  const key = (scope) => [scope.tenantId, scope.workspaceId, scope.name.normalize('NFC').toLowerCase()];
  const decode = (row) => row ? { ...JSON.parse(row.data), deleted: Boolean(row.deleted) } : null;
  function latest(scope) {
    return decode(db.prepare(`SELECT j.* FROM skill_eval_latest l JOIN skill_eval_jobs j ON j.id=l.job_id
      WHERE l.tenant_id=? AND l.workspace_id=? AND l.skill_key=?`).get(...key(scope)));
  }
  function duplicate(scope, requestId, requestHash) {
    const row = db.prepare('SELECT * FROM skill_eval_jobs WHERE tenant_id=? AND workspace_id=? AND user_id=? AND request_id=?')
      .get(scope.tenantId, scope.workspaceId, scope.userId, requestId);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw fail('requestId was already used for another request', 'EVAL_REQUEST_CONFLICT', 409);
    if (row.deleted) throw fail('This evaluation has been replaced', 'EVAL_REPLACED', 410);
    return decode(row);
  }
  const save = db.transaction((job) => {
    const current = db.prepare('SELECT data FROM skill_eval_jobs WHERE id=? AND deleted=0').get(job.id);
    if (current && JSON.parse(current.data).cancelRequested) job.cancelRequested = true;
    job.version = (current ? JSON.parse(current.data).version || 0 : 0) + 1;
    const result = db.prepare('UPDATE skill_eval_jobs SET status=?,data=? WHERE id=? AND deleted=0')
      .run(job.status, JSON.stringify(job), job.id);
    if (!result.changes) throw fail('This evaluation has been replaced', 'EVAL_REPLACED', 410);
  });
  const start = db.transaction((job) => {
    const existing = duplicate(job, job.requestId, job.requestHash);
    if (existing) return existing;
    const old = latest(job);
    if (db.prepare("SELECT 1 FROM skill_eval_jobs WHERE tenant_id=? AND workspace_id=? AND skill_key=? AND deleted=0 AND status IN ('queued','running','cancelling')").get(...key(job))) throw fail('This skill already has an active evaluation', 'SKILL_JOB_BUSY', 409);
    const generation = (old?.generation || 0) + 1;
    job.generation = generation;
    if (old) db.prepare('UPDATE skill_eval_jobs SET deleted=1,data=? WHERE id=?').run(JSON.stringify({ id: old.id }), old.id);
    db.prepare('INSERT INTO skill_eval_jobs VALUES (?,?,?,?,?,?,?,?,0,?,?)')
      .run(job.id, ...key(job).slice(0, 2), job.userId, key(job)[2], job.requestId, job.requestHash, job.status, JSON.stringify(job), Date.now());
    db.prepare(`INSERT INTO skill_eval_latest VALUES (?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,skill_key)
      DO UPDATE SET job_id=excluded.job_id,generation=excluded.generation`).run(...key(job), job.id, generation);
    return job;
  });
  const startAux = db.transaction((job) => {
    const existing = duplicate(job, job.requestId, job.requestHash);
    if (existing) return existing;
    const busy = db.prepare("SELECT 1 FROM skill_eval_jobs WHERE tenant_id=? AND workspace_id=? AND skill_key=? AND deleted=0 AND status IN ('queued','running','cancelling')")
      .get(...key(job));
    if (busy) throw fail('This skill has an active task', 'SKILL_JOB_BUSY', 409);
    job.generation = 0;
    db.prepare('INSERT INTO skill_eval_jobs VALUES (?,?,?,?,?,?,?,?,0,?,?)')
      .run(job.id, ...key(job).slice(0, 2), job.userId, key(job)[2], job.requestId, job.requestHash, job.status, JSON.stringify(job), Date.now());
    return job;
  });
  function get(scope, id) {
    const row = db.prepare('SELECT * FROM skill_eval_jobs WHERE id=? AND tenant_id=? AND workspace_id=?').get(id, scope.tenantId, scope.workspaceId);
    if (!row) throw fail('Evaluation not found', 'EVAL_NOT_FOUND', 404);
    if (row.deleted) throw fail('This evaluation has been replaced', 'EVAL_REPLACED', 410);
    return decode(row);
  }
  const meta = (workspacePath, name) => {
    const row = db.prepare('SELECT * FROM skill_eval_case_meta WHERE workspace_path=? AND skill_key=?').get(workspacePath, name.toLowerCase());
    return row ? { nextId: row.next_id, protectedIds: JSON.parse(row.protected_ids), sources: JSON.parse(row.sources) } : { nextId: 1, protectedIds: [], sources: {} };
  };
  const saveMeta = (workspacePath, name, value) => db.prepare(`INSERT INTO skill_eval_case_meta VALUES (?,?,?,?,?)
    ON CONFLICT(workspace_path,skill_key) DO UPDATE SET next_id=excluded.next_id,protected_ids=excluded.protected_ids,sources=excluded.sources`)
    .run(workspacePath, name.toLowerCase(), value.nextId, JSON.stringify(value.protectedIds), JSON.stringify(value.sources));
  return {
    latest, get, start, startAux, save, duplicate, meta, saveMeta,
    activeGeneration: (scope) => decode(db.prepare("SELECT * FROM skill_eval_jobs WHERE tenant_id=? AND workspace_id=? AND skill_key=? AND deleted=0 AND status IN ('queued','running','cancelling') AND json_extract(data,'$.mode')='generate-cases' LIMIT 1").get(...key(scope))),
    queued: () => db.prepare("SELECT * FROM skill_eval_jobs WHERE deleted=0 AND status='queued' ORDER BY created_at").all().map(decode),
    unfinished: () => db.prepare("SELECT * FROM skill_eval_jobs WHERE deleted=0 AND status IN ('running','cancelling')").all().map(decode),
    deletedIds: () => {
      db.prepare("UPDATE skill_eval_jobs SET deleted=1,data=json_object('id',id) WHERE deleted=0 AND status NOT IN ('queued','running','cancelling') AND json_extract(data,'$.mode')='generate-cases' AND created_at<?").run(Date.now() - 86400000);
      return db.prepare('SELECT id FROM skill_eval_jobs WHERE deleted=1').all().map((r) => r.id);
    },
    expireTombstones: () => db.prepare('DELETE FROM skill_eval_jobs WHERE deleted=1 AND created_at<?').run(Date.now() - 86400000),
    acquireLeader: (owner) => db.prepare(`INSERT INTO skill_eval_worker VALUES (1,?,?) ON CONFLICT(id)
      DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE skill_eval_worker.expires<? OR skill_eval_worker.owner=excluded.owner`)
      .run(owner, Date.now() + 30000, Date.now()).changes > 0,
    isLeader: (owner) => Boolean(db.prepare('SELECT 1 FROM skill_eval_worker WHERE id=1 AND owner=? AND expires>?').get(owner, Date.now())),
    releaseLeader: (owner) => db.prepare('DELETE FROM skill_eval_worker WHERE owner=?').run(owner),
  };
}
