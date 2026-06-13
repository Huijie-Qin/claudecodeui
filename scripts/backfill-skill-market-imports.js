#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import Database from 'better-sqlite3';

import { MULTITENANCY_SCHEMA_SQL } from '../server/database/multitenancy-schema.js';

const DEFAULT_DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const skillName = requiredArg(args, 'skill-name');
const skillId = requiredArg(args, 'skill-id');
const remoteId = args['remote-id'] || skillId;
const displayName = args['display-name'] || skillName;
const nspPath = args['nsp-path'] || '';
const createUserId = args['create-user-id'] || null;
const version = parseNonNegativeInteger(args.version ?? '0', 'version');
const databasePath = args['database-path'] || process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH;
const apply = Boolean(args.apply);
const workspaceIdFilter = args['workspace-id']
  ? parsePositiveInteger(args['workspace-id'], 'workspace-id')
  : null;
const tenantIdFilter = args['tenant-id']
  ? parsePositiveInteger(args['tenant-id'], 'tenant-id')
  : null;
const expectedSha256 = args['expected-sha256'] || null;

if (!fs.existsSync(databasePath)) {
  fail(`Database does not exist: ${databasePath}`);
}

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.exec(MULTITENANCY_SCHEMA_SQL);

const workspaces = listCandidateWorkspaces(db, { workspaceIdFilter, tenantIdFilter });
const matches = [];
const conflicts = [];

for (const workspace of workspaces) {
  const skillPath = path.join(workspace.path, '.claude', 'skills', skillName);
  const manifestPath = path.join(skillPath, 'SKILL.md');

  if (!fs.existsSync(manifestPath)) continue;

  let directorySha256 = null;
  if (expectedSha256) {
    directorySha256 = hashDirectory(skillPath);
    if (directorySha256 !== expectedSha256) {
      conflicts.push({
        workspace,
        reason: `hash mismatch: ${directorySha256}`,
      });
      continue;
    }
  }

  matches.push({
    workspace,
    skillPath,
    directorySha256,
  });
}

printSummary({
  databasePath,
  skillName,
  skillId,
  remoteId,
  displayName,
  nspPath,
  createUserId,
  version,
  apply,
  scannedCount: workspaces.length,
  matches,
  conflicts,
});

if (!apply) {
  console.log('');
  console.log('Dry run only. Re-run with --apply to write workspace_skill_market_imports.');
  process.exit(0);
}

const upsert = db.prepare(`
  INSERT INTO workspace_skill_market_imports (
    workspace_id,
    skill_name,
    skill_id,
    remote_id,
    display_name,
    nsp_path,
    create_user_id,
    version,
    source,
    imported_at,
    updated_at
  )
  VALUES (
    @workspaceId,
    @skillName,
    @skillId,
    @remoteId,
    @displayName,
    @nspPath,
    @createUserId,
    @version,
    'skill-market-api',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT(workspace_id, skill_name)
  DO UPDATE SET
    skill_id = excluded.skill_id,
    remote_id = excluded.remote_id,
    display_name = excluded.display_name,
    nsp_path = excluded.nsp_path,
    create_user_id = excluded.create_user_id,
    version = excluded.version,
    source = excluded.source,
    updated_at = CURRENT_TIMESTAMP
`);

const writeImports = db.transaction((rows) => {
  for (const row of rows) {
    upsert.run({
      workspaceId: row.workspace.id,
      skillName,
      skillId,
      remoteId,
      displayName,
      nspPath,
      createUserId,
      version,
    });
  }
});

writeImports(matches);

console.log('');
console.log(`Backfill complete. Upserted ${matches.length} workspace import record(s).`);

