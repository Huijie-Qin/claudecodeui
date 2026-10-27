"""Online coordination and staging. No database-wide restore on a live instance."""
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import shutil
import sqlite3
import threading
import time
import uuid

LEASE_MS = 30000
FRESH_MS = 5000


def milliseconds():
    return int(time.time() * 1000)


@contextmanager
def transaction(db):
    db.execute('BEGIN IMMEDIATE')
    try:
        yield
        db.execute('COMMIT')
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        raise


def scope_for(engine, db, source, target):
    info = engine.schema(db)
    users = [source['id'], target['id']]
    selected = [engine.collect(db, info, user) for user in users]
    workspaces = {r['id'] for tables in selected for r in tables['workspaces']}
    workspaces.update(r['workspace_id'] for tables in selected for items in tables.values()
                      for r in items if r.get('workspace_id') is not None)
    roots = [r['path'] for r in engine.rows(db, 'workspaces', engine.in_values('id', workspaces))]
    runtimes = engine.rows(db, 'agent_session_runtime', engine.in_values('user_id', users)
                          + ' OR ' + engine.in_values('workspace_id', workspaces))
    roots.extend(r['runtime_home_path'] for r in runtimes)
    return {'userIds': users, 'workspaceIds': sorted(workspaces),
            'paths': sorted(set(roots)), 'pausedContainers': []}, runtimes


class Lease:
    def __init__(self, engine, filename, scope, timeout=300):
        self.engine, self.filename, self.scope = engine, filename, scope
        self.timeout = timeout
        self.id = str(uuid.uuid4())
        self.stop_event = threading.Event()
        self.failed = threading.Event()
        self.thread = None
        self.instances = set()
        self.info = {}
        self.revision = 0

    def start(self, db):
        if db.execute('PRAGMA journal_mode').fetchone()[0].lower() != 'wal':
            raise ValueError('在线迁移要求运行升级后的 CCUI 服务（WAL 模式）')
        tables = self.engine.schema(db)
        self.info = tables
        if not {'account_copy_instances', 'account_copy_jobs'} <= tables.keys():
            raise ValueError('请先部署支持在线迁移的 CCUI 后端，再执行此命令')
        with transaction(db):
            live = self.live_instances(db)
            if not live:
                raise ValueError('未检测到支持在线迁移的后端心跳；请运行 bash scripts/migrate-user.sh --check，核对数据库路径、后端构建版本及启动状态')
            if db.execute("SELECT 1 FROM account_copy_jobs WHERE phase IN ('draining','frozen','committing','recovering')").fetchone():
                raise ValueError('已有迁移或自动恢复正在执行，请等待完成')
            self.instances = {r['id'] for r in live}
            now = milliseconds()
            db.execute('INSERT INTO account_copy_jobs VALUES(?,?,?,?,?)',
                       (self.id, json.dumps({**self.scope, 'revision': self.revision}), 'draining', now + LEASE_MS, now))
        self.thread = threading.Thread(target=self.renew, daemon=True)
        self.thread.start()

    def live_instances(self, db):
        result = self.engine.rows(db, 'account_copy_instances', 'heartbeat_ms>?', (milliseconds() - FRESH_MS,))
        if any(r['protocol'] != 1 for r in result):
            raise ValueError('后端迁移协议不一致，请升级所有副本')
        return result

    def renew(self):
        try:
            with closing(self.engine.connect(self.filename, readonly=False)) as db:
                db.execute('PRAGMA busy_timeout=35000')
                while not self.stop_event.wait(2):
                    updated = db.execute("UPDATE account_copy_jobs SET lease_until_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)+? WHERE id=? AND lease_until_ms>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND phase IN ('draining','frozen')",
                                         (LEASE_MS, self.id))
                    if not updated.rowcount:
                        self.failed.set()
                        return
        except BaseException:
            self.failed.set()

    def assert_owned(self, db):
        row = db.execute("SELECT phase FROM account_copy_jobs WHERE id=? AND lease_until_ms>? AND phase IN ('draining','frozen','committing')",
                         (self.id, milliseconds())).fetchone()
        if self.failed.is_set() or not row:
            raise RuntimeError('迁移租约已失效，禁止提交；后端将自动恢复账号')
        return row['phase']

    def change(self, db, phase=None):
        with transaction(db):
            self.assert_owned(db)
            self.revision += 1
            db.execute('UPDATE account_copy_jobs SET scope_json=?,phase=COALESCE(?,phase) WHERE id=?',
                       (json.dumps({**self.scope, 'revision': self.revision}), phase, self.id))

    def wait_ready(self, db, phase):
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.assert_owned(db)
            live = self.live_instances(db)
            seen = {r['id'] for r in live}
            if not self.instances <= seen:
                raise RuntimeError('等待期间有后端副本失去心跳，已取消迁移')
            self.instances |= seen
            statuses = [json.loads(r['status_json']) for r in live]
            if statuses and all(s.get('jobId') == self.id and s.get('phase') == phase
                                and s.get('scopeRevision') == self.revision and s.get('busy') == 0 for s in statuses):
                if not self.pending_work(db):
                    return
            time.sleep(0.2)
        raise RuntimeError('相关请求、终端或任务未在 {} 秒内结束，已取消迁移并恢复访问；结束相关操作后重试'.format(self.timeout))

    def pending_work(self, db):
        for table, column, values in (
            ('mcp_loop_jobs', 'status', ['queued', 'running']),
            ('skill_eval_jobs', 'status', ['running', 'cancelling']),
            ('skill_creation_jobs', "json_extract(data,'$.status')", ['queued', 'selecting', 'generating', 'saving', 'cancelling']),
            ('hook_executions', 'status', ['running']),
            ('ai_usage_export_jobs', 'status', ['running']),
            ('ai_usage_turn_facts', 'terminal_status', ['pending']),
        ):
            if table not in self.info:
                continue
            columns = {c['name'] for c in self.info[table]['columns']}
            scope = self.engine.in_values('user_id', self.scope['userIds'])
            if 'workspace_id' in columns:
                scope += ' OR ' + self.engine.in_values('workspace_id', self.scope['workspaceIds'])
            query = 'SELECT 1 FROM ' + table + ' WHERE (' + scope + ') AND ' + column + ' IN (' + ','.join('?' for _ in values) + ') LIMIT 1'
            if db.execute(query, values).fetchone():
                return True
        return False

    def finish(self, db, phase):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        # Lease loss belongs to the backend reaper; never override its recovery.
        db.execute("UPDATE account_copy_jobs SET phase=? WHERE id=? AND phase IN ('draining','frozen') AND lease_until_ms>?",
                   (phase, self.id, milliseconds()))


