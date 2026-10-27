#!/usr/bin/env python3
"""Offline, same-instance CCUI account copy. No application imports or dependencies.

Default: read-only plan. See docs/user-data-migration.md before --apply.
"""
import argparse
from contextlib import closing
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone


USER_TABLES = set("""
skill_creation_jobs skill_eval_jobs skill_eval_invocations
user_credentials user_notification_preferences codehub_repositories
codehub_workspace_repositories ai_mr_submissions tenant_users workspace_acl
claude_env_variables user_workspace_mcp_tool_preferences user_sql_check_preferences
user_sql_check_rules tenant_join_requests session_index user_session_favorites
agent_session_runtime agent_session_messages scheduled_session_tasks scheduled_task_logs
user_hook_bindings user_hook_preferences user_hook_opt_outs user_workspace_hook_preferences
user_workspace_hook_variables hook_user_scopes hook_executions hook_data_records
mcp_loop_jobs ai_usage_turn_facts ai_usage_skill_context ai_skill_publications
ai_skill_publish_events ai_usage_export_jobs
""".split())
WORKSPACE_TABLES = set("""
workspace_mcp_preset_installs workspace_skill_preset_installs
workspace_agent_template_snapshots workspace_agent_template_mcp_installs
workspace_skill_market_imports workspace_hook_assignments ai_skill_binding_history
""".split())
# The retired admin analytics cache is global and no longer read by the server
# (removed in 993aa14a). Preserve its historical rows; it is not account data.
SHARED_TABLES = set("""
admin_analytics_cache
account_copy_jobs account_copy_instances skill_snippets skill_snippet_audit skill_eval_worker
tenants app_config vapid_keys claude_env_allowlist mcp_server_presets
mcp_preset_helper_scripts agent_template_categories agent_templates tenant_skill_presets
tenant_sql_check_rules hooks hook_published_versions hook_tenant_bindings
""".split())
AUTH_TABLES = {'api_keys', 'user_invitations', 'user_password_resets', 'push_subscriptions'}
# Materialized reports/indexes are rebuilt from the copied source facts/native files.
CACHE_TABLES = set("""
ai_usage_fact_rows ai_usage_report_rows ai_usage_report_staging ai_session_summary
ai_session_summary_staging ai_usage_session_issues ai_usage_batch_session_exclusions
ai_usage_dirty_tenants ai_usage_worker_lock ai_usage_source_changes ai_usage_source_states
ai_usage_batch_files ai_usage_dirty_skill_sessions ai_usage_skill_groups
ai_usage_skill_work_items ai_usage_dirty_partitions ai_usage_dirty_activity_days
ai_usage_batches ai_usage_run_logs ai_usage_tenant_state ai_usage_suppressed_rows ai_dashboard_split_state
""".split())
for topic in ('integration', 'interaction', 'duration', 'skill_publication',
              'skill_invocation', 'sql_generation', 'code_submission', 'ai', 'skill', 'code'):
    for suffix in ('detail', 'staging'):
        CACHE_TABLES.add('ai_dashboard_' + topic + '_' + suffix)
CHILD_LINKS = {
    'ai_mr_submission_files': [('submission_id', 'ai_mr_submissions', 'id')],
    'mcp_loop_attempts': [('job_id', 'mcp_loop_jobs', 'id'),
                          ('hook_execution_id', 'hook_executions', 'id')],
}
EXTRA_LINKS = {
    'workspace_id': ('workspaces', 'id'), 'runtime_id': ('agent_session_runtime', 'runtime_id'),
    'task_id': ('scheduled_session_tasks', 'id'), 'execution_id': ('hook_executions', 'id'),
    'hook_execution_id': ('hook_executions', 'id'), 'job_id': ('mcp_loop_jobs', 'id'),
    'submission_id': ('ai_mr_submissions', 'id'),
}
PROFILE_COLUMNS = {'git_name', 'git_email', 'git_token', 'has_completed_onboarding',
                   'env', 'env_visibility', 'env_encrypted'}
IDENTITY_COLUMNS = {'id', 'username', 'password_hash', 'created_at', 'last_login',
                    'is_active', 'is_system_admin'}
SESSION_COLUMNS = {'provider_session_id', 'session_id', 'last_session_id', 'session_key'}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def connect(filename, readonly=True):
    db = sqlite3.connect(Path(filename).resolve().as_uri() + ('?mode=ro' if readonly else '?mode=rw'),
                         uri=True, isolation_level=None, timeout=2)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def schema(db):
    result = {}
    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        table = row['name']
        result[table] = {
            'columns': [dict(c) for c in db.execute('PRAGMA table_info(' + quote(table) + ')')],
            'foreign_keys': [dict(c) for c in db.execute('PRAGMA foreign_key_list(' + quote(table) + ')')],
        }
    return result


def rows(db, table, condition='1', params=()):
    return [dict(r) for r in db.execute('SELECT * FROM ' + quote(table) + ' WHERE ' + condition, params)]


def in_values(column, values):
    # IDs come from the database, not SQL supplied by the operator.
    values = sorted(set(values))
    return quote(column) + ' IN (' + ','.join(str(int(v)) for v in values) + ')' if values else '0'


