#!/usr/bin/env node
// Run the actual application against disposable users, workspaces and files.
// No production .env, database, provider home, or model credentials are loaded.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { utils, write } from 'xlsx';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, 'artifacts/file-preview-e2e');
const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccui-files-e2e-')));
const appRoot = path.join(temporary, 'app');
const testHome = path.join(temporary, 'test-home');
const workspaceRoot = path.join(temporary, 'workspaces');
const databasePath = path.join(temporary, 'auth.db');
const port = Number(process.env.FILE_PREVIEW_E2E_PORT || 4420);
const origin = `http://127.0.0.1:${port}`;
const manifestPath = path.join(evidence, 'manifest.json');
let server;
let closing = false;
let lifetimeTimer;

await Promise.all([mkdir(evidence, { recursive: true }), mkdir(appRoot), mkdir(testHome), mkdir(workspaceRoot)]);
const serverLogPath = path.join(evidence, 'server.log');
const requestLogPath = path.join(evidence, 'requests.jsonl');
const serverLog = createWriteStream(serverLogPath, { flags: 'w' });
await writeFile(requestLogPath, '');

function redactLogTokens(value) {
  return value
    .replace(/(\bBearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]');
}

function captureLogs(input) {
  // Redact complete lines so a JWT split across process output chunks is also
  // removed before it reaches the durable E2E evidence log.
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const redactor = new Transform({
    transform(chunk, _encoding, callback) {
      pending += decoder.write(chunk);
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline !== -1) {
        this.push(redactLogTokens(pending.slice(0, lastNewline + 1)));
        pending = pending.slice(lastNewline + 1);
      }
      callback();
    },
    flush(callback) { this.push(redactLogTokens(pending + decoder.end())); callback(); },
  });
  input.pipe(redactor).pipe(serverLog, { end: false });
}

async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetimeTimer);
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => { server.kill('SIGKILL'); }, 5000);
      server.once('exit', () => { clearTimeout(timeout); resolve(); });
      server.kill('SIGTERM');
    });
  }
  serverLog.end();
  await rm(temporary, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await close(); process.exit(0); });