def fingerprint(paths):
    """Detect external host writes too. Do not follow symlinks or change atime."""
    result = {}
    def visit(p):
        s = p.lstat()
        result[str(p)] = (s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if p.is_dir() and not p.is_symlink():
            for child in p.iterdir():
                visit(child)
    for value in sorted(set(map(str, paths))):
        visit(Path(value))
    return result


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return sorted((canonical(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))
    return value


def copy_frozen(engine, args, db, lease):
    created, committed = [], False
    marker = None
    run_id = lease.id
    destination = Path(args.data_root) / ('user-copy-' + run_id)
    runtime_destination = Path(args.runtime_root) / ('user-copy-' + run_id)
    backup_directory = Path(args.backup_dir) / ('user-copy-' + run_id)
    backup_directory.mkdir(mode=0o700)
    backup = backup_directory / 'before.sqlite'
    try:
        lease.assert_owned(db)
        # WAL readers do not hold the SQLite writer lock while taking a backup.
        with closing(engine.connect(args.database)) as source, closing(sqlite3.connect(str(backup))) as target:
            source.backup(target, pages=256, progress=lambda *_: lease.assert_owned(db))
            target.execute('PRAGMA journal_mode=DELETE')
        os.chmod(backup, 0o600)
        with closing(engine.connect(backup)) as snapshot:
            plan = engine.build_plan(snapshot, args.source, args.target, online=True)
            if snapshot.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('数据库快照完整性检查失败')
        protected = [Path(p).resolve() for p in lease.scope['paths']]
        for root in map(Path, (args.data_root, args.runtime_root, args.backup_dir)):
            if any(engine.under(root, p) for p in protected):
                raise ValueError('副本或备份目录不能位于现有工作区/runtime 内')
        # Reserve only IDs in a short transaction. All file IO follows COMMIT.
        with transaction(db):
            lease.assert_owned(db)
            maps = engine.allocate_maps(db, plan[0], plan[3], reserve=True)
        copies, paths = engine.file_layout(plan[3], maps, destination, args.exports_root, runtime_destination, getattr(args, 'skill_evals_root', None))
        report = engine.summary(plan)
        manifest = {**report, 'online': True, 'job_id': run_id, 'database': args.database,
                    'backup': str(backup), 'destination': str(destination), 'runtime_destination': str(runtime_destination),
                    'scope': lease.scope, 'retained_target_workspaces': [r['path'] for r in plan[4]['workspaces']],
                    'retained_target_runtime_homes': [r['runtime_home_path'] for r in plan[4]['agent_session_runtime']],
                    'file_copies': [{'source': str(a), 'target': str(b), 'kind': k} for a, b, k in copies],
                    'id_maps': {t + '.' + c: mapping for (t, c), mapping in maps.items()}}
        engine.write_json(backup_directory / 'manifest.json', manifest)
        transform = engine.Transformer(plan[0], plan[1], plan[2], maps, paths)
        roots = [(a, b) for a, b, k in copies if k != 'export']
        # Check source and retained target paths; unexpected external writes abort.
        checked_paths = [*lease.scope['paths'], *(a for a, _, _ in copies)]
        before = fingerprint(checked_paths)
        for directory, root in {(destination, Path(args.data_root)), (runtime_destination, Path(args.runtime_root))}:
            directory.mkdir(mode=0o700)
            created.append(directory)
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                owner = root.stat()
                os.chown(directory, owner.st_uid, owner.st_gid)
        for old, new, kind in copies:
            lease.assert_owned(db)
            new.parent.mkdir(parents=True, exist_ok=True)
            if kind in {'export', 'skill-evaluation'}:
                created.append(new)
            engine.clone_tree(old, new, kind, transform, roots)
        if before != fingerprint(checked_paths):
            raise RuntimeError('检测到外部进程修改了相关文件，取消提交，请结束该进程后重试')
        lease.wait_ready(db, 'frozen')
        marker = 'migration:user-copy:' + run_id
        with transaction(db):
            if lease.assert_owned(db) != 'frozen':
                raise RuntimeError('账户尚未冻结，禁止提交')
            # Revalidate the exact scoped snapshot, never overwrite concurrent data.
            for uid, user, selected in ((plan[1]['id'], plan[1], plan[3]), (plan[2]['id'], plan[2], plan[4])):
                if (engine.find_user(db, 'id:' + str(uid)) != user
                        or canonical(engine.collect(db, plan[0], uid)) != canonical(selected)):
                    raise RuntimeError('账号数据在冻结后发生变化，取消提交')
            db.execute("UPDATE account_copy_jobs SET phase='committing' WHERE id=?", (run_id,))
            engine.replace_rows(db, plan, maps, transform, online=True)
            db.execute('INSERT INTO app_config(key,value) VALUES(?,?)',
                       (marker, json.dumps({'source': plan[1]['id'], 'target': plan[2]['id'], 'online': True})))
            # Keep the lease valid across the commit; heartbeat can be blocked by
            # our own short writer transaction. Expiry still forbids late commit.
            lease.assert_owned(db)
            db.execute("UPDATE account_copy_jobs SET phase='frozen' WHERE id=?", (run_id,))
        committed = True
        result = {'online': True, 'committed': True, 'backup': str(backup),
                  'manifest': str(backup_directory / 'manifest.json'), 'marker': marker, **report}
        engine.write_json(backup_directory / 'result.json', result)
        return result
    except BaseException:
        # A signal can arrive after SQLite COMMIT but before Python records its
        # return. Never delete files that the durable transaction now references.
        if not committed and marker:
            try:
                committed = bool(db.execute('SELECT 1 FROM app_config WHERE key=?', (marker,)).fetchone())
            except sqlite3.Error:
                committed = True  # Unknown commit outcome: retain files for audit.
        if not committed:
            for p in reversed(created):
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p)
                elif p.exists() or p.is_symlink():
                    p.unlink()
        else:
            print('数据库已提交或提交结果暂无法确认；副本已保留，请核对迁移标记，勿直接重试。', flush=True)
        print('迁移备份/清单: ' + str(backup_directory), flush=True)
        raise