def find_user(db, selector):
    # Explicit id: avoids interpreting a numeric username as a database id.
    if selector.startswith('id:'):
        try:
            user_id = int(selector[3:])
        except ValueError as error:
            raise ValueError('账户 ID 格式应为 id:123') from error
        found = rows(db, 'users', 'id=?', (user_id,))
    else:
        found = rows(db, 'users', 'username=?', (selector,))
    if len(found) != 1:
        raise ValueError('账户不存在: ' + selector)
    return found[0]


def inspect_schema(info):
    known = (USER_TABLES | WORKSPACE_TABLES | SHARED_TABLES | AUTH_TABLES | CACHE_TABLES
             | set(CHILD_LINKS) | {'skill_eval_latest', 'skill_eval_case_meta', 'users', 'workspaces', 'session_names', 'claude_env_deny_rules'})
    unknown = set(info) - known
    # Do not silently omit an extension table, even if its owner is only in JSON.
    if unknown:
        raise ValueError('发现未分类的数据表，请先补充迁移规则: ' + ', '.join(sorted(unknown)))
    required = {'users', 'workspaces', 'session_index'}
    if not required <= set(info):
        raise ValueError('只支持已初始化多租户结构的 CCUI 数据库')
    unknown_columns = {c['name'] for c in info['users']['columns']} - PROFILE_COLUMNS - IDENTITY_COLUMNS
    if unknown_columns:
        raise ValueError('发现未分类的用户字段: ' + ', '.join(sorted(unknown_columns)))


def collect(db, info, user_id):
    selected = {'workspaces': rows(db, 'workspaces', 'owner_user_id=?', (user_id,))}
    workspace_ids = {r['id'] for r in selected['workspaces']}
    for table in sorted(USER_TABLES & set(info)):
        condition = 'user_id=?'
        if any(c['name'] == 'workspace_id' for c in info[table]['columns']):
            condition += ' OR (user_id IS NULL AND ' + in_values('workspace_id', workspace_ids) + ')'
        selected[table] = rows(db, table, condition, (user_id,))
    for table in sorted(WORKSPACE_TABLES & set(info)):
        selected[table] = rows(db, table, in_values('workspace_id', workspace_ids))
    # Some historical logs/records omitted user_id. Follow actual ownership
    # links as well; do not drop these children simply because the FK was absent.
    for table, column, parent, parent_key in (
        ('scheduled_task_logs', 'task_id', 'scheduled_session_tasks', 'id'),
        ('hook_data_records', 'execution_id', 'hook_executions', 'id'),
        ('mcp_loop_jobs', 'hook_execution_id', 'hook_executions', 'id'),
    ):
        if table not in info:
            continue
        parent_ids = {r[parent_key] for r in selected.get(parent, [])}
        seen = {r['id'] for r in selected[table]}
        selected[table].extend(r for r in rows(db, table)
                               if r[column] in parent_ids and r['id'] not in seen)
    if 'skill_eval_latest' in info:
        job_ids = {r['id'] for r in selected.get('skill_eval_jobs', [])}
        selected['skill_eval_latest'] = [r for r in rows(db, 'skill_eval_latest') if r['workspace_id'] in workspace_ids and r['job_id'] in job_ids]
    if 'skill_eval_case_meta' in info:
        paths = {r['path'] for r in selected['workspaces']}
        selected['skill_eval_case_meta'] = [r for r in rows(db, 'skill_eval_case_meta') if r['workspace_path'] in paths]
    if 'claude_env_deny_rules' in info:
        selected['claude_env_deny_rules'] = rows(db, 'claude_env_deny_rules',
                                                'owner_user_id=?', (user_id,))
    for table, links in CHILD_LINKS.items():
        if table not in info:
            continue
        values = {(column, parent, key): {r[key] for r in selected.get(parent, [])}
                  for column, parent, key in links}
        selected[table] = [r for r in rows(db, table)
                           if any(r.get(column) in values[(column, parent, key)]
                                  for column, parent, key in links)]
    session_keys = {(r['provider'], r['provider_session_id']) for r in selected['session_index']}
    if 'session_names' in info:
        selected['session_names'] = [r for r in rows(db, 'session_names')
                                     if (r['provider'], r['session_id']) in session_keys]
    return selected


def check_quiescent(db, info):
    # The offline flag is an operator assertion. SQLite cannot detect a paused
    # server that will start writing again later; all service replicas must stop.
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    for table in ('ai_usage_worker_lock', 'ai_usage_batches'):
        if table in info and db.execute('SELECT 1 FROM ' + quote(table)
                                       + ' WHERE lease_until>? LIMIT 1', (now,)).fetchone():
            raise ValueError('统计任务仍持有租约，请停止 worker 并等待租约到期')


