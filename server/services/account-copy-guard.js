import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const ACCOUNT_COPY_SCHEMA = `
CREATE TABLE IF NOT EXISTS account_copy_jobs (
  id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, phase TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_copy_instances (
  id TEXT PRIMARY KEY, protocol INTEGER NOT NULL, heartbeat_ms INTEGER NOT NULL,
  status_json TEXT NOT NULL
);`;

const error = () => Object.assign(new Error('账户或工作区正在迁移，请稍后重试'), {
  code: 'ACCOUNT_MIGRATING', statusCode: 423,
});
const ids = values => [...new Set(values.map(Number).filter(v => Number.isInteger(v) && v > 0))];
const contains = (a, b) => { const r = path.relative(a, b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
const normalize = scope => ({
  userIds: ids([scope?.userId, scope?.user_id, ...(scope?.userIds || [])]),
  workspaceIds: ids([scope?.workspaceId, scope?.workspace_id, ...(scope?.workspaceIds || [])]),
  paths: (scope?.paths || []).filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)),
});
export function scopesOverlap(left, right) {
  return left.userIds.some(id => right.userIds.includes(id))
    || left.workspaceIds.some(id => right.workspaceIds.includes(id))
    || left.paths.some(a => right.paths.some(b => contains(a, b) || contains(b, a)));
}

