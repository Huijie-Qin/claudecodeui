import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import unittest
from unittest.mock import patch

import test_migrate_user_data as fixtures

SPEC = importlib.util.spec_from_file_location('oneclick', fixtures.ROOT / 'scripts/migrate-user.py')
oneclick = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oneclick)
RUNTIME = 'a' * 64
OTHER_RUNTIME = 'b' * 64


class OneClickTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fixtures.MigrationTest.setUpClass.__func__(cls)

    @classmethod
    def tearDownClass(cls):
        fixtures.MigrationTest.tearDownClass.__func__(cls)

    def setUp(self):
        fixtures.MigrationTest.setUp(self)
        self.workspace_root = self.root / 'workspaces'
        self.runtime_root = self.root / 'runtimes'
        self.workspace_root.mkdir()
        self.runtime_root.mkdir()
        (self.root / '.env').write_text('\n'.join([
            'DATABASE_PATH=' + str(self.database),
            'WORKSPACES_ROOT=' + str(self.workspace_root),
            'CLOUDCLI_RUNTIME_ROOT=' + str(self.runtime_root),
            'CLOUDCLI_DATA_ROOT=' + str(self.data),
        ]))
        self.db.execute('PRAGMA journal_mode=WAL')
        script = """
import { DatabaseSync } from 'node:sqlite';
import { createAccountCopyGuard } from './server/services/account-copy-guard.js';
const db = new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=2000');
const guard = createAccountCopyGuard({database: db});
guard.start(); console.log('ready');
setInterval(() => {}, 1000);
"""
        self.server = subprocess.Popen([os.environ.get('NODE', 'node'), '--input-type=module', '-e', script,
            str(self.database)], cwd=fixtures.ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_server)
        self.assertEqual(self.server.stdout.readline().strip(), 'ready')

    def stop_server(self):
        if self.server.poll() is None:
            self.server.terminate()
        self.server.communicate(timeout=5)

    def docker_command(self, args, **kwargs):
        return subprocess.CompletedProcess(args, 0, stdout=json.dumps({'Paused': True}), stderr='')

    def run_oneclick(self, inventory=None):
        with patch.object(oneclick, 'docker_inventory', return_value=inventory or []), \
                patch.object(oneclick.shutil, 'which', return_value='/fake/docker'), \
                patch.object(oneclick, 'command', side_effect=self.docker_command) as commands, \
                contextlib.redirect_stdout(io.StringIO()):
            result = oneclick.migrate('old', 'new', root=self.root, environ={}, timeout=5)
            return result, commands.call_args_list

    def test_online_copy_preserves_source_and_identity(self):
        source = oneclick.engine.collect(self.db, oneclick.engine.schema(self.db), 1)
        result, calls = self.run_oneclick()
        self.assertTrue(result['committed'])
        self.assertTrue(Path(result['backup']).is_file())
        self.assertEqual(calls, [])
        self.assertEqual(source, oneclick.engine.collect(self.db, oneclick.engine.schema(self.db), 1))
        self.assertEqual(self.db.execute('SELECT password_hash FROM users WHERE id=2').fetchone()[0], 'password-new')
        self.assertEqual(self.db.execute('SELECT phase FROM account_copy_jobs').fetchone()[0], 'complete')
        workspace = Path(self.db.execute('SELECT path FROM workspaces WHERE owner_user_id=2').fetchone()[0])
        runtime = Path(self.db.execute('SELECT runtime_home_path FROM agent_session_runtime WHERE user_id=2').fetchone()[0])
        self.assertTrue(oneclick.engine.under(workspace, self.workspace_root))
        self.assertTrue(oneclick.engine.under(runtime, self.runtime_root))

    def test_only_scoped_runtime_paused_and_unpaused_never_server(self):
        inventory = [{'Id': RUNTIME, 'Name': '/container-1', 'State': {'Running': True}},
            {'Id': 'c' * 64, 'Name': '/container-2', 'State': {'Running': True, 'Paused': True}},
            {'Id': OTHER_RUNTIME, 'Name': '/unrelated', 'State': {'Running': True}},
            {'Id': 'd' * 64, 'Name': '/ccui', 'State': {'Running': True}}]
        _, calls = self.run_oneclick(inventory)
        self.assertEqual([call.args[0][1] for call in calls], ['pause', 'inspect', 'unpause'])
        self.assertTrue(all(call.args[0][-1] == RUNTIME for call in calls))

    def test_other_user_can_write_during_file_copy_and_ids_never_collide(self):
        original = oneclick.engine.clone_tree
        writes = []
        def clone(*args):
            if not writes:
                with contextlib.closing(oneclick.engine.connect(self.database, readonly=False)) as other:
                    other.execute("UPDATE users SET git_name='concurrent' WHERE id=3")
                    wid = other.execute("INSERT INTO workspaces(tenant_id,owner_user_id,slug,display_name,path) VALUES(1,3,'other','Other','/third')").lastrowid
                    writes.append(wid)
                    with self.assertRaisesRegex(sqlite3.IntegrityError, 'ACCOUNT_MIGRATING'):
                        other.execute("UPDATE users SET git_name='forbidden' WHERE id=1")
            return original(*args)
        with patch.object(oneclick.engine, 'clone_tree', side_effect=clone):
            self.run_oneclick()
        self.assertEqual(self.db.execute('SELECT git_name FROM users WHERE id=3').fetchone()[0], 'concurrent')
        self.assertEqual(self.db.execute('SELECT owner_user_id FROM workspaces WHERE id=?', (writes[0],)).fetchone()[0], 3)

    def test_failed_copy_rolls_back_target_and_unpauses(self):
        self.db.execute("CREATE TRIGGER reject_copy BEFORE INSERT ON session_index WHEN NEW.user_id=2 BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with patch.object(oneclick, 'docker_inventory', return_value=[{'Id': RUNTIME, 'Name': '/container-1', 'State': {'Running': True}}]), \
                patch.object(oneclick.shutil, 'which', return_value='/fake/docker'), \
                patch.object(oneclick, 'command', side_effect=self.docker_command) as commands, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'test failure'):
                oneclick.migrate('old', 'new', root=self.root, environ={}, timeout=5)
        self.assertEqual(commands.call_args_list[-1].args[0], ['docker', 'unpause', RUNTIME])
        self.assertEqual(self.db.execute('SELECT phase FROM account_copy_jobs').fetchone()[0], 'failed')
        self.assertEqual(list((self.workspace_root / '.account-copies').iterdir()), [])
        self.assertEqual(self.db.execute('SELECT path FROM workspaces WHERE id=20').fetchone()[0], str(self.old_target_workspace))

    def test_external_source_file_change_aborts_without_overwriting_target(self):
        original = oneclick.engine.clone_tree
        changed = []
        def clone(*args):
            result = original(*args)
            if not changed:
                (self.workspace / 'code.py').write_text('external writer')
                changed.append(True)
            return result
        with patch.object(oneclick.engine, 'clone_tree', side_effect=clone):
            with self.assertRaisesRegex(RuntimeError, '外部进程'):
                self.run_oneclick()
        self.assertTrue(self.db.execute('SELECT 1 FROM workspaces WHERE id=20').fetchone())

    def test_missing_backend_refuses_online_migration(self):
        self.stop_server()
        self.db.execute('DELETE FROM account_copy_instances')
        with self.assertRaisesRegex(ValueError, '心跳'):
            self.run_oneclick()
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM account_copy_jobs').fetchone()[0], 0)

    def test_second_live_replica_must_acknowledge_barrier(self):
        self.db.execute("INSERT INTO account_copy_instances VALUES('other',1,?,?)", (oneclick.online.milliseconds(), '{}'))
        with self.assertRaisesRegex(RuntimeError, '未在'):
            with patch.object(oneclick, 'docker_inventory', return_value=[]), contextlib.redirect_stdout(io.StringIO()):
                oneclick.migrate('old', 'new', root=self.root, environ={}, timeout=1)
        self.assertEqual(self.db.execute('SELECT phase FROM account_copy_jobs').fetchone()[0], 'failed')

    def test_lost_lease_never_commits(self):
        original = oneclick.engine.clone_tree
        expired = []
        def clone(*args):
            result = original(*args)
            if not expired:
                self.db.execute('UPDATE account_copy_jobs SET lease_until_ms=0')
                expired.append(True)
            return result
        with patch.object(oneclick.engine, 'clone_tree', side_effect=clone):
            with self.assertRaisesRegex(RuntimeError, '租约'):
                self.run_oneclick()
        self.assertTrue(self.db.execute('SELECT 1 FROM workspaces WHERE id=20').fetchone())

    def test_active_work_times_out_and_unlocks(self):
        self.db.execute("UPDATE hook_executions SET status='running'")
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, '未在'):
                oneclick.migrate('old', 'new', root=self.root, environ={}, timeout=1)
        self.db.execute("UPDATE users SET git_name='restored' WHERE id=1")
        self.assertEqual(self.db.execute('SELECT phase FROM account_copy_jobs').fetchone()[0], 'failed')

    def test_shared_workspace_runtime_is_paused_but_its_owner_is_not_copied(self):
        home = self.root / 'third-runtime'
        home.mkdir()
        runtime = dict(self.db.execute('SELECT * FROM agent_session_runtime WHERE id=1').fetchone())
        runtime.update(id=3, user_id=3, runtime_id='runtime-3', container_name='container-3', runtime_home_path=str(home))
        oneclick.engine.insert(self.db, 'agent_session_runtime', runtime)
        _, calls = self.run_oneclick([{'Id': OTHER_RUNTIME, 'Name': '/container-3', 'State': {'Running': True}}])
        self.assertEqual(calls[0].args[0], ['docker', 'pause', OTHER_RUNTIME])
        self.assertEqual(dict(self.db.execute('SELECT * FROM agent_session_runtime WHERE id=3').fetchone()), runtime)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM agent_session_runtime WHERE user_id=2').fetchone()[0], 1)

    def test_active_report_candidate_is_revoked_before_old_data_can_publish(self):
        self.db.execute("INSERT INTO ai_usage_batches(id,tenant_id,scheduled_for,target_through,time_zone,calculation_version,lease_token,lease_until,progress_json) VALUES('candidate',1,'2026-10-27','2026-10-27','Asia/Shanghai','v1','old-token','2099-01-01','{}')")
        self.run_oneclick()
        batch = self.db.execute("SELECT * FROM ai_usage_batches WHERE id='candidate'").fetchone()
        self.assertEqual(batch['status'], 'paused')
        self.assertIsNone(batch['lease_token'])
        self.assertIsNone(batch['lease_until'])

    def test_pause_timeout_still_restores_attempted_runtime(self):
        def command(args, **kwargs):
            if args[1] == 'pause':
                raise subprocess.TimeoutExpired(args, 10)
            return self.docker_command(args, **kwargs)
        with patch.object(oneclick, 'docker_inventory', return_value=[{'Id': RUNTIME, 'Name': '/container-1', 'State': {'Running': True}}]), \
                patch.object(oneclick.shutil, 'which', return_value='/fake/docker'), \
                patch.object(oneclick, 'command', side_effect=command) as commands, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(subprocess.TimeoutExpired):
                oneclick.migrate('old', 'new', root=self.root, environ={}, timeout=5)
        self.assertEqual(commands.call_args_list[-1].args[0], ['docker', 'unpause', RUNTIME])
        self.assertEqual(self.db.execute('SELECT phase FROM account_copy_jobs').fetchone()[0], 'failed')

    def test_signal_after_commit_keeps_files_referenced_by_committed_target(self):
        original = oneclick.online.transaction
        @contextlib.contextmanager
        def interrupt_after_commit(db):
            with original(db):
                yield
            if db.execute("SELECT 1 FROM app_config WHERE key LIKE 'migration:user-copy:%'").fetchone():
                raise KeyboardInterrupt()
        with patch.object(oneclick.online, 'transaction', interrupt_after_commit):
            with self.assertRaises(KeyboardInterrupt):
                self.run_oneclick()
        path = Path(self.db.execute('SELECT path FROM workspaces WHERE owner_user_id=2').fetchone()[0])
        self.assertNotEqual(path, self.old_target_workspace)
        self.assertTrue((path / 'code.py').is_file())

    def test_duplicate_unpause_is_successful_recovery(self):
        def command(args, **kwargs):
            if args[1] == 'inspect':
                return self.docker_command(args, **kwargs)
            return subprocess.CompletedProcess(args, 1, stdout='', stderr='Container is not paused')
        with patch.object(oneclick, 'command', side_effect=command):
            oneclick.restore_runtimes([RUNTIME])

    def test_scope_expansion_requires_new_backend_acknowledgement(self):
        self.stop_server()
        self.db.execute('DELETE FROM account_copy_instances')
        self.db.execute("INSERT INTO account_copy_instances VALUES('replica',1,?,?)", (oneclick.online.milliseconds(), '{}'))
        lease = oneclick.online.Lease(oneclick.engine, self.database, {'userIds':[1], 'workspaceIds':[], 'paths':[]}, timeout=1)
        lease.start(self.db)
        try:
            self.db.execute("UPDATE account_copy_instances SET status_json=?", (json.dumps({'jobId':lease.id,'phase':'draining','busy':0,'scopeRevision':0}),))
            lease.scope['workspaceIds'] = [10]
            lease.change(self.db)
            with self.assertRaisesRegex(RuntimeError, '未在'):
                lease.wait_ready(self.db, 'draining')
        finally:
            lease.finish(self.db, 'failed')

    def test_env_values_are_not_executed(self):
        (self.root / '.env').write_text('DATABASE_PATH="/path with spaces/auth.db" # comment\nUNRELATED_SECRET=$(never-execute)\n')
        self.assertEqual(oneclick.load_settings(self.root, {})['DATABASE_PATH'], '/path with spaces/auth.db')
        self.assertEqual(oneclick.load_settings(self.root, {'DATABASE_PATH': str(self.database)})['DATABASE_PATH'], str(self.database))
        (self.root / '.env').write_text('DATABASE_PATH=$(touch /tmp/must-not-exist)')
        with self.assertRaisesRegex(ValueError, 'shell'):
            oneclick.load_settings(self.root, {})


if __name__ == '__main__':
    unittest.main()
