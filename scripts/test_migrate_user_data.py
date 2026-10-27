"""Run: python3 -m unittest discover -s scripts -p 'test_migrate_user_data.py' -v.

Node 22+ is used only to load the repository's actual JS schema/migrations into
the fixture. The migration CLI itself requires only Python 3.9+.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('migration', ROOT / 'scripts/migrate-user-data.py')
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)
SESSION = '11111111-1111-4111-8111-111111111111'
OTHER_SESSION = '22222222-2222-4222-8222-222222222222'


def seed_legacy_admin_analytics_cache(db):
    # Historical DDL from admin-analytics-cache.js before its removal in 993aa14a.
    # Upgraded databases retain the table even though current schema setup does not.
    db.execute("""CREATE TABLE admin_analytics_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        refresh_interval_minutes INTEGER NOT NULL
    )""")
    for key, payload in (
        ('summary:30', {'totalUsers': 3}),
        ('users:rangeDays=30&page=1', {'users': [{'userId': uid} for uid in (1, 2, 3)]}),
    ):
        db.execute('INSERT INTO admin_analytics_cache VALUES (?, ?, ?, ?)',
                   (key, json.dumps(payload), '2026-07-01T00:00:00Z', 30))
    return migration.rows(db, 'admin_analytics_cache')


class MigrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema_directory = tempfile.TemporaryDirectory(prefix='ccui-copy-schema-')
        cls.schema_file = Path(cls.schema_directory.name) / 'schema.sqlite'
        script = """
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createSkillEvaluationDb } from './server/database/skill-evaluation-db.js';
import { createSkillSnippetService } from './server/services/skill-snippets.js';
import { createAccountCopyGuard } from './server/services/account-copy-guard.js';
import { DATABASE_SCHEMA_SQL } from './server/database/schema.js';
import { MULTITENANCY_SCHEMA_SQL } from './server/database/multitenancy-schema.js';
import { HOOK_CONFIG_SCHEMA_SQL } from './server/database/hook-config-schema.js';
import { migrateAiUsageSchema } from './server/database/ai-usage-schema.js';
import { migrateAiUsageExportSchema } from './server/database/ai-usage-export-schema.js';
const raw = new DatabaseSync(process.argv[1]);
const db = {exec: sql => raw.exec(sql), prepare: sql => raw.prepare(sql),
  transaction: fn => Object.assign((...args) => fn(...args), {immediate: (...args) => fn(...args)})};
