#!/usr/bin/env python3
"""One-command online account copy; never stop the CCUI service."""
import argparse
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ccui_account_copy', ROOT / 'scripts/migrate-user-data.py')
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)
ONLINE_SPEC = importlib.util.spec_from_file_location('account_copy_online', ROOT / 'scripts/account_copy_online.py')
online = importlib.util.module_from_spec(ONLINE_SPEC)
ONLINE_SPEC.loader.exec_module(online)
SETTINGS = {'DATABASE_PATH', 'WORKSPACES_ROOT', 'CLOUDCLI_RUNTIME_ROOT', 'CLOUDCLI_DATA_ROOT',
            'CCUI_MIGRATION_EXPORTS_ROOT', 'SKILL_EVAL_STORAGE_ROOT'}


def load_settings(root=ROOT, environ=None):
    environ = os.environ if environ is None else environ
    values = {}
    filename = root / '.env'
    if filename.is_file():
        for line in filename.read_text(encoding='utf-8').splitlines():
            match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
            if not match or match[1] not in SETTINGS:
                continue
            value = match[2].strip()
            if value.startswith(('"', "'")):
                end = value.find(value[0], 1)
                tail = value[end + 1:].strip()
                if end == -1 or (tail and not tail.startswith('#')):
                    raise ValueError('.env 路径格式错误: ' + match[1])
                value = value[1:end]
            else:
                value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
            values[match[1]] = value
    values.update({key: environ[key] for key in SETTINGS if environ.get(key)})
    for key, value in values.items():
        if '$' in value or '`' in value or '\0' in value:
            raise ValueError(key + ' 必须是实际路径，不能包含 shell 表达式')
    return values


def configured_path(value, root=ROOT):
    result = Path(value).expanduser()
    return (result if result.is_absolute() else root / result).resolve()


def find_database(settings, root=ROOT, home=None):
    home = Path.home() if home is None else home
    if settings.get('DATABASE_PATH'):
        candidate = configured_path(settings['DATABASE_PATH'], root)
        if not candidate.is_file():
            raise ValueError('DATABASE_PATH 指定的数据库不存在: ' + str(candidate))
        return candidate
    candidates = [home / '.cloudcli/auth.db', root / 'server/database/auth.db',
                  root / 'dist-server/server/database/auth.db']
    found = {p.resolve() for p in candidates if p.is_file()}
    if len(found) != 1:
        raise ValueError('未找到唯一数据库，请在项目 .env 中设置 DATABASE_PATH')
    return found.pop()


def command(args, allowed=(0,), timeout=60):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode not in allowed:
        # Never echo inspect/environment output, which may contain credentials.
        raise RuntimeError('命令失败: ' + ' '.join(args[:2]) + '；退出码 ' + str(result.returncode))
    return result


def docker_inventory():
    docker = shutil.which('docker')
    if not docker:
        return []
    result = command([docker, 'ps', '-q'], allowed=(0, 1), timeout=10)
    if result.returncode:
        raise RuntimeError('Docker 无法连接，无法确认 runtime 是否仍在写入；请启动 Docker 后重试')
    ids = result.stdout.split()
    if not ids:
        return []
    return json.loads(command([docker, 'inspect', *ids], timeout=20).stdout)


def select_runtimes(inventory, runtime_names):
    # Only runtime containers identified by the scoped database rows. Never touch
    # the application server or a runtime that was already paused by its owner.
    selected = []
    for container in inventory:
        state = container.get('State', {})
        if (container.get('Name', '').lstrip('/') in runtime_names
                and state.get('Running') and not state.get('Paused')):
            if not re.fullmatch(r'[a-f0-9]{12,64}', container['Id']):
                raise ValueError('Docker 返回的容器 ID 格式无效')
            selected.append(container['Id'])
    return selected


def restore_runtimes(ids):
    for container_id in ids:
        result = command(['docker', 'inspect', '-f', '{{json .State}}', container_id], allowed=(0, 1), timeout=10)
        if result.returncode:
            if re.search(r'No such (?:object|container)', result.stderr, re.I):
                continue
            raise RuntimeError('Docker inspect 失败，不能确认 runtime 已恢复')
        if json.loads(result.stdout).get('Paused'):
            resumed = command(['docker', 'unpause', container_id], allowed=(0, 1), timeout=10)
            if resumed.returncode and not re.search(r'is not paused|No such (?:object|container)', resumed.stderr, re.I):
                raise RuntimeError('Docker unpause 失败，后端会继续恢复')