def validate_scope(db, info, source, target, source_rows, target_rows, online=False):
    target_workspaces = {r['id'] for r in target_rows['workspaces']}
    # Removing a target workspace may cascade into another account. Fail closed.
    for table in sorted(info):
        columns = {c['name'] for c in info[table]['columns']}
        if {'workspace_id', 'user_id'} <= columns and table not in CACHE_TABLES:
            other = db.execute('SELECT 1 FROM ' + quote(table) + ' WHERE '
                               + in_values('workspace_id', target_workspaces)
                               + ' AND user_id IS NOT NULL AND user_id<>? LIMIT 1', (target['id'],)).fetchone()
            if other:
                raise ValueError('目标工作区被其他账户使用，覆盖会影响源账户或第三方: ' + table)
    for item in source_rows.get('tenant_users', []):
        if item['status'] == 'active':
            continue
        if any(r['tenant_id'] == item['tenant_id'] and r['status'] != 'deleted'
               for r in source_rows['workspaces']):
            raise ValueError('源账户存在不可访问租户的工作区，请先修复成员关系')
    # Runtime-less native sessions use host-global CLI histories, whose isolation
    # cannot be established from these rows alone.
    runtimes = {(r['provider'], r['workspace_id']) for r in source_rows.get('agent_session_runtime', [])}
    for session in source_rows['session_index']:
        if session['status'] == 'deleted' or str(session['provider_session_id']).startswith(('pending:', 'scheduled-task-', 'skill-creation:')):
            continue
        if (session['provider'], session['workspace_id']) not in runtimes:
            raise ValueError('会话缺少独立 runtime，无法完整复制原生历史: ' + str(session['id']))
        if session['provider'] != 'claude':
            raise ValueError('当前原生历史复制只支持 Claude runtime；发现 provider=' + session['provider'])
        if '/' in session['provider_session_id'] or '\\' in session['provider_session_id']:
            raise ValueError('非法的原生会话 ID')
        homes = {r['runtime_home_path'] for r in source_rows.get('agent_session_runtime', [])
                 if r['provider'] == session['provider'] and r['workspace_id'] == session['workspace_id']}
        if not any(list((Path(home) / '.claude' / 'projects').glob('*/' + session['provider_session_id'] + '.jsonl'))
                   for home in homes):
            raise ValueError('会话原生历史文件缺失，不能完整复制: ' + str(session['id']))
    for row in source_rows.get('skill_creation_jobs', []) + target_rows.get('skill_creation_jobs', []):
        if json.loads(row['data']).get('status') in {'queued', 'selecting', 'generating', 'saving', 'cancelling'}:
            raise ValueError('存在未完成任务，先完成或取消后再迁移: skill_creation_jobs')
    for table, column, active in (
        ('mcp_loop_jobs', 'status', {'queued', 'running'}),
        ('skill_eval_jobs', 'status', {'running', 'cancelling'}),
        ('hook_executions', 'status', {'running'}),
        ('ai_usage_export_jobs', 'status', {'running'} if online else {'queued', 'running'}),
        ('ai_usage_turn_facts', 'terminal_status', {'pending'}),
    ):
        if any(r.get(column) in active for r in source_rows.get(table, []) + target_rows.get(table, [])):
            raise ValueError('存在未完成任务，先完成或取消后再迁移: ' + table)


def build_plan(db, source_selector, target_selector, online=False):
    info = schema(db)
    inspect_schema(info)
    source, target = find_user(db, source_selector), find_user(db, target_selector)
    if source['id'] == target['id']:
        raise ValueError('源账户和目标账户不能相同')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('数据库已有外键错误，请先修复')
    if not online:
        check_quiescent(db, info)
    source_rows, target_rows = collect(db, info, source['id']), collect(db, info, target['id'])
    validate_scope(db, info, source, target, source_rows, target_rows, online=online)
    return info, source, target, source_rows, target_rows


def summary(plan):
    info, source, target, source_rows, target_rows = plan
    return {
        'mode': 'copy-and-overwrite',
        'source': {'id': source['id'], 'username': source['username']},
        'target': {'id': target['id'], 'username': target['username']},
        'tables': {t: {'copy': len(source_rows.get(t, [])), 'replace': len(target_rows.get(t, []))}
                   for t in sorted(source_rows) if source_rows[t] or target_rows.get(t)},
        'preserved': ['source account and files', 'target login, API keys, USER_KEY and device subscriptions',
                      'shared tenant/platform resources'],
        'rebuilt': sorted(CACHE_TABLES & set(info)),
        'filesystem': 'copy owned workspaces and Claude runtime homes; retain previous target files for recovery',
        'browser_local_storage': 'not stored on server; not included',
    }