try {
  await Promise.all([
    cp(path.join(root, 'server'), path.join(appRoot, 'server'), {
      recursive: true,
      filter: (source) => !/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(source) && !/\.test\.[cm]?[jt]sx?$/.test(source),
    }),
    cp(path.join(root, 'shared'), path.join(appRoot, 'shared'), { recursive: true }),
    symlink(path.join(root, 'node_modules'), path.join(appRoot, 'node_modules'), 'dir'),
    symlink(path.join(root, 'dist'), path.join(appRoot, 'dist'), 'dir'),
    writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'ccui-file-preview-e2e', version: '0.0.0', type: 'module' })),
    writeFile(path.join(appRoot, '.env'), '# Isolated E2E instance. Deliberately empty.\n'),
    // A pre-existing empty file prevents the legacy production-db migration.
    writeFile(databasePath, ''),
  ]);

  const primaryPath = path.join(workspaceRoot, 'primary');
  const privatePath = path.join(workspaceRoot, 'private');
  const secondaryPath = path.join(workspaceRoot, 'secondary');
  await Promise.all([primaryPath, privatePath, secondaryPath].map((directory) => mkdir(directory)));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#e0e7ff"/><circle cx="1000" cy="165" r="85" fill="#fbbf24"/><path d="M0 680L320 200L690 680ZM420 680L850 300L1250 680Z" fill="#8b5cf6"/><text x="60" y="95" font-family="sans-serif" font-size="40" fill="#312e81">CCUI Image Preview E2E</text></svg>');
  const png = await sharp(svg).png().toBuffer();
  const book = utils.book_new();
  const summary = utils.aoa_to_sheet([
    ['项目', '数量', '单价', '日期', '备注'],
    ['图片预览', 3, 12.5, new Date('2026-09-20T00:00:00Z'), '正常文本'],
    ['工作表预览', 4, 8.25, new Date('2026-09-21T00:00:00Z'), '<script>alert("fixture")</script>'],
    ['含缓存公式', null, null, null, '缓存结果应显示 7'],
    ['无缓存公式', null, null, null, '显示公式，不进行重算'],
  ], { cellDates: true, dateNF: 'yyyy-mm-dd' });
  summary.B4 = { t: 'n', f: 'SUM(B2:B3)', v: 7 };
  summary.B5 = { t: 'n', f: 'SUM(B2:B3)' };
  summary.C2.z = '0.00';
  summary.C3.z = '0.00';
  utils.book_append_sheet(book, summary, '销售概览');
  utils.book_append_sheet(book, utils.aoa_to_sheet([]), '空白工作表');
  utils.book_append_sheet(book, utils.aoa_to_sheet(Array.from({ length: 1100 }, (_, row) => Array.from({ length: 110 }, (_, col) => row === 0 ? `字段 ${col + 1}` : `R${row + 1}C${col + 1}`))), '大表 1100×110');
  const emptyBook = utils.book_new();
  utils.book_append_sheet(emptyBook, utils.aoa_to_sheet([]), '空白工作表');
  const xlsx = write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
  const fixtures = new Map([
    ['sample.png', png], ['sample.svg', svg], ['图片 预览.png', png],
    ['broken.png', Buffer.from('Not an image')], ['oversized.png', Buffer.alloc(21 * 1024 * 1024)],
    ['sample.xlsx', xlsx], ['中文 报表.xlsx', xlsx],
    ['empty.xlsx', write(emptyBook, { type: 'buffer', bookType: 'xlsx' })],
    ['broken.xlsx', Buffer.from('Not an XLSX file')], ['repairable.xlsx', Buffer.from('Not an XLSX file')],
    ['oversized.xlsx', Buffer.alloc(11 * 1024 * 1024)],
    ['README.txt', Buffer.from('Disposable file preview E2E workspace.\n')],
  ]);
  await Promise.all([...fixtures].map(([name, body]) => writeFile(path.join(primaryPath, name), body)));
  await writeFile(path.join(privatePath, 'private.xlsx'), xlsx);
  await writeFile(path.join(secondaryPath, 'secondary.xlsx'), xlsx);
  await writeFile(path.join(workspaceRoot, 'outside-workspace.txt'), 'E2E path escape must not expose this file.');
  // A symlink checks that filesystem isolation is enforced after resolution.
  await symlink(path.join(privatePath, 'private.xlsx'), path.join(primaryPath, 'escape.xlsx'));

  const preloadPath = path.join(appRoot, 'e2e-preload.mjs');
  await writeFile(preloadPath, `
import os from 'node:os';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(testHome)};
syncBuiltinESMExports();
// Keep native statements alive for the bundled Node 24 addon finalizer issue.
// This changes only the disposable harness and never production source files.
const retainedStatements = [];
if (process.versions.node.startsWith('24.')) {
  const native = createRequire(import.meta.url)('better-sqlite3/build/Release/better_sqlite3.node');
  const prepare = native.Database.prototype.prepare;
  native.Database.prototype.prepare = function(...args) {
    const statement = prepare.apply(this, args);
    retainedStatements.push(statement);
    return statement;
  };
}
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, ...args) {
  if (event === 'request') {
    const [req, res] = args;
    const started = Date.now();
    res.once('finish', () => {
      const url = new URL(req.url, 'http://localhost');
      for (const key of [...url.searchParams.keys()]) if (/token|key|secret|password|credential/i.test(key)) url.searchParams.set(key, '[redacted]');
      fs.appendFileSync(${JSON.stringify(requestLogPath)}, JSON.stringify({time: new Date().toISOString(), method: req.method, url: url.pathname + url.search, status: res.statusCode, bytes: res.getHeader('content-length') ?? null, ms: Date.now() - started}) + '\\n');
    });
  }
  return originalEmit.call(this, event, ...args);
};
`);

  // Inherit only runtime essentials; provider credentials and routing settings
  // from the developer's shell must not reach this disposable application.
  const childEnv = {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}`,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TZ: 'Asia/Shanghai', NODE_ENV: 'production',
    DATABASE_PATH: databasePath, WORKSPACES_ROOT: workspaceRoot,
    CLOUDCLI_RUNTIME_ROOT: path.join(temporary, 'runtimes'),
    AI_USAGE_ENABLED: 'false', CODEHUB_MR_POLLER_ENABLED: 'false',
    CLOUDCLI_RUNTIME_SWEEPER_ENABLED: 'false',
    SERVER_PORT: String(port), HOST: '127.0.0.1',
    TSX_TSCONFIG_PATH: path.join(appRoot, 'server/tsconfig.json'),
    JWT_SECRET: 'disposable-file-preview-e2e-jwt-secret',
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: '1000', GRACEFUL_SHUTDOWN_POLL_MS: '100',
  };
  const manifest = {
    origin, tempRoot: temporary, appRoot, databasePath,
    users: Object.fromEntries(['admin', 'member', 'viewer', 'outsider'].map((role) => [role, { username: `preview_${role}`, password: 'PreviewE2e-2026!' }])),
    tenants: {}, workspaces: {},
    files: [...fixtures].map(([name, body]) => ({ name, size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') })),
    logs: { server: serverLogPath, requests: requestLogPath },
    startedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const seedPath = path.join(appRoot, 'e2e-seed.mjs');
  await writeFile(seedPath, `