def migrate(source_selector, target_selector, root=ROOT, environ=None, timeout=300):
    settings = load_settings(root, environ)
    database = find_database(settings, root)
    if Path('/.dockerenv').exists():
        raise ValueError('请在部署宿主机执行一键迁移（需要相同的数据库和文件路径）')
    with closing(engine.connect(database, readonly=False)) as db:
        source = engine.find_user(db, source_selector)
        target = engine.find_user(db, target_selector)
        if source['id'] == target['id']:
            raise ValueError('源账户和目标账户不能相同')
        engine.inspect_schema(engine.schema(db))
        scope, _ = online.scope_for(engine, db, source, target)
        home = Path.home()
        workspace_root = configured_path(settings.get('WORKSPACES_ROOT', str(home)), root)
        runtime_root = configured_path(settings.get('CLOUDCLI_RUNTIME_ROOT', str(home / '.cloudcli/runtimes')), root)
        storage_root = configured_path(settings.get('CLOUDCLI_DATA_ROOT', str(database.parent)), root)
        args = argparse.Namespace(database=str(database), source='id:' + str(source['id']), target='id:' + str(target['id']),
            data_root=str(workspace_root / '.account-copies'), runtime_root=str(runtime_root / '.account-copies'),
            backup_dir=str(storage_root / 'account-copy-backups'),
            exports_root=settings.get('CCUI_MIGRATION_EXPORTS_ROOT') or None,
            skill_evals_root=settings.get('SKILL_EVAL_STORAGE_ROOT') or None)
        if args.skill_evals_root:
            args.skill_evals_root = str(configured_path(args.skill_evals_root, root))
        if args.exports_root:
            args.exports_root = str(configured_path(args.exports_root, root))
        if any(engine.under(Path(directory), Path(existing)) for directory in
               (args.data_root, args.runtime_root, args.backup_dir) for existing in scope['paths']):
            raise ValueError('副本或备份目录不能位于现有工作区/runtime 内')
        lease = online.Lease(engine, database, scope, timeout=timeout)
        lease.start(db)
        result, restored = None, False
        try:
            print('在线复制 {} → {}，覆盖目标业务数据；源账户保留。'.format(source['username'], target['username']), flush=True)
            print('正在暂停这两个账号及相关工作区的新请求，等待已有操作结束…', flush=True)
            # An operation admitted just before the gate may create another
            # workspace. Expand the barrier and drain again until scope is stable.
            for _ in range(3):
                lease.wait_ready(db, 'draining')
                refreshed, runtimes = online.scope_for(engine, db, source, target)
                if refreshed == lease.scope:
                    break
                lease.scope = refreshed
                lease.change(db)
            else:
                raise RuntimeError('账号范围持续变化，取消迁移后重试')
            lease.change(db, 'frozen')
            lease.wait_ready(db, 'frozen')
            inventory = docker_inventory()
            names = {row['container_name'] for row in runtimes}
            if names and not shutil.which('docker'):
                raise ValueError('需要 Docker CLI 确认并暂停相关 runtime')
            lease.scope['pausedContainers'] = select_runtimes(inventory, names)
            lease.change(db)  # Durable recovery intent BEFORE the first pause.
            for container_id in lease.scope['pausedContainers']:
                lease.assert_owned(db)
                command(['docker', 'pause', container_id], timeout=10)
            lease.assert_owned(db)
            for directory in (args.data_root, args.runtime_root, args.backup_dir):
                Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                for directory, parent in ((args.data_root, workspace_root), (args.runtime_root, runtime_root)):
                    owner = parent.stat()
                    os.chown(directory, owner.st_uid, owner.st_gid)
            print('正在备份并复制文件，其他用户可以继续使用…', flush=True)
            result = online.copy_frozen(engine, args, db, lease)
            print('复制已提交。备份: ' + result['backup'], flush=True)
            print('迁移清单: ' + result['manifest'], flush=True)
        finally:
            try:
                restore_runtimes(lease.scope['pausedContainers'])
                restored = True
            finally:
                if restored:
                    lease.finish(db, 'complete' if result else 'failed')
                else:
                    lease.stop_event.set()
                    print('runtime 恢复暂未成功，后端将在租约到期后自动重试；相关账号暂时保持暂停。', file=sys.stderr)
        print('迁移完成；相关账号、工作区及原本运行的 runtime 已恢复，服务全程未停止。', flush=True)
        return result


def main():
    parser = argparse.ArgumentParser(description='不停服一键复制覆盖账户，仅暂停相关账号/工作区，自动备份和恢复。')
    parser.add_argument('source', nargs='?', help='源用户名，或 id:123')
    parser.add_argument('target', nargs='?', help='目标用户名，或 id:456')
    parser.add_argument('--wait-seconds', type=int, default=300, help='等待相关在途操作结束的秒数，默认 300')
    args = parser.parse_args()
    if args.wait_seconds < 1:
        raise ValueError('--wait-seconds 必须大于 0')
    source = args.source or input('源账号: ').strip()
    target = args.target or input('目标账号（业务数据将被覆盖）: ').strip()
    if not source or not target:
        raise ValueError('源账号和目标账号不能为空')
    # SIGTERM unwinds the transaction and restores only scoped runtimes.
    def interrupt(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    migrate(source, target, timeout=args.wait_seconds)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError, EOFError) as error:
        print('迁移失败: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print('迁移已中断；请核对上方的提交和服务恢复结果。', file=sys.stderr)
        sys.exit(130)