def allocate_maps(db, info, selected, reserve=False):
    maps = {}
    for table, items in selected.items():
        pk = sorted((c for c in info[table]['columns'] if c['pk']), key=lambda c: c['pk'])
        # Natural/composite keys are remapped through their foreign keys.
        if len(pk) == 1 and pk[0]['name'] in {'id', 'turn_key', 'operation_id'}:
            column = pk[0]['name']
            integer = pk[0]['type'].upper() == 'INTEGER'
            start = db.execute('SELECT COALESCE(MAX(' + quote(column) + '),0) FROM ' + quote(table)).fetchone()[0] if integer else 0
            if integer and reserve and items:
                definition = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
                if 'AUTOINCREMENT' not in definition.upper():
                    raise ValueError('在线迁移要求整数主键使用 AUTOINCREMENT: ' + table)
                sequence = db.execute('SELECT seq FROM sqlite_sequence WHERE name=?', (table,)).fetchone()
                start = max(start, sequence[0] if sequence else 0)
                if sequence:
                    db.execute('UPDATE sqlite_sequence SET seq=? WHERE name=?', (start + len(items), table))
                else:
                    db.execute('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)', (table, start + len(items)))
            maps[(table, column)] = {r[column]: start + i + 1 if integer else str(uuid.uuid4())
                                     for i, r in enumerate(items)}
    maps[('agent_session_runtime', 'runtime_id')] = {
        r['runtime_id']: str(uuid.uuid4()) for r in selected.get('agent_session_runtime', [])}
    session_ids = set()
    for items in selected.values():
        for row in items:
            session_ids.update(row[c] for c in SESSION_COLUMNS if row.get(c))
    maps[('session', 'id')] = {
        s: next((prefix for prefix in ('pending:', 'scheduled-task-', 'skill-creation:') if s.startswith(prefix)), '') + str(uuid.uuid4())
        for s in session_ids}
    # Native histories can predate session_index registration. Give those native
    # sessions distinct IDs too, while retaining message UUIDs within each copy.
    for runtime in selected.get('agent_session_runtime', []):
        for native in (Path(runtime['runtime_home_path']) / '.claude' / 'projects').glob('*/*.jsonl'):
            if re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', native.stem):
                maps[('session', 'id')].setdefault(native.stem, str(uuid.uuid4()))
    return maps


def under(path, root):
    return path == root or root in path.parents


def file_layout(selected, maps, destination, exports_root=None, runtime_destination=None, skill_evals_root=None):
    copies = []
    path_map = {}
    for workspace in selected['workspaces']:
        old = Path(workspace['path'])
        new = destination / 'workspaces' / str(maps[('workspaces', 'id')][workspace['id']])
        copies.append((old, new, 'workspace'))
        path_map[str(old)] = str(new)
    for runtime in selected.get('agent_session_runtime', []):
        old = Path(runtime['runtime_home_path'])
        if str(old) in path_map:
            continue
        new = (runtime_destination or destination) / 'runtimes' / str(uuid.uuid4()) / 'home'
        copies.append((old, new, 'runtime'))
        path_map[str(old)] = str(new)
    for job in selected.get('ai_usage_export_jobs', []):
        if not job.get('filename'):
            continue
        if not exports_root or Path(job['filename']).name != job['filename']:
            raise ValueError('复制导出文件需要 --exports-root，且文件名必须合法')
        old = Path(exports_root).resolve() / job['filename']
        # Export download resolves files in the existing configured exports root.
        new = Path(exports_root).resolve() / (maps[('ai_usage_export_jobs', 'id')][job['id']] + old.suffix)
        copies.append((old, new, 'export'))
    for job in selected.get('skill_eval_jobs', []):
        if job['deleted']:
            continue
        if not skill_evals_root or not re.fullmatch(r'[a-f0-9-]{36}', job['id']):
            raise ValueError('复制技能评测报告需要 --skill-evals-root，且任务 ID 必须合法')
        old = Path(skill_evals_root).resolve() / job['id']
        new = Path(skill_evals_root).resolve() / maps[('skill_eval_jobs', 'id')][job['id']]
        copies.append((old, new, 'skill-evaluation'))
        path_map[str(old)] = str(new)
    for old, new, kind in copies:
        if not old.is_absolute() or not old.exists() or old.is_symlink():
            raise ValueError('源文件路径不存在或不安全: ' + str(old))
        if old.resolve() != old:
            raise ValueError('源路径的父目录含符号链接，请在数据库中使用真实路径: ' + str(old))
        if kind != 'export' and not old.is_dir():
            raise ValueError('源路径不是目录: ' + str(old))
        if new.exists() or new.is_symlink() or under(destination, old) or under(old, destination) or (
            runtime_destination and (under(runtime_destination, old) or under(old, runtime_destination))
        ):
            raise ValueError('复制路径重叠或目标已存在: ' + str(new))
    return copies, path_map