export function createAccountCopyGuard({ database = null, now = Date.now } = {}) {
  const context = new AsyncLocalStorage();
  const operations = new Set();
  const instanceId = randomUUID();
  let db = database, timer = null, extraScopes = () => [], onReleased = () => {};
  let previousJob = null, recovering = false, onRecover = async (scope) => {
    if (scope.pausedContainers?.length) throw new Error('Runtime recovery is not configured');
  };
  if (db) db.exec(ACCOUNT_COPY_SCHEMA);
  function configure(connection) { db = connection; db.exec(ACCOUNT_COPY_SCHEMA); }
  function job() {
    if (!db) return null;
    const row = db.prepare(`SELECT * FROM account_copy_jobs
      WHERE phase IN ('draining','frozen','committing','recovering') LIMIT 1`).get();
    return row ? { ...row, scope: { ...JSON.parse(row.scope_json), ...normalize(JSON.parse(row.scope_json)) } } : null;
  }
  function blocked(scope, { allowDraining = false } = {}) {
    const current = job();
    return Boolean(current && !(allowDraining && current.phase === 'draining')
      && scopesOverlap(normalize(scope), current.scope));
  }
  function assert(scope, options) { if (blocked(scope, options)) throw error(); }
  function enter(scope, options) {
    assert(scope, options);
    const operation = { ...normalize(scope), started: now(), allowDraining: Boolean(options?.allowDraining) };
    operations.add(operation);
    const release = () => operations.delete(operation);
    release.operation = operation;
    return release;
  }
  function touch(scope) {
    const active = context.getStore();
    const current = job();
    // An admitted operation may finish while draining. A previously unrelated
    // request cannot acquire a newly locked workspace after the drain barrier.
    const alreadyAdmitted = active && current && (active.allowDraining || active.started <= current.created_at_ms)
      && scopesOverlap(active, current.scope);
    assert(scope, { allowDraining: Boolean(alreadyAdmitted) });
    if (active) {
      const extra = normalize(scope);
      active.userIds = ids([...active.userIds, ...extra.userIds]);
      active.workspaceIds = ids([...active.workspaceIds, ...extra.workspaceIds]);
      active.paths.push(...extra.paths);
    }
  }
  async function run(scope, callback, options) {
    const release = enter(scope, options);
    try { return await context.run(release.operation, callback); }
    finally { release(); }
  }
  function requestScope(req, body = req.body || {}) {
    const url = new URL(req.originalUrl || req.url || '/', 'http://localhost');
    const userMatch = url.pathname.match(/\/(?:users|members)\/(\d+)(?:\/|$)/);
    const workspaceMatch = url.pathname.match(/\/workspaces\/(\d+)(?:\/|$)/);
    const options = body.options || {};
    return {
      userIds: [req.user?.id ?? req.user?.userId, userMatch?.[1], body.userId, body.ownerUserId,
        typeof body.username === 'string' && db ? db.prepare('SELECT id FROM users WHERE username=?').get(body.username)?.id : null,
        ...(Array.isArray(body.userIds) ? body.userIds : [])],
      workspaceIds: [workspaceMatch?.[1], body.workspaceId, options.workspaceId, req.accountCopyShellWorkspace,
        url.searchParams.get('workspaceId'), typeof body.sessionId === 'string' && db
          ? db.prepare('SELECT workspace_id FROM session_index WHERE provider_session_id=? LIMIT 1').get(body.sessionId)?.workspace_id : null],
      paths: [body.path, body.cwd, body.projectPath, options.cwd, options.projectPath,
        url.searchParams.get('path'), url.searchParams.get('projectPath')],
    };
  }
  function http(req, res, next) {
    let release;
    try {
      if (req.accountCopyOperation) {
        // Public auth routes attach a request before JWT resolution. Enrich and
        // recheck that same operation once authenticateToken identifies it.
        touch(requestScope(req));
        return next();
      }
      release = enter(requestScope(req));
    }
    catch (failure) {
      res.setHeader('Retry-After', '3');
      return res.status(423).json({ error: failure.message, code: failure.code });
    }
    req.accountCopyOperation = release.operation;
    res.once('finish', release);
    const end = res.end;
    res.end = function (...args) { try { return end.apply(this, args); } finally { release(); } };
    // A closed client may leave asynchronous file IO running. Keep its operation
    // until the handler ends the response rather than dropping the drain barrier.
    context.run(release.operation, next);
  }
  function wrapMessage(req, handler, report) {
    return async message => {
      try {
        const payload = JSON.parse(String(message));
        // Approval/abort replies are necessary to finish an already-running turn.
        const progress = ['abort-session', 'claude-permission-response', 'permission-response',
          'claude-permission-cancel', 'get-pending-permissions', 'check-session-status', 'get-active-sessions', 'input', 'resize'].includes(payload.type);
        await run(requestScope(req, payload), () => handler(message), { allowDraining: progress });
      } catch (failure) { report(failure); }
    };
  }
  function pulse() {
    const current = job();
    const busy = current ? [...operations, ...extraScopes().map(normalize)]
      .filter(scope => scopesOverlap(scope, current.scope)).length : 0;
    db.prepare(`INSERT INTO account_copy_instances(id,protocol,heartbeat_ms,status_json) VALUES(?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET heartbeat_ms=excluded.heartbeat_ms,status_json=excluded.status_json`)
      .run(instanceId, now(), JSON.stringify({ jobId: current?.id ?? null, phase: current?.phase ?? null,
        scopeRevision: current?.scope.revision ?? 0, busy }));
    if (previousJob && previousJob.id !== current?.id) onReleased(previousJob.scope);
    previousJob = current;
    if (current && current.lease_until_ms <= now() && !recovering) {
      recovering = true;
      db.prepare("UPDATE account_copy_jobs SET phase='recovering' WHERE id=? AND lease_until_ms<=?")
        .run(current.id, now());
      Promise.resolve().then(() => onRecover(current.scope)).then(() => {
        db.prepare("UPDATE account_copy_jobs SET phase='expired' WHERE id=? AND phase='recovering'").run(current.id);
      }).catch(failure => console.error('[AccountCopy] Recovery will retry:', failure.message))
        .finally(() => { recovering = false; });
    }
  }
  function start(options = {}) {
    if (timer) return;
    extraScopes = options.extraScopes || extraScopes;
    onReleased = options.onReleased || onReleased;
    onRecover = options.onRecover || onRecover;
    installWriteFences();
    pulse();
    timer = setInterval(() => { try { pulse(); } catch (failure) { console.error('[AccountCopy]', failure.message); } }, 500);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer); timer = null;
    if (db) db.prepare('DELETE FROM account_copy_instances WHERE id=?').run(instanceId);
  }
  async function recoverBeforeStartup(recover) {
    // Schema/data initialization can itself write scoped rows. On restart, wait
    // for a live migrator, or restore its expired runtime pause before seeding.
    for (let current = job(); current; current = job()) {
      if (current.lease_until_ms <= now()) {
        db.prepare("UPDATE account_copy_jobs SET phase='recovering' WHERE id=? AND lease_until_ms<=?").run(current.id, now());
        await recover(current.scope);
        db.prepare("UPDATE account_copy_jobs SET phase='expired' WHERE id=? AND phase='recovering'").run(current.id);
      } else await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // SQL filtering happens before LIMIT so a paused account cannot starve others.
  function sqlUnlocked(userColumn, workspaceColumn = 'NULL', { allowDraining = false } = {}) {
    return `NOT EXISTS (SELECT 1 FROM account_copy_jobs migration
      WHERE migration.phase IN (${allowDraining ? "'frozen','committing','recovering'" : "'draining','frozen','committing','recovering'"})
      AND (EXISTS (SELECT 1 FROM json_each(migration.scope_json,'$.userIds') WHERE value=${userColumn})
        OR EXISTS (SELECT 1 FROM json_each(migration.scope_json,'$.workspaceIds') WHERE value=${workspaceColumn})))`;
  }
  function installWriteFences() {
    // Covers cascades and workers on separate connections, including extensions
    // which bypass HTTP. The migrator alone switches to committing inside its
    // BEGIN IMMEDIATE transaction; other writers continue seeing frozen.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const names = new Set(tables.map(t => t.name));
    const q = name => '"' + name.replaceAll('"', '""') + '"';
    for (const { name } of tables) {
      if (name.startsWith('account_copy_')) continue;
      const columns = new Set(db.prepare(`PRAGMA table_info(${q(name)})`).all().map(c => c.name));
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const predicates = [];
        for (const row of event === 'UPDATE' ? ['OLD', 'NEW'] : [event === 'DELETE' ? 'OLD' : 'NEW']) {
          for (const column of ['user_id', 'owner_user_id', ...(name === 'users' ? ['id'] : [])]) {
            if (columns.has(column)) predicates.push(`EXISTS (SELECT 1 FROM json_each(m.scope_json,'$.userIds') WHERE value=${row}.${q(column)})`);
          }
          for (const column of ['workspace_id', ...(name === 'workspaces' ? ['id'] : [])]) {
            if (columns.has(column)) predicates.push(`EXISTS (SELECT 1 FROM json_each(m.scope_json,'$.workspaceIds') WHERE value=${row}.${q(column)})`);
          }
          if (columns.has('workspace_path')) predicates.push(`EXISTS (SELECT 1 FROM json_each(m.scope_json,'$.paths') WHERE value=${row}.workspace_path)`);
          for (const [column, parent, key] of [
            ['task_id', 'scheduled_session_tasks', 'id'], ['execution_id', 'hook_executions', 'id'],
            ['hook_execution_id', 'hook_executions', 'id'], ['job_id', 'mcp_loop_jobs', 'id'],
            ['submission_id', 'ai_mr_submissions', 'id'],
          ]) {
            if (column === 'job_id' && name === 'skill_eval_latest') continue;
            if (columns.has(column) && names.has(parent)) predicates.push(`EXISTS (SELECT 1 FROM ${q(parent)} p
              WHERE p.${q(key)}=${row}.${q(column)} AND (p.user_id IN (SELECT value FROM json_each(m.scope_json,'$.userIds'))
              OR p.workspace_id IN (SELECT value FROM json_each(m.scope_json,'$.workspaceIds'))))`);
          }
          if (name === 'session_names' && names.has('session_index')) predicates.push(`EXISTS (SELECT 1 FROM session_index s
            WHERE s.provider=${row}.provider AND s.provider_session_id=${row}.session_id AND
            (s.user_id IN (SELECT value FROM json_each(m.scope_json,'$.userIds'))
            OR s.workspace_id IN (SELECT value FROM json_each(m.scope_json,'$.workspaceIds'))))`);
        }
        if (predicates.length) db.exec(`CREATE TRIGGER IF NOT EXISTS ${q('account_copy_fence_' + name + '_' + event)}
          BEFORE ${event} ON ${q(name)} WHEN EXISTS (SELECT 1 FROM account_copy_jobs m
            WHERE m.phase IN ('frozen','recovering') AND (${predicates.join(' OR ')}))
          BEGIN SELECT RAISE(ABORT,'ACCOUNT_MIGRATING'); END;`);
      }
    }
  }
  return { configure, job, blocked, assert, enter, touch, run, http, wrapMessage, pulse, start, stop, sqlUnlocked, requestScope, installWriteFences, recoverBeforeStartup };
}

export const accountCopyGuard = createAccountCopyGuard();
