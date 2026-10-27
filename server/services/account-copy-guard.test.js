import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSkillEvaluationDb } from '../database/skill-evaluation-db.js';
import { EventEmitter } from 'node:events';
import { createAccountCopyGuard } from './account-copy-guard.js';
import { recoverAccountCopyRuntimes } from './account-copy-recovery.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE workspaces(id INTEGER PRIMARY KEY, owner_user_id INTEGER, path TEXT);
    CREATE TABLE session_index(id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER, provider_session_id TEXT, provider TEXT);
    CREATE TABLE session_names(id INTEGER PRIMARY KEY, session_id TEXT, provider TEXT);
    CREATE TABLE scheduled_session_tasks(id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER);
    CREATE TABLE scheduled_task_logs(id INTEGER PRIMARY KEY, user_id INTEGER, workspace_id INTEGER, task_id INTEGER);
    INSERT INTO users VALUES(1,'old'),(2,'new'),(3,'other');
    INSERT INTO workspaces VALUES(10,1,'/scoped'),(30,3,'/other');
    INSERT INTO session_index VALUES(1,1,10,'s1','claude');
    INSERT INTO session_names VALUES(1,'s1','claude');
    INSERT INTO scheduled_session_tasks VALUES(1,1,10),(2,3,30);
    INSERT INTO scheduled_task_logs VALUES(1,NULL,NULL,1);`);
  let time = 100;
  const guard = createAccountCopyGuard({database: db, now: () => time});
  guard.installWriteFences();
  t.after(() => { guard.stop(); db.close(); });
  const scope = {userIds: [1,2], workspaceIds: [10], paths: ['/scoped']};
  const lock = (phase = 'draining') => db.prepare('INSERT INTO account_copy_jobs VALUES(?,?,?,?,?)')
    .run('copy', JSON.stringify(scope), phase, 30000, time);
  return {db, guard, scope, lock, time: value => { time = value; }};
}

test('scoped users, shared workspaces and descendant paths block; others proceed', t => {
  const f = fixture(t); f.lock();
  assert.throws(() => f.guard.enter({userId:1}), {code:'ACCOUNT_MIGRATING'});
  assert.throws(() => f.guard.enter({userId:3, workspaceId:10}), {code:'ACCOUNT_MIGRATING'});
  assert.throws(() => f.guard.enter({userId:3, paths:['/scoped/files/a']}), {code:'ACCOUNT_MIGRATING'});
  f.guard.enter({userId:3, workspaceId:30, paths:['/other']})();
});

test('drain counts active requests and allows existing work to finish', async t => {
  const f = fixture(t); let resume;
  const pending = f.guard.run({userId:1}, async () => {
    await new Promise(resolve => { resume = resolve; });
    f.guard.touch({workspaceId:10});
  });
  f.time(200); f.lock(); f.guard.pulse();
  assert.equal(JSON.parse(f.db.prepare('SELECT status_json FROM account_copy_instances').get().status_json).busy, 1);
  resume(); await pending; f.guard.pulse();
  assert.equal(JSON.parse(f.db.prepare('SELECT status_json FROM account_copy_instances').get().status_json).busy, 0);
});

test('an unrelated admitted request cannot acquire a frozen workspace', async t => {
  const f = fixture(t);
  await f.guard.run({userId:3}, () => {
    f.lock();
    assert.throws(() => f.guard.touch({workspaceId:10}), {code:'ACCOUNT_MIGRATING'});
  });
});

test('database fences protect direct writes, ownership changes and ownerless child logs', t => {
  const f = fixture(t); f.lock('frozen');
  for (const sql of ["UPDATE users SET username='x' WHERE id=1", 'DELETE FROM workspaces WHERE id=10',
    'UPDATE session_index SET user_id=3 WHERE id=1', 'DELETE FROM scheduled_task_logs WHERE id=1',
    'DELETE FROM session_names WHERE id=1', 'INSERT INTO scheduled_task_logs VALUES(2,NULL,NULL,1)']) {
    assert.throws(() => f.db.exec(sql), /ACCOUNT_MIGRATING/);
  }
  f.db.exec("UPDATE users SET username='allowed' WHERE id=3");
  f.db.exec("UPDATE account_copy_jobs SET phase='committing'");
  f.db.exec("UPDATE users SET username='copy' WHERE id=2");
});

test('scheduler SQL filters before LIMIT, allows loop continuation only while draining', t => {
  const f = fixture(t); f.lock();
  const sql = f.guard.sqlUnlocked('t.user_id','t.workspace_id');
  assert.equal(f.db.prepare(`SELECT id FROM scheduled_session_tasks t WHERE ${sql} ORDER BY id LIMIT 1`).get().id, 2);
  assert.equal(f.guard.blocked({userId:1}, {allowDraining:true}), false);
  f.db.exec("UPDATE account_copy_jobs SET phase='frozen'");
  assert.equal(f.guard.blocked({userId:1}, {allowDraining:true}), true);
});

test('existing WebSocket connection cannot start new work; approval may drain', async t => {
  const f = fixture(t); f.lock(); const calls = [], errors = [];
  const message = f.guard.wrapMessage({url:'/ws',user:{userId:1}}, data => calls.push(String(data)), error => errors.push(error.code));
  await message(JSON.stringify({type:'claude-command'}));
  await message(JSON.stringify({type:'claude-permission-response'}));
  f.db.exec("UPDATE account_copy_jobs SET phase='frozen'");
  await message(JSON.stringify({type:'input',data:'touch file'}));
  assert.equal(calls.length, 1); assert.deepEqual(errors, ['ACCOUNT_MIGRATING','ACCOUNT_MIGRATING']);
});

test('HTTP 423 is scoped and disconnect does not release unfinished IO', t => {
  const f = fixture(t); const req = {url:'/api/projects?workspaceId=10',user:{id:3}};
  const res = Object.assign(new EventEmitter(), {end() {}, setHeader() {}, status(n) {this.statusCode=n;return this;}, json(body){this.body=body;}});
  f.guard.http(req,res,()=>{}); res.emit('close'); f.lock(); f.guard.pulse();
  assert.equal(JSON.parse(f.db.prepare('SELECT status_json FROM account_copy_instances').get().status_json).busy, 1);
  res.end(); f.guard.pulse();
  assert.equal(JSON.parse(f.db.prepare('SELECT status_json FROM account_copy_instances').get().status_json).busy, 0);
  f.guard.http({url:'/api/workspaces/10',user:{id:3}},res,()=>assert.fail('blocked'));
  assert.equal(res.statusCode,423);
});

test('expired lease stays gated until runtime restoration succeeds; restart recovers durable intent', async t => {
  const f = fixture(t); f.lock('frozen'); f.time(31000);
  let resume; const recover = new Promise(resolve => {resume=resolve;});
  let invoked = 0;
  f.guard.start({onRecover: async () => {invoked++;await recover;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked,1);
  assert.equal(f.guard.blocked({userId:1}),true);
  assert.equal(f.db.prepare('SELECT phase FROM account_copy_jobs').get().phase,'recovering');
  resume(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.guard.blocked({userId:1}),false);
  assert.equal(f.db.prepare('SELECT phase FROM account_copy_jobs').get().phase,'expired');
});

test('runtime recovery inspects and unpauses only recorded IDs, and is repeatable', async () => {
  const id='a'.repeat(64), calls=[]; let paused=true;
  const run = async (bin,args) => { calls.push(args); if(args[0]==='unpause')paused=false; return {stdout:JSON.stringify({Paused:paused})}; };
  await recoverAccountCopyRuntimes({pausedContainers:[id]},{run});
  await recoverAccountCopyRuntimes({pausedContainers:[id]},{run});
  assert.deepEqual(calls.map(c=>c[0]),['inspect','unpause','inspect']);
  await assert.rejects(recoverAccountCopyRuntimes({pausedContainers:['not-an-id']},{run}),/Invalid/);
});

test('auth middleware rechecks a request initially admitted without an identity', t => {
  const f = fixture(t); const req={url:'/api/auth/user'};
  const res=Object.assign(new EventEmitter(),{end(){},setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;}});
  f.guard.http(req,res,()=>{
    f.lock(); req.user={id:1};
    f.guard.http(req,res,()=>assert.fail('must block after auth'));
  });
  assert.equal(res.statusCode,423); res.end();
});

test('startup recovers expired persisted pauses before schema initialization', async t => {
  const f=fixture(t); f.lock('frozen'); f.time(31000);
  let restored=0;
  await f.guard.recoverBeforeStartup(async () => {restored++; assert.equal(f.guard.blocked({userId:1}),true);});
  assert.equal(restored,1); assert.equal(f.guard.blocked({userId:1}),false);
});

test('failed Docker recovery retains the lock and retries on the next pulse', async t => {
  const f=fixture(t); f.lock('frozen'); f.time(31000); let attempts=0;
  const log=t.mock.method(console,'error',()=>{});
  f.guard.start({onRecover: async () => {if(++attempts===1)throw new Error('offline');}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.guard.blocked({userId:1}),true); assert.equal(log.mock.callCount(),1);
  f.guard.pulse(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(attempts,2); assert.equal(f.guard.blocked({userId:1}),false);
});

test('missing runtime is already recovered, daemon errors must be retried', async () => {
  const scope={pausedContainers:['a'.repeat(64)]};
  await recoverAccountCopyRuntimes(scope,{run:async()=>{throw Object.assign(new Error('gone'),{stderr:'No such object: abc'});}});
  await assert.rejects(recoverAccountCopyRuntimes(scope,{run:async()=>{throw Object.assign(new Error('offline'),{stderr:'Cannot connect to Docker'});}}),/offline/);
});


test('skill evaluation queue skips paused scopes and cleanup retains their jobs', t => {
  const db = new DatabaseSync(':memory:');
  const repository = createSkillEvaluationDb({exec:sql=>db.exec(sql),prepare:sql=>db.prepare(sql),transaction:fn=>fn});
  const guard = createAccountCopyGuard({database:db});
  t.after(() => {guard.stop(); db.close();});
  for (const id of [1,3]) db.prepare('INSERT INTO skill_eval_jobs VALUES(?,?,?,?,?,?,?,?,0,?,?)').run(
    String(id),1,id*10,id,'weekly','request-'+id,'hash','queued',JSON.stringify({id:String(id),userId:id,workspaceId:id*10}),id);
  db.prepare('INSERT INTO account_copy_jobs VALUES(?,?,?,?,?)').run('copy',JSON.stringify({userIds:[1],workspaceIds:[10]}),'draining',Date.now()+30000,Date.now());
  assert.deepEqual(repository.queued().map(j=>j.userId),[3]);
  db.exec("UPDATE skill_eval_jobs SET deleted=1,created_at=0 WHERE user_id=1");
  assert.deepEqual(repository.deletedIds(),[]);
  repository.expireTombstones();
  assert.ok(db.prepare('SELECT 1 FROM skill_eval_jobs WHERE user_id=1').get());
});