class Transformer:
    def __init__(self, info, source, target, maps, paths):
        self.info, self.source, self.target, self.maps = info, source, target, maps
        self.paths = sorted(paths.items(), key=lambda pair: len(pair[0]), reverse=True)
        self.strings = {old: new for mapping in maps.values() for old, new in mapping.items()
                        if isinstance(old, str) and isinstance(new, str)}

    def text(self, value):
        if value in self.strings:
            return self.strings[value]
        # Only replace opaque UUID/string IDs, never unscoped numeric IDs.
        for old, new in self.strings.items():
            if len(old) >= 16:
                value = value.replace(old, new)
        for old, new in self.paths:
            value = value.replace(old, new)
            encode = lambda p: re.sub(r'[^a-zA-Z0-9-]', '-', p)
            value = value.replace(encode(old), encode(new))
        return value

    def value(self, value, key=''):
        # Conversation text is historical data, not routing metadata. A prompt
        # that happens to mention an old path/session UUID must remain verbatim.
        if key in {'content', 'content_text', 'text', 'prompt', 'summary', 'custom_name'}:
            return value
        aliases = {'userId': 'user_id', 'ownerUserId': 'owner_user_id', 'workspaceId': 'workspace_id',
                   'taskId': 'task_id', 'scheduledTaskId': 'task_id', 'runtimeId': 'runtime_id',
                   'executionId': 'execution_id', 'hookExecutionId': 'hook_execution_id',
                   'jobId': 'job_id', 'submissionId': 'submission_id'}
        key = aliases.get(key, key)
        if key in {'user_id', 'owner_user_id', 'publisher_user_id'} and value == self.source['id']:
            return self.target['id']
        if key in EXTRA_LINKS and isinstance(value, (str, int)):
            result = self.maps.get(EXTRA_LINKS[key], {}).get(value, value)
            return self.text(result) if isinstance(result, str) else result
        if isinstance(value, dict):
            return {self.text(k): self.value(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [self.value(v) for v in value]
        return self.text(value) if isinstance(value, str) else value

    def row(self, table, original):
        result = dict(original)
        references = {f['from']: (f['table'], f['to']) for f in self.info[table]['foreign_keys']}
        for column, value in original.items():
            if value is None:
                continue
            if (table, column) in self.maps:
                result[column] = self.maps[(table, column)].get(value, value)
            elif references.get(column, ('', ''))[0] == 'users' or column in {'user_id', 'owner_user_id', 'publisher_user_id'}:
                result[column] = self.target['id'] if value == self.source['id'] else value
            elif table == 'skill_eval_latest' and column == 'job_id':
                result[column] = self.maps[('skill_eval_jobs', 'id')][value]
            elif column in EXTRA_LINKS:
                result[column] = self.maps.get(EXTRA_LINKS[column], {}).get(value, value)
            elif column in references and references[column] in self.maps:
                result[column] = self.maps[references[column]].get(value, value)
            elif column in SESSION_COLUMNS:
                result[column] = self.maps[('session', 'id')].get(value, value)
            elif column.endswith('_json') or (table.startswith('skill_') and column in {'data', 'sources'}):
                try:
                    result[column] = json.dumps(self.value(json.loads(value)), ensure_ascii=False, separators=(',', ':'))
                except (ValueError, TypeError) as error:
                    raise ValueError('无效 JSON: ' + table + '.' + column) from error
            elif isinstance(value, str) and column in {'path', 'runtime_home_path', 'workspace_host_path', 'workspace_root', 'workspace_path', 'project_key', 'conversation_key'}:
                result[column] = self.text(value)
        if table == 'agent_session_runtime':
            result['container_name'] = 'cloudcli-migrated-' + result['runtime_id']
            if result['status'] != 'deleted':
                result['status'] = 'idle'
        if table == 'ai_usage_export_jobs' and original.get('filename'):
            result['filename'] = result['id'] + Path(original['filename']).suffix
        return result


def clone_tree(old, new, kind, transform, roots):
    """Private copies, no hard links; rewrite links only into other cloned roots."""
    stat = old.lstat()
    if old.is_symlink():
        link = os.readlink(old)
        resolved = (old.parent / link).resolve()
        destinations = [(a, b) for a, b in roots if under(resolved, a)]
        if not destinations:
            raise ValueError('外部符号链接会导致账户共享可写文件，拒绝复制: ' + str(old))
        a, b = max(destinations, key=lambda item: len(str(item[0])))
        target = b / resolved.relative_to(a)
        new.symlink_to(os.path.relpath(target, new.parent))
    elif old.is_dir():
        new.mkdir(mode=0o700)
        for entry in sorted(old.iterdir()):
            # Claude encodes the absolute project path in directory names.
            name = transform.text(entry.name) if kind in {'runtime', 'skill-evaluation'} else entry.name
            clone_tree(entry, new / name, kind, transform, roots)
        shutil.copystat(old, new, follow_symlinks=False)
    elif old.is_file():
        if kind == 'runtime' and old.suffix in {'.db', '.sqlite', '.sqlite3'}:
            raise ValueError('runtime 中含未支持的原生 SQLite 状态，不能保证独立副本: ' + str(old))
        # Never rewrite user project source code or binary assets.
        managed = kind in {'runtime', 'skill-evaluation'} or (kind == 'workspace' and (
            any(part in old.parts for part in ('.ccui', '.claude', '.cloudcli')) or old.name == '.mcp.json'))
        if kind == 'workspace' and old.name == '.git':
            # A linked worktree/submodule may point at mutable metadata outside
            # the copied tree even without using a filesystem symlink.
            content = old.read_text(encoding='utf-8').strip()
            if not content.startswith('gitdir: '):
                raise ValueError('无法识别的 Git 元数据指针: ' + str(old))
            gitdir = (old.parent / content[8:]).resolve()
            destinations = [(a, b) for a, b in roots if under(gitdir, a)]
            if not destinations:
                raise ValueError('Git worktree 引用了副本外的元数据: ' + str(old))
            a, b = max(destinations, key=lambda item: len(str(item[0])))
            with new.open('x', encoding='utf-8') as handle:
                handle.write('gitdir: ' + os.path.relpath(b / gitdir.relative_to(a), new.parent) + '\n')
            shutil.copystat(old, new)
        elif kind == 'workspace' and old.name == 'alternates' and old.parent.name == 'info' and old.parent.parent.name == 'objects' and old.stat().st_size:
            raise ValueError('Git alternates 引用了外部对象库，请先建立独立仓库: ' + str(old))
        elif managed and old.suffix in {'.json', '.jsonl'}:
            text = old.read_text(encoding='utf-8')
            if old.suffix == '.jsonl':
                content = '\n'.join(json.dumps(transform.value(json.loads(line)), ensure_ascii=False)
                                    for line in text.splitlines() if line.strip()) + ('\n' if text else '')
            else:
                content = json.dumps(transform.value(json.loads(text)), ensure_ascii=False, indent=2) + '\n'
            with new.open('x', encoding='utf-8') as handle:
                handle.write(content)
            shutil.copystat(old, new)
        else:
            with old.open('rb') as source, new.open('xb') as dest:
                shutil.copyfileobj(source, dest)
            shutil.copystat(old, new)
    else:
        raise ValueError('不支持的文件类型（socket/FIFO/device）: ' + str(old))
    # Preserve container ownership when running as root. Otherwise runtime startup
    # uses its existing ownership repair; source files are never chowned.
    if hasattr(os, 'geteuid') and os.geteuid() == 0:
        os.chown(new, stat.st_uid, stat.st_gid, follow_symlinks=False)


def row_key(info, row):
    columns = [c['name'] for c in info['columns'] if c['pk']]
    if not columns:
        raise ValueError('迁移表必须有主键')
    return ' AND '.join(quote(c) + ' IS ?' for c in columns), tuple(row[c] for c in columns)


def insert(db, table, row):
    db.execute('INSERT INTO ' + quote(table) + ' (' + ','.join(map(quote, row)) + ') VALUES ('
               + ','.join('?' for _ in row) + ')', tuple(row.values()))


def replace_rows(db, plan, maps, transform, online=False):
    info, source, target, source_rows, target_rows = plan
    # Defer composite-key FK checks through the entire delete/insert operation.
    db.execute('PRAGMA defer_foreign_keys=ON')
    for table, items in target_rows.items():
        if table in {'workspaces', 'session_names'}:
            continue
        for row in items:
            condition, params = row_key(info[table], row)
            db.execute('DELETE FROM ' + quote(table) + ' WHERE ' + condition, params)
    # Latest rows may be owned indirectly through a target job, without FKs.
    if 'skill_eval_latest' in info:
        for job in target_rows.get('skill_eval_jobs', []):
            db.execute('DELETE FROM skill_eval_latest WHERE job_id=?', (job['id'],))
    for workspace in target_rows['workspaces']:
        db.execute('DELETE FROM workspaces WHERE id=?', (workspace['id'],))
    # A session name is global in the schema. Delete only when no account uses it.
    if 'session_names' in info:
        for row in target_rows.get('session_names', []):
            if not db.execute('SELECT 1 FROM session_index WHERE provider=? AND provider_session_id=?',
                              (row['provider'], row['session_id'])).fetchone():
                db.execute('DELETE FROM session_names WHERE id=?', (row['id'],))
    # Avoid publishing stale target aggregates. Source snapshots remain untouched.
    old_workspaces = {r['id'] for r in target_rows['workspaces']}
    for table in sorted(CACHE_TABLES & set(info)):
        columns = {c['name'] for c in info[table]['columns']}
        conditions = []
        if 'user_id' in columns:
            conditions.append('user_id=' + str(target['id']))
        if 'workspace_id' in columns:
            conditions.append(in_values('workspace_id', old_workspaces))
        if conditions:
            db.execute('DELETE FROM ' + quote(table) + ' WHERE ' + ' OR '.join(conditions))
    # Workspace rows must exist before insert triggers resolve their tenant.
    for table in ['workspaces'] + sorted(set(source_rows) - {'workspaces'}):
        for original in source_rows[table]:
            copied = transform.row(table, original)
            if table == 'ai_usage_export_jobs' and 'ai_usage_tenant_state' in info:
                revision = db.execute('SELECT data_revision FROM ai_usage_tenant_state WHERE tenant_id=?',
                                      (copied['tenant_id'],)).fetchone()
                copied['data_revision'] = revision[0] if revision else 0
            insert(db, table, copied)
    profile = {key: source[key] for key in PROFILE_COLUMNS if key in source}
    if 'env' in profile:
        env = json.loads(profile['env'] or '{}')
        target_env = json.loads(target.get('env') or '{}')
        env.pop('USER_KEY', None)
        if 'USER_KEY' in target_env:
            env['USER_KEY'] = target_env['USER_KEY']
        profile['env'] = json.dumps(env, ensure_ascii=False)
    if profile:
        db.execute('UPDATE users SET ' + ','.join(quote(key) + '=?' for key in profile) + ' WHERE id=?',
                   tuple(profile.values()) + (target['id'],))
    if 'ai_usage_dirty_tenants' in info:
        tenants = {r['tenant_id'] for items in source_rows.values() for r in items if r.get('tenant_id') is not None}
        tenants.update(r['tenant_id'] for items in target_rows.values() for r in items if r.get('tenant_id') is not None)
        for tenant in tenants:
            db.execute('INSERT INTO ai_usage_dirty_tenants(tenant_id,generation) VALUES(?,1) '
                       'ON CONFLICT(tenant_id) DO UPDATE SET generation=generation+1', (tenant,))
            if online and 'ai_usage_batches' in info:
                # An in-flight report candidate predates the account overwrite.
                # Revoke its lease and rebuild it rather than publish old target
                # rows after unlock. Published rows for other users stay visible.
                batches = rows(db, 'ai_usage_batches', "tenant_id=? AND status IN ('running','paused','failed')", (tenant,))
                for batch in batches:
                    for cache in CACHE_TABLES & set(info):
                        if any(c['name'] == 'batch_id' for c in info[cache]['columns']) and (
                            cache.endswith('_staging') or cache in {'ai_usage_batch_files', 'ai_usage_skill_work_items', 'ai_usage_batch_session_exclusions'}
                        ):
                            db.execute('DELETE FROM ' + quote(cache) + ' WHERE batch_id=?', (batch['id'],))
                    db.execute("UPDATE ai_usage_batches SET status='paused',lease_token=NULL,lease_until=NULL,progress_json='{}' WHERE id=?", (batch['id'],))
                if 'ai_usage_tenant_state' in info:
                    db.execute("UPDATE ai_usage_tenant_state SET bootstrapped=0,bootstrap_json='{}' WHERE tenant_id=?", (tenant,))
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('迁移后外键检查失败，事务已取消')
    if dict(db.execute('SELECT * FROM users WHERE id=?', (source['id'],)).fetchone()) != source:
        raise ValueError('源账户发生变化，事务已取消')
    # Check every source row, including parents and child rows with no user_id.
    for table, items in source_rows.items():
        for original in items:
            condition, params = row_key(info[table], original)
            after = db.execute('SELECT * FROM ' + quote(table) + ' WHERE ' + condition, params).fetchone()
            if after is None or dict(after) != original:
                raise ValueError('源账户记录发生变化: ' + table)
    if not online and db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise ValueError('数据库完整性检查失败')


def write_json(filename, content):
    with Path(filename).open('x', encoding='utf-8') as handle:
        os.chmod(filename, 0o600)
        json.dump(content, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())


def run(args):
    if not Path(args.database).is_absolute():
        raise ValueError('--database 必须是绝对路径，避免操作错误实例')
    database = Path(args.database).resolve(strict=True)
    db = connect(database, readonly=not args.apply)
    created, destination, backup_directory = [], None, None
    committed = False
    marker = None
    try:
        if args.apply:
            if not args.offline or not args.backup_dir or not args.data_root:
                raise ValueError('--apply 必须同时指定 --offline、--backup-dir、--data-root')
            # Prevent writers during planning, backup, file staging and commit.
            db.execute('BEGIN IMMEDIATE')
        else:
            db.execute('BEGIN')
        plan = build_plan(db, args.source, args.target)
        report = summary(plan)
        if not args.apply:
            # Validate every registered source root, even when only previewing.
            # Full traversal/JSON/link validation happens in staging before SQL writes.
            preview_root = Path(args.data_root).resolve() if args.data_root else database.parent
            maps = allocate_maps(db, plan[0], plan[3])
            copies, _ = file_layout(plan[3], maps, preview_root / ('user-copy-preview-' + str(uuid.uuid4())), args.exports_root, skill_evals_root=getattr(args, 'skill_evals_root', None))
            report['source_paths'] = [{'path': str(old), 'kind': kind} for old, _, kind in copies]
            return {'dry_run': True, **report}
        if args.confirm_target != str(plan[2]['id']):
            raise ValueError('--confirm-target 必须与预览中的目标数字 ID 一致')
        data_root = Path(args.data_root).resolve(strict=True)
        backup_root = Path(args.backup_dir).resolve(strict=True)
        runtime_root = Path(args.runtime_root).resolve(strict=True) if getattr(args, 'runtime_root', None) else data_root
        if not all(p.is_dir() for p in (data_root, backup_root, runtime_root)):
            raise ValueError('--data-root 和 --backup-dir 必须是已有目录')
        run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(uuid.uuid4())[:8]
        destination = data_root / ('user-copy-' + run_id)
        runtime_destination = runtime_root / ('user-copy-' + run_id)
        maps = allocate_maps(db, plan[0], plan[3])
        copies, path_map = file_layout(plan[3], maps, destination, args.exports_root, runtime_destination, getattr(args, 'skill_evals_root', None))
        # Reject recursive copies, including backup/destination roots nested in
        # a source tree or a retained old target tree.
        protected = [old for old, _, kind in copies if kind != 'export']
        protected += [Path(r['path']) for r in plan[4]['workspaces']]
        protected += [Path(r['runtime_home_path']) for r in plan[4].get('agent_session_runtime', [])]
        if any(under(root, p.resolve()) for root in (data_root, backup_root, runtime_root) for p in protected):
            raise ValueError('数据/备份根目录不能位于现有工作区或 runtime 内部')
        backup_directory = backup_root / ('user-copy-' + run_id)
        backup_directory.mkdir(mode=0o700)
        backup_path = backup_directory / 'before.sqlite'
        # A separate reader sees the committed snapshot held stable by the writer lock.
        with closing(connect(database)) as backup_source, closing(sqlite3.connect(str(backup_path))) as backup_dest:
            backup_source.backup(backup_dest)
            backup_dest.execute('PRAGMA journal_mode=DELETE')
        os.chmod(backup_path, 0o600)
        manifest = {**report, 'database': str(database), 'backup': str(backup_path),
                    'destination': str(destination),
                    'runtime_destination': str(runtime_destination),
                    'file_copies': [{'source': str(a), 'target': str(b), 'kind': k} for a, b, k in copies],
                    'retained_target_workspaces': [r['path'] for r in plan[4]['workspaces']],
                    'retained_target_runtime_homes': [r['runtime_home_path'] for r in plan[4].get('agent_session_runtime', [])],
                    'id_maps': {t + '.' + c: mapping for (t, c), mapping in maps.items()}}
        write_json(backup_directory / 'manifest.json', manifest)
        transform = Transformer(plan[0], plan[1], plan[2], maps, path_map)
        for directory, root in dict([(destination, data_root), (runtime_destination, runtime_root)]).items():
            directory.mkdir(mode=0o700)
            created.append(directory)
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                owner = root.stat()
                os.chown(directory, owner.st_uid, owner.st_gid)
        roots = [(old, new) for old, new, kind in copies if kind != 'export']
        for old, new, kind in copies:
            new.parent.mkdir(parents=True, exist_ok=True)
            if kind in {'export', 'skill-evaluation'}:
                created.append(new)
            clone_tree(old, new, kind, transform, roots)
        replace_rows(db, plan, maps, transform)
        # Persist a transaction marker atomically with the data, so a crash after
        # COMMIT but before the result file cannot be mistaken for a rollback.
        marker = 'migration:user-copy:' + run_id
        if 'app_config' in plan[0]:
            db.execute('INSERT INTO app_config(key,value) VALUES(?,?)',
                       (marker, json.dumps({'source': plan[1]['id'], 'target': plan[2]['id']})))
        db.execute('COMMIT')
        committed = True
        result = {'dry_run': False, 'committed': True, 'backup': str(backup_path),
                  'manifest': str(backup_directory / 'manifest.json'), 'marker': marker, **report}
        write_json(backup_directory / 'result.json', result)
        return result
    except BaseException:
        if db.in_transaction:
            db.execute('ROLLBACK')
        if not committed and marker:
            try:
                committed = bool(db.execute('SELECT 1 FROM app_config WHERE key=?', (marker,)).fetchone())
            except sqlite3.Error:
                committed = True
        if not committed:
            for item in reversed(created):
                if item.is_dir() and not item.is_symlink():
                    shutil.rmtree(item)
                elif item.exists() or item.is_symlink():
                    item.unlink()
        else:
            print('数据库已提交或提交结果暂无法确认；副本已保留。请检查备份 manifest 和 app_config 迁移标记，勿直接重试。', file=sys.stderr)
        if backup_directory:
            print('迁移备份/清单: ' + str(backup_directory), file=sys.stderr)
        raise
    finally:
        if db.in_transaction:
            db.execute('ROLLBACK')
        db.close()


def parser():
    result = argparse.ArgumentParser(description='CCUI 同实例账户复制覆盖；默认只读预览，源账户保留。')
    result.add_argument('--database', required=True, help='auth.db 的绝对路径（不会自动读取 .env）')
    result.add_argument('--source', required=True, help='源用户名，或 id:123')
    result.add_argument('--target', required=True, help='目标用户名，或 id:456')
    result.add_argument('--apply', action='store_true', help='执行覆盖')
    result.add_argument('--offline', action='store_true', help='声明所有 CCUI 服务、调度器和 runtime 容器均已停止')
    result.add_argument('--confirm-target', help='预览确认的目标账户数字 ID')
    result.add_argument('--backup-dir', help='已有备份目录')
    result.add_argument('--data-root', help='已有持久化数据目录；创建独立副本子目录')
    result.add_argument('--runtime-root', help='可选：runtime 副本的独立目录，默认与 data-root 相同')
    result.add_argument('--exports-root', help='实例现有的 AI 导出文件目录（有导出文件时必填）')
    result.add_argument('--skill-evals-root', help='实例现有技能评测报告目录（有评测记录时必填）')
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(run(parser().parse_args()), ensure_ascii=False, indent=2))
    except (OSError, ValueError, sqlite3.Error) as error:
        print('迁移失败: ' + str(error), file=sys.stderr)
        sys.exit(1)