function listCandidateWorkspaces(database, { workspaceIdFilter, tenantIdFilter }) {
  const where = ["status = 'active'"];
  const values = [];

  if (workspaceIdFilter) {
    where.push('id = ?');
    values.push(workspaceIdFilter);
  }

  if (tenantIdFilter) {
    where.push('tenant_id = ?');
    values.push(tenantIdFilter);
  }

  return database.prepare(`
    SELECT id, tenant_id, owner_user_id, slug, display_name, path
    FROM workspaces
    WHERE ${where.join(' AND ')}
    ORDER BY tenant_id ASC, owner_user_id ASC, id ASC
  `).all(...values);
}

function hashDirectory(directory) {
  const files = [];
  collectFiles(directory, directory, files);
  const hash = crypto.createHash('sha256');

  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(file.absolutePath));
    hash.update('\0');
  }

  return hash.digest('hex');
}

function collectFiles(root, current, files) {
  const entries = fs.readdirSync(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;

    files.push({
      absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
    });
  }
}

function printSummary({
  databasePath,
  skillName,
  skillId,
  remoteId,
  displayName,
  nspPath,
  createUserId,
  version,
  apply,
  scannedCount,
  matches,
  conflicts,
}) {
  console.log(`Database: ${databasePath}`);
  console.log(`Mode: ${apply ? 'apply' : 'dry-run'}`);
  console.log(`Skill: ${skillName}`);
  console.log(`Market: skillId=${skillId}, remoteId=${remoteId}, displayName=${displayName}, version=${version}`);
  if (nspPath) console.log(`NSP path: ${nspPath}`);
  if (createUserId) console.log(`Create user: ${createUserId}`);
  console.log(`Scanned active workspaces: ${scannedCount}`);
  console.log(`Matched workspaces: ${matches.length}`);
  console.log(`Skipped hash conflicts: ${conflicts.length}`);

  for (const match of matches.slice(0, 50)) {
    const workspace = match.workspace;
    const hashSuffix = match.directorySha256 ? ` sha256=${match.directorySha256}` : '';
    console.log(`  + workspace_id=${workspace.id} tenant_id=${workspace.tenant_id} owner_user_id=${workspace.owner_user_id} path=${workspace.path}${hashSuffix}`);
  }

  if (matches.length > 50) {
    console.log(`  ... ${matches.length - 50} more match(es) omitted`);
  }

  for (const conflict of conflicts.slice(0, 20)) {
    const workspace = conflict.workspace;
    console.log(`  ! workspace_id=${workspace.id} path=${workspace.path} ${conflict.reason}`);
  }

  if (conflicts.length > 20) {
    console.log(`  ... ${conflicts.length - 20} more conflict(s) omitted`);
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (!token.startsWith('--')) {
      fail(`Unexpected argument: ${token}`);
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex !== -1) {
      parsed[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }

  return parsed;
}

function requiredArg(parsed, name) {
  const value = parsed[name];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  fail(`Missing required --${name}`);
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`--${name} must be a positive integer`);
  }
  return number;
}

function parseNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    fail(`--${name} must be a non-negative integer`);
  }
  return number;
}

function fail(message) {
  console.error(message);
  console.error('');
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`
Backfill workspace skill market imports from existing .claude/skills folders.

Usage:
  node scripts/backfill-skill-market-imports.js \\
    --skill-name <runtime-folder-name> \\
    --skill-id <market-skill-id> \\
    --remote-id <market-remote-id> \\
    --display-name <market-display-name> \\
    --version <published-version> \\
    [--nsp-path <market-nsp-path>] \\
    [--create-user-id <market-create-user-id>] \\
    [--database-path <auth.db>] \\
    [--tenant-id <tenant-id>] \\
    [--workspace-id <workspace-id>] \\
    [--expected-sha256 <directory-sha256>] \\
    [--apply]

Defaults:
  --database-path defaults to DATABASE_PATH or ${DEFAULT_DATABASE_PATH}
  --remote-id defaults to --skill-id
  --display-name defaults to --skill-name
  --version defaults to 0

Without --apply this only prints the workspaces that would be updated.
`);
}