import fs from 'node:fs/promises';
import bcrypt from 'bcrypt';
const { initializeDatabase, userDb, db } = await import('./server/database/db.js');
await initializeDatabase();
const { multitenancyDb: multi } = await import('./server/database/multitenancy-db.js');
const manifestPath = ${JSON.stringify(manifestPath)};
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
for (const [role, account] of Object.entries(manifest.users)) {
  const user = userDb.createUser(account.username, await bcrypt.hash(account.password, 10), { isSystemAdmin: role === 'admin' });
  userDb.updateGitConfig(user.id, account.username, account.username + '@example.invalid');
  userDb.completeOnboarding(user.id);
  account.id = user.id;
}
for (const key of ['primary', 'secondary']) {
  const tenant = multi.tenants.createTenant({code: 'preview-' + key, name: key === 'primary' ? '预览测试租户' : '隔离测试租户'});
  manifest.tenants[key] = {id: tenant.id, code: tenant.code};
}
for (const role of ['admin', 'member', 'viewer']) multi.memberships.upsertMembership({tenantId: manifest.tenants.primary.id, userId: manifest.users[role].id, role: role === 'admin' ? 'system_admin' : 'member', permission: role === 'viewer' ? 'view' : 'edit'});
multi.memberships.upsertMembership({tenantId: manifest.tenants.secondary.id, userId: manifest.users.outsider.id, role: 'member', permission: 'edit'});
const definitions = [
  ['primary', 'primary', 'member', ${JSON.stringify(primaryPath)}, '文件预览端到端测试'],
  ['private', 'primary', 'admin', ${JSON.stringify(privatePath)}, '未共享工作区'],
  ['secondary', 'secondary', 'outsider', ${JSON.stringify(secondaryPath)}, '其他租户工作区'],
];
for (const [key, tenantKey, ownerKey, path, displayName] of definitions) {
  const workspace = multi.workspaces.createWorkspace({tenantId: manifest.tenants[tenantKey].id, ownerUserId: manifest.users[ownerKey].id, slug: 'preview-' + key, displayName, path});
  manifest.workspaces[key] = {id: workspace.id, tenantId: workspace.tenant_id, slug: workspace.slug, path: workspace.path};
}
multi.workspaceAcl.replaceAcl({workspaceId: manifest.workspaces.primary.id, ownerUserId: manifest.users.member.id, entries: [{userId: manifest.users.viewer.id, permission: 'view'}, {userId: manifest.users.admin.id, permission: 'edit'}]});
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\\n');
db.close();
`);
  const imports = ['--import', preloadPath, '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs')];
  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, [...imports, seedPath], { cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    captureLogs(seed.stdout);
    captureLogs(seed.stderr);
    const timeout = setTimeout(() => { seed.kill('SIGKILL'); reject(new Error('E2E database seed timed out')); }, 30000);
    seed.once('error', reject);
    seed.once('exit', (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`E2E seed exited ${code}; see ${serverLogPath}`)); });
  });
  server = spawn(process.execPath, [...imports, path.join(appRoot, 'server/index.js')], { cwd: appRoot, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  captureLogs(server.stdout);
  captureLogs(server.stderr);
  server.once('error', (error) => console.error(error));
  server.once('exit', async (code) => {
    if (!closing) { console.error(`E2E server exited ${code}; see ${serverLogPath}`); await close(); process.exit(code || 1); }
  });
  const readyDeadline = Date.now() + 30000;
  while (Date.now() < readyDeadline) {
    if (server.exitCode !== null) throw new Error('E2E server exited during startup');
    try {
      const response = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* wait for the actual application to listen */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const status = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(2000) });
  if (!status.ok) throw new Error(`E2E auth health status: ${status.status}`);
  const seeded = JSON.parse(await readFile(manifestPath, 'utf8'));
  seeded.serverPid = server.pid;
  seeded.launcherPid = process.pid;
  seeded.readyAt = new Date().toISOString();
  await writeFile(manifestPath, `${JSON.stringify(seeded, null, 2)}\n`);
  console.log(`Actual CCUI E2E application ready: ${origin}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Disposable member: ${seeded.users.member.username} / ${seeded.users.member.password}`);
  lifetimeTimer = setTimeout(async () => { console.error('E2E instance reached its two-hour lifetime; cleaning up.'); await close(); process.exit(0); }, 2 * 60 * 60 * 1000);
} catch (error) {
  await close();
  throw error;
}