db.exec(DATABASE_SCHEMA_SQL); db.exec(MULTITENANCY_SCHEMA_SQL); db.exec(HOOK_CONFIG_SCHEMA_SQL);
migrateAiUsageSchema(db); migrateAiUsageExportSchema(db);
createSkillEvaluationDb(db); createSkillSnippetService(db);
for (const name of ['skill-creation/service.js', 'skill-evals/invocations.js']) {
  const source = readFileSync('./server/services/' + name, 'utf8');
  const sql = source.match(/db\.exec\(`([\s\S]*?)`\)/)[1];
  db.exec(sql);
}
createAccountCopyGuard({database: db}).installWriteFences(); raw.close();
"""
        subprocess.run([os.environ.get('NODE', 'node'), '--input-type=module', '-e', script,
                        str(cls.schema_file)], cwd=ROOT, check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.schema_directory.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='ccui-copy-test-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.database = self.root / 'auth.sqlite'
        shutil.copyfile(self.schema_file, self.database)
        self.data = self.root / 'data'
        self.backups = self.root / 'backups'
        self.data.mkdir()
        self.backups.mkdir()
        self.workspace = self.root / 'source-project'
        self.old_target_workspace = self.root / 'target-project'
        self.home = self.root / 'source-runtime' / 'home'
        self.old_target_home = self.root / 'target-runtime' / 'home'
        for directory in (self.workspace, self.old_target_workspace, self.home, self.old_target_home):
            directory.mkdir(parents=True)
        (self.workspace / 'code.py').write_text('source = 1\n')
        (self.workspace / 'image.png').write_bytes(b'\x89PNG\0\xffbinary')
        (self.old_target_workspace / 'old.txt').write_text('target original')
        native = self.home / '.claude' / 'projects' / '-workspace'
        native.mkdir(parents=True)
        (native / (SESSION + '.jsonl')).write_text(json.dumps({
            'type': 'user', 'sessionId': SESSION, 'cwd': '/workspace',
            'message': {'content': 'keep number 1 and 2'}, 'uuid': 'message-1',
        }) + '\n')
        sidecar = native / SESSION
        sidecar.mkdir()
        (sidecar / 'completed-replies.jsonl').write_text('{"sourceMessageUuid":"message-1"}\n')
        db = migration.connect(self.database, readonly=False)
        self.addCleanup(db.close)
        self.db = db
        for user_id, username in ((1, 'old'), (2, 'new'), (3, 'third')):
            migration.insert(db, 'users', {'id': user_id, 'username': username,
                'password_hash': 'password-' + username, 'git_name': username,
                'env': json.dumps({'USER_KEY': username + '-managed-key', 'APP': username})})
        migration.insert(db, 'tenants', {'id': 1, 'code': 'team', 'name': 'Team'})
        for user_id in (1, 2):
            migration.insert(db, 'tenant_users', {'tenant_id': 1, 'user_id': user_id, 'permission': 'edit'})
        for wid, uid, directory in ((10, 1, self.workspace), (20, 2, self.old_target_workspace)):
            migration.insert(db, 'workspaces', {'id': wid, 'tenant_id': 1, 'owner_user_id': uid,
                'slug': 'same-slug', 'display_name': 'Project', 'path': str(directory)})
        for uid, wid, sid, home in ((1, 10, SESSION, self.home), (2, 20, OTHER_SESSION, self.old_target_home)):
            migration.insert(db, 'agent_session_runtime', {'id': uid, 'runtime_id': 'runtime-' + str(uid),
                'tenant_id': 1, 'workspace_id': wid, 'user_id': uid, 'provider': 'claude',
                'provider_session_id': sid, 'container_name': 'container-' + str(uid), 'image': 'claude:test',
                'workspace_host_path': str(self.workspace if uid == 1 else self.old_target_workspace),
                'runtime_home_path': str(home), 'status': 'idle'})
            migration.insert(db, 'session_index', {'tenant_id': 1, 'workspace_id': wid, 'user_id': uid,
                'provider': 'claude', 'provider_session_id': sid,
                'metadata_json': json.dumps({'fork': {'parentSessionId': sid, 'runtimeId': 'runtime-' + str(uid)}})})
            migration.insert(db, 'agent_session_messages', {'tenant_id': 1, 'workspace_id': wid,
                'user_id': uid, 'runtime_id': 'runtime-' + str(uid), 'provider': 'claude',
                'provider_session_id': sid, 'message_id': 'message-1', 'kind': 'user',
                'content_text': 'hello 1', 'normalized_json': json.dumps({'sessionId': sid, 'userId': uid,
                    'workspaceId': wid, 'count': 1}), 'sequence': 1})
            migration.insert(db, 'scheduled_session_tasks', {'id': uid, 'tenant_id': 1, 'workspace_id': wid,
                'user_id': uid, 'provider': 'claude', 'name': 'daily', 'prompt': 'do work',
                'interval_minutes': 60, 'next_run_at': '2027-01-01T00:00:00Z', 'last_session_id': sid})
            migration.insert(db, 'scheduled_task_logs', {'timestamp': '2026-10-01', 'level': 'info',
                'event': 'done', 'task_id': uid, 'user_id': uid, 'workspace_id': wid,
                'details_json': json.dumps({'taskId': uid, 'sessionId': sid})})
            migration.insert(db, 'session_names', {'session_id': sid, 'provider': 'claude', 'custom_name': 'Name-' + str(uid)})
            migration.insert(db, 'user_notification_preferences', {'user_id': uid, 'preferences_json': json.dumps({'value': uid})})
            migration.insert(db, 'user_sql_check_preferences', {'tenant_id': 1, 'workspace_id': wid, 'user_id': uid, 'custom_enabled': 1})
            migration.insert(db, 'user_sql_check_rules', {'tenant_id': 1, 'workspace_id': wid, 'user_id': uid, 'rule_id': 'rule'})
        migration.insert(db, 'api_keys', {'user_id': 2, 'key_name': 'target', 'api_key': 'keep-target-auth'})
        migration.insert(db, 'hooks', {'id': 'shared-hook', 'name': 'shared', 'event_name': 'Stop', 'created_by': 1, 'updated_by': 1})
        migration.insert(db, 'hook_executions', {'id': 'execution-source', 'hook_id': 'shared-hook',
            'user_id': 1, 'tenant_id': 1, 'workspace_id': 10, 'session_id': SESSION, 'event_name': 'Stop', 'status': 'succeeded'})
        migration.insert(db, 'hook_data_records', {'id': 'record-source', 'execution_id': 'execution-source',
            'hook_id': 'shared-hook', 'user_id': 1, 'tenant_id': 1, 'workspace_id': 10, 'session_id': SESSION,
            'record_type': 'test', 'data_json': '{"value":1}'})
        migration.insert(db, 'user_workspace_hook_variables', {'workspace_id': 10, 'user_id': 1,
            'hook_id': 'shared-hook', 'values_encrypted': 'ciphertext-unchanged'})
        self.args = argparse.Namespace(database=str(self.database), source='old', target='new', apply=True,
            offline=True, confirm_target='2', data_root=str(self.data), backup_dir=str(self.backups), exports_root=None)

    def run_migration(self):
        with contextlib.redirect_stderr(io.StringIO()):
            return migration.run(self.args)

    def fingerprint(self):
        return '\n'.join(self.db.iterdump())

    def test_skill_creation_and_evaluation_rows_files_and_references_are_copied(self):
        job_id = '33333333-3333-4333-8333-333333333333'
        invocation = '44444444-4444-4444-8444-444444444444'
        creation = '55555555-5555-4555-8555-555555555555'
        session = 'skill-creation:source-generated-conversation'
        reports = self.root / 'skill-reports'
        (reports / job_id).mkdir(parents=True)
        job = {'id': job_id, 'userId': 1, 'workspaceId': 10, 'workspacePath': str(self.workspace), 'status': 'completed'}
        (reports / job_id / 'case-0-1.json').write_text(json.dumps({**job, 'jobId': job_id, 'text': 'historical report'}))
        migration.insert(self.db, 'skill_eval_jobs', {'id': job_id, 'tenant_id':1, 'workspace_id':10, 'user_id':1,
            'skill_key':'weekly', 'request_id':'request-eval', 'request_hash':'hash', 'status':'completed', 'data':json.dumps(job), 'created_at':1})
        migration.insert(self.db, 'skill_eval_latest', {'tenant_id':1, 'workspace_id':10, 'skill_key':'weekly', 'job_id':job_id, 'generation':1})
        migration.insert(self.db, 'skill_eval_invocations', {'id':invocation, 'tenant_id':1, 'workspace_id':10, 'user_id':1,
            'message_id':'message-1', 'skill_name':'weekly', 'data':json.dumps({'sessionId':SESSION, 'prompt':'keep history'})})
        migration.insert(self.db, 'skill_eval_case_meta', {'workspace_path':str(self.workspace), 'skill_key':'weekly',
            'next_id':2, 'protected_ids':'[1]', 'sources':json.dumps({'1':'invocation:' + invocation})})
        migration.insert(self.db, 'session_index', {'tenant_id':1, 'workspace_id':10, 'user_id':1, 'provider':'claude',
            'provider_session_id':session, 'metadata_json':'{"skillCreation":true}'})
        migration.insert(self.db, 'skill_creation_jobs', {'id':creation,'tenant_id':1,'workspace_id':10,'user_id':1,
            'request_id':'request-create','conversation_key':'claude:' + session,
            'data':json.dumps({'id':creation,'userId':1,'workspaceId':10,'workspacePath':str(self.workspace),'sessionId':session,'status':'completed'})})
        self.args.skill_evals_root = str(reports)
        self.run_migration()
        copied = dict(self.db.execute('SELECT * FROM skill_eval_jobs WHERE user_id=2').fetchone())
        self.assertNotEqual(copied['id'], job_id)
        self.assertEqual(json.loads(copied['data'])['userId'], 2)
        self.assertEqual(self.db.execute('SELECT job_id FROM skill_eval_latest WHERE workspace_id=?',(copied['workspace_id'],)).fetchone()[0],copied['id'])
        report = json.loads((reports / copied['id'] / 'case-0-1.json').read_text())
        self.assertEqual(report['jobId'], copied['id'])
        self.assertEqual(report['userId'], 2)
        self.assertTrue((reports / job_id / 'case-0-1.json').exists())
        new_path = json.loads(copied['data'])['workspacePath']
        meta = self.db.execute('SELECT * FROM skill_eval_case_meta WHERE workspace_path=?',(new_path,)).fetchone()
        new_invocation = self.db.execute('SELECT id FROM skill_eval_invocations WHERE user_id=2').fetchone()[0]
        self.assertEqual(json.loads(meta['sources'])['1'], 'invocation:' + new_invocation)
        created = dict(self.db.execute('SELECT * FROM skill_creation_jobs WHERE user_id=2').fetchone())
        new_session = json.loads(created['data'])['sessionId']
        self.assertTrue(new_session.startswith('skill-creation:'))
        self.assertNotEqual(new_session, session)
        self.assertEqual(created['conversation_key'], 'claude:' + new_session)
        self.assertTrue(self.db.execute('SELECT 1 FROM session_index WHERE user_id=2 AND provider_session_id=?',(new_session,)).fetchone())

    def test_running_skill_creation_blocks_copy(self):
        migration.insert(self.db,'skill_creation_jobs',{'id':'job','tenant_id':1,'workspace_id':10,'user_id':1,
            'request_id':'request','conversation_key':'claude:draft-test','data':'{"status":"generating"}'})
        with self.assertRaisesRegex(ValueError, '未完成任务.*skill_creation_jobs'):
            self.run_migration()

    def test_copy_all_relationships_files_and_preserve_source_and_identity(self):
        before_source = migration.collect(self.db, migration.schema(self.db), 1)
        source_bytes = (self.home / '.claude/projects/-workspace' / (SESSION + '.jsonl')).read_bytes()
        result = self.run_migration()
        self.assertTrue(result['committed'])
        self.assertEqual(before_source, migration.collect(self.db, migration.schema(self.db), 1))
        self.assertEqual(self.db.execute('SELECT password_hash FROM users WHERE id=2').fetchone()[0], 'password-new')
        env = json.loads(self.db.execute('SELECT env FROM users WHERE id=2').fetchone()[0])
        self.assertEqual(env, {'USER_KEY': 'new-managed-key', 'APP': 'old'})
        self.assertEqual(self.db.execute('SELECT api_key FROM api_keys WHERE user_id=2').fetchone()[0], 'keep-target-auth')
        workspace = dict(self.db.execute('SELECT * FROM workspaces WHERE owner_user_id=2').fetchone())
        self.assertNotIn(workspace['id'], (10, 20))
        self.assertEqual((Path(workspace['path']) / 'image.png').read_bytes(), b'\x89PNG\0\xffbinary')
        (Path(workspace['path']) / 'code.py').write_text('changed')
        self.assertEqual((self.workspace / 'code.py').read_text(), 'source = 1\n')
        runtime = dict(self.db.execute('SELECT * FROM agent_session_runtime WHERE user_id=2').fetchone())
        session = dict(self.db.execute('SELECT * FROM session_index WHERE user_id=2').fetchone())
        self.assertNotIn(session['provider_session_id'], (SESSION, OTHER_SESSION))
        self.assertEqual(runtime['workspace_id'], workspace['id'])
        self.assertEqual(runtime['workspace_host_path'], workspace['path'])
        self.assertNotEqual(runtime['container_name'], 'container-1')
        transcript = Path(runtime['runtime_home_path']) / '.claude/projects/-workspace' / (session['provider_session_id'] + '.jsonl')
        self.assertEqual(json.loads(transcript.read_text())['sessionId'], session['provider_session_id'])
        self.assertTrue((transcript.parent / session['provider_session_id'] / 'completed-replies.jsonl').exists())
        self.assertEqual((self.home / '.claude/projects/-workspace' / (SESSION + '.jsonl')).read_bytes(), source_bytes)
        message = dict(self.db.execute('SELECT * FROM agent_session_messages WHERE user_id=2').fetchone())
        self.assertEqual(message['runtime_id'], runtime['runtime_id'])
        self.assertEqual(json.loads(message['normalized_json'])['workspaceId'], workspace['id'])
        self.assertEqual(json.loads(message['normalized_json'])['count'], 1)
        task = dict(self.db.execute('SELECT * FROM scheduled_session_tasks WHERE user_id=2').fetchone())
        log = dict(self.db.execute('SELECT * FROM scheduled_task_logs WHERE user_id=2').fetchone())
        self.assertEqual(log['task_id'], task['id'])
        self.assertEqual(json.loads(log['details_json'])['taskId'], task['id'])
        self.assertEqual(task['last_session_id'], session['provider_session_id'])
        record = dict(self.db.execute('SELECT * FROM hook_data_records WHERE user_id=2').fetchone())
        execution = dict(self.db.execute('SELECT * FROM hook_executions WHERE user_id=2').fetchone())
        self.assertEqual(record['execution_id'], execution['id'])
        self.assertNotEqual(record['id'], 'record-source')
        self.assertEqual(record['hook_id'], 'shared-hook')
        self.assertEqual(self.db.execute('SELECT values_encrypted FROM user_workspace_hook_variables WHERE user_id=2').fetchone()[0], 'ciphertext-unchanged')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM user_sql_check_rules WHERE user_id=2').fetchone()[0], 1)
        self.assertFalse(self.db.execute('PRAGMA foreign_key_check').fetchall())
        self.assertEqual((self.old_target_workspace / 'old.txt').read_text(), 'target original')
        with contextlib.closing(migration.connect(result['backup'])) as backup:
            self.assertEqual(backup.execute('SELECT path FROM workspaces WHERE id=20').fetchone()[0], str(self.old_target_workspace))
        self.assertEqual(Path(result['backup']).stat().st_mode & 0o777, 0o600)

    def test_dry_run_does_not_write_anything(self):
        before = self.fingerprint()
        self.args.apply = False
        result = self.run_migration()
        self.assertTrue(result['dry_run'])
        self.assertEqual(before, self.fingerprint())
        self.assertEqual(list(self.data.iterdir()), [])
        self.assertEqual(list(self.backups.iterdir()), [])

    def test_rollback_database_and_files_on_constraint_failure(self):
        self.db.execute("CREATE TRIGGER reject_copy BEFORE INSERT ON session_index WHEN NEW.user_id=2 BEGIN SELECT RAISE(ABORT,'test failure'); END")
        before = self.fingerprint()
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'test failure'):
            self.run_migration()
        self.assertEqual(before, self.fingerprint())
        self.assertEqual(list(self.data.iterdir()), [])
        self.assertEqual(len(list(self.backups.glob('*/before.sqlite'))), 1)

    def test_bad_json_rolls_back_without_touching_source(self):
        (self.home / 'bad.json').write_text('{broken')
        before = self.fingerprint()
        with self.assertRaises(ValueError):
            self.run_migration()
        self.assertEqual(before, self.fingerprint())
        self.assertEqual(list(self.data.iterdir()), [])

    def test_shared_target_workspace_refused(self):
        migration.insert(self.db, 'workspace_acl', {'workspace_id': 20, 'user_id': 3, 'permission': 'view', 'created_by_user_id': 2})
        before = self.fingerprint()
        with self.assertRaisesRegex(ValueError, '其他账户'):
            self.run_migration()
        self.assertEqual(before, self.fingerprint())

    def test_legacy_admin_analytics_cache_is_preserved(self):
        before = seed_legacy_admin_analytics_cache(self.db)
        self.run_migration()
        self.assertEqual(before, migration.rows(self.db, 'admin_analytics_cache'))
        self.assertEqual(self.db.execute('SELECT git_name FROM users WHERE id=2').fetchone()[0], 'old')

    def test_unknown_table_is_not_silently_skipped(self):
        self.db.execute('CREATE TABLE new_preferences(id INTEGER PRIMARY KEY,user_id INTEGER)')
        with self.assertRaisesRegex(ValueError, '未分类'):
            self.run_migration()

    def test_external_symlink_refused_and_internal_symlink_remapped(self):
        (self.workspace / 'internal.py').symlink_to(self.workspace / 'code.py')
        (self.workspace / 'external').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, '外部符号链接'):
            self.run_migration()
        self.assertEqual(list(self.data.iterdir()), [])
        (self.workspace / 'external').unlink()
        self.run_migration()
        workspace = Path(self.db.execute('SELECT path FROM workspaces WHERE owner_user_id=2').fetchone()[0])
        self.assertEqual((workspace / 'internal.py').resolve(), workspace / 'code.py')

    def test_missing_source_directory_rolls_back(self):
        shutil.rmtree(self.workspace)
        before = self.fingerprint()
        with self.assertRaisesRegex(ValueError, '路径不存在'):
            self.run_migration()
        self.assertEqual(before, self.fingerprint())

    def test_same_user_missing_user_and_confirmation(self):
        for source, target, confirm, text in [('old', 'old', '1', '不能相同'),
                ('absent', 'new', '2', '不存在'), ('old', 'new', '999', 'confirm-target')]:
            self.args.source, self.args.target, self.args.confirm_target = source, target, confirm
            with self.assertRaisesRegex(ValueError, text):
                self.run_migration()

    def test_active_worker_and_pending_task_refused(self):
        self.db.execute("INSERT INTO ai_usage_worker_lock(id,lease_until) VALUES(1,'2999-01-01T00:00:00Z')")
        with self.assertRaisesRegex(ValueError, '租约'):
            self.run_migration()
        self.db.execute('DELETE FROM ai_usage_worker_lock')
        self.db.execute("UPDATE hook_executions SET status='running'")
        with self.assertRaisesRegex(ValueError, '未完成任务'):
            self.run_migration()

    def test_native_history_without_runtime_refused(self):
        self.db.execute('DELETE FROM agent_session_runtime WHERE user_id=1')
        with self.assertRaisesRegex(ValueError, '缺少独立 runtime'):
            self.run_migration()

    def test_committed_files_retained_if_result_write_fails(self):
        original = migration.write_json
        def fail_result(filename, content):
            if Path(filename).name == 'result.json':
                raise OSError('result failure')
            return original(filename, content)
        with patch.object(migration, 'write_json', side_effect=fail_result):
            with self.assertRaisesRegex(OSError, 'result failure'):
                self.run_migration()
        self.assertEqual(len(list(self.data.iterdir())), 1)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM app_config WHERE key LIKE 'migration:user-copy:%'").fetchone()[0], 1)
        self.assertNotEqual(self.db.execute('SELECT path FROM workspaces WHERE owner_user_id=2').fetchone()[0], str(self.old_target_workspace))

    def test_wal_backup_contains_committed_rows(self):
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute("UPDATE users SET git_name='in-wal' WHERE id=1")
        result = self.run_migration()
        with contextlib.closing(migration.connect(result['backup'])) as backup:
            self.assertEqual(backup.execute('SELECT git_name FROM users WHERE id=1').fetchone()[0], 'in-wal')

    def test_log_without_user_id_follows_task(self):
        migration.insert(self.db, 'scheduled_task_logs', {'timestamp': '2026-10-01', 'level': 'info',
            'event': 'legacy', 'task_id': 1, 'details_json': '{"taskId":1}'})
        self.run_migration()
        task = self.db.execute('SELECT id FROM scheduled_session_tasks WHERE user_id=2').fetchone()[0]
        log = self.db.execute("SELECT * FROM scheduled_task_logs WHERE event='legacy' AND task_id=?", (task,)).fetchone()
        self.assertIsNotNone(log)
        self.assertEqual(json.loads(log['details_json'])['taskId'], task)
        self.assertIsNotNone(self.db.execute("SELECT 1 FROM scheduled_task_logs WHERE event='legacy' AND task_id=1").fetchone())

    def test_export_file_is_copied_to_independent_filename(self):
        exports = self.root / 'exports'
        exports.mkdir()
        (exports / 'source.csv').write_text('report\n')
        migration.insert(self.db, 'ai_usage_batches', {'id': 'batch', 'tenant_id': 1,
            'scheduled_for': '2026-10-01', 'target_through': '2026-10-01', 'status': 'completed',
            'time_zone': 'Asia/Shanghai', 'calculation_version': 'test'})
        migration.insert(self.db, 'ai_usage_export_jobs', {'id': 'export-source', 'tenant_id': 1,
            'user_id': 1, 'scope': 'self', 'batch_id': 'batch', 'dataset': 'hooks', 'filters_json': '{}',
            'status': 'ready', 'created_at': '2026-10-01', 'updated_at': '2026-10-01',
            'expires_at': '2027-01-01', 'filename': 'source.csv'})
        with self.assertRaisesRegex(ValueError, 'exports-root'):
            self.run_migration()
        self.args.exports_root = str(exports)
        self.run_migration()
        filename = self.db.execute('SELECT filename FROM ai_usage_export_jobs WHERE user_id=2').fetchone()[0]
        self.assertNotEqual(filename, 'source.csv')
        self.assertEqual((exports / filename).read_text(), 'report\n')
        self.assertEqual((exports / 'source.csv').read_text(), 'report\n')

    def test_source_member_of_shared_workspace_keeps_membership_and_separate_runtime(self):
        self.db.execute('UPDATE workspaces SET owner_user_id=3 WHERE id=10')
        migration.insert(self.db, 'workspace_acl', {'workspace_id': 10, 'user_id': 1,
            'permission': 'edit', 'created_by_user_id': 3})
        self.run_migration()
        self.assertEqual(self.db.execute('SELECT owner_user_id FROM workspaces WHERE id=10').fetchone()[0], 3)
        self.assertIsNotNone(self.db.execute('SELECT 1 FROM workspace_acl WHERE workspace_id=10 AND user_id=2').fetchone())
        self.assertEqual(self.db.execute('SELECT workspace_id FROM agent_session_runtime WHERE user_id=2').fetchone()[0], 10)
        self.assertNotEqual(self.db.execute('SELECT runtime_home_path FROM agent_session_runtime WHERE user_id=2').fetchone()[0], str(self.home))

    def test_mcp_config_paths_remapped_without_editing_project_code(self):
        (self.workspace / '.mcp.json').write_text(json.dumps({'path': str(self.workspace / 'mcp.py')}))
        self.run_migration()
        workspace = Path(self.db.execute('SELECT path FROM workspaces WHERE owner_user_id=2').fetchone()[0])
        self.assertEqual(json.loads((workspace / '.mcp.json').read_text())['path'], str(workspace / 'mcp.py'))
        self.assertEqual(json.loads((self.workspace / '.mcp.json').read_text())['path'], str(self.workspace / 'mcp.py'))

    def test_external_git_worktree_pointer_refused(self):
        (self.workspace / '.git').write_text('gitdir: /some/other/repo/.git/worktrees/task\n')
        before = self.fingerprint()
        with self.assertRaisesRegex(ValueError, 'Git worktree'):
            self.run_migration()
        self.assertEqual(before, self.fingerprint())
        self.assertEqual(list(self.data.iterdir()), [])

    def test_missing_native_history_and_unknown_user_field_are_reported(self):
        transcript = self.home / '.claude/projects/-workspace' / (SESSION + '.jsonl')
        transcript.unlink()
        with self.assertRaisesRegex(ValueError, '历史文件缺失'):
            self.run_migration()
        self.db.execute('ALTER TABLE users ADD COLUMN new_profile_setting TEXT')
        with self.assertRaisesRegex(ValueError, '未分类的用户字段'):
            self.run_migration()

    def test_native_message_text_preserved_when_it_mentions_old_ids_and_paths(self):
        transcript = self.home / '.claude/projects/-workspace' / (SESSION + '.jsonl')
        content = 'Original: ' + SESSION + ' ' + str(self.workspace)
        transcript.write_text(json.dumps({'sessionId': SESSION, 'cwd': str(self.workspace),
            'message': {'role': 'user', 'content': content}}) + '\n')
        self.run_migration()
        runtime = self.db.execute('SELECT * FROM agent_session_runtime WHERE user_id=2').fetchone()
        cloned = Path(runtime['runtime_home_path']) / '.claude/projects/-workspace' / (runtime['provider_session_id'] + '.jsonl')
        entry = json.loads(cloned.read_text())
        self.assertEqual(entry['message']['content'], content)
        self.assertEqual(entry['cwd'], runtime['workspace_host_path'])

    def test_mcp_attempts_and_mr_file_children_remap(self):
        migration.insert(self.db, 'mcp_loop_jobs', {'id': 'loop-source', 'hook_id': 'shared-hook',
            'hook_execution_id': 'execution-source', 'action_id': 'poll', 'tenant_id': 1,
            'workspace_id': 10, 'user_id': 1, 'session_id': SESSION, 'tool_use_id': 'tool',
            'workspace_root': str(self.workspace), 'mcp_server_id': 'mcp', 'tool_name': 'status',
            'success_when_json': '{}', 'poll_interval_ms': 100, 'per_call_timeout_ms': 1000,
            'max_wait_ms': 10000, 'status': 'succeeded', 'next_poll_at_ms': 100, 'started_at_ms': 1})
        migration.insert(self.db, 'mcp_loop_attempts', {'hook_execution_id': 'execution-source',
            'action_id': 'poll', 'job_id': 'loop-source', 'attempt_count': 1, 'script_status': 'completed',
            'started_at_ms': 1, 'completed_at_ms': 100})
        migration.insert(self.db, 'ai_mr_submissions', {'id': 7, 'tenant_id': 1, 'user_id': 1,
            'workspace_id': 10, 'repo_relative_path': '.', 'repository_url': 'https://example.test/repo',
            'source_branch': 'feature', 'target_branch': 'main', 'ticket_no': 'TASK-1', 'commit_sha': 'abc123',
            'expires_at': '2027-01-01'})
        migration.insert(self.db, 'ai_mr_submission_files', {'submission_id': 7, 'file_path': 'file.py', 'status': 'added'})
        self.run_migration()
        job = self.db.execute('SELECT * FROM mcp_loop_jobs WHERE user_id=2').fetchone()
        attempt = self.db.execute('SELECT * FROM mcp_loop_attempts WHERE job_id=?', (job['id'],)).fetchone()
        self.assertEqual(attempt['hook_execution_id'], job['hook_execution_id'])
        self.assertNotEqual(attempt['hook_execution_id'], 'execution-source')
        submission = self.db.execute('SELECT id FROM ai_mr_submissions WHERE user_id=2').fetchone()[0]
        self.assertNotEqual(submission, 7)
        self.assertEqual(self.db.execute('SELECT file_path FROM ai_mr_submission_files WHERE submission_id=?', (submission,)).fetchone()[0], 'file.py')


if __name__ == '__main__':
    unittest.main()
