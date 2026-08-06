import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { userDb } from '../database/db.js';

import { applyWorkspaceOwnership } from './workspace-ownership.js';

const execFileAsync = promisify(execFile);
const PRIVATE_TOKEN_ENV_NAME = 'PRIVATE_TOKEN';
const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

function createHttpError(message, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

function sanitizeOutput(value, token = '') {
  let output = String(value || '');
  if (token) output = output.split(token).join('[redacted]');
  return output
    .replace(/https?:\/\/[^@\s]+@/gi, (match) => `${match.startsWith('https:') ? 'https://' : 'http://'}[redacted]@`)
    .slice(0, 4000);
}

function normalizeRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

async function normalizeRepositoryOwnership(repoPath, reason, targetPaths = [repoPath]) {
  const existingTargets = [];
  for (const targetPath of targetPaths) {
    if (await pathExists(targetPath)) {
      existingTargets.push(targetPath);
    }
  }
  if (existingTargets.length === 0) return;

  return applyWorkspaceOwnership({
    workspaceRoot: repoPath,
    targetPaths: existingTargets,
    recursive: true,
    includeParents: true,
    reason,
  });
}

async function withOwnershipFinalizer(operation, finalizer) {
  let primaryError = null;
  try {
    return await operation();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await finalizer();
    } catch (ownershipError) {
      if (!primaryError) throw ownershipError;
      console.error('[workspace-ownership] Failed while preserving primary CodeHub Git error:', ownershipError);
    }
  }
}

async function normalizeChangedRepositoryOwnership(repoPath, reason, {
  beforeHead = '',
  knownPaths = [],
  includeStatus = false,
} = {}) {
  const relativePaths = new Set(knownPaths.map(normalizeRelativePath).filter(Boolean));

  if (beforeHead) {
    const { stdout: currentHeadOutput } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })
      .catch(() => ({ stdout: '' }));
    const currentHead = currentHeadOutput.trim();
    if (currentHead && currentHead !== beforeHead) {
      const { stdout: changedOutput } = await runGit(
        ['diff', '--name-only', `${beforeHead}..${currentHead}`],
        { cwd: repoPath },
      ).catch(() => ({ stdout: '' }));
      for (const changedPath of changedOutput.split(/\r?\n/)) {
        const normalized = normalizeRelativePath(changedPath);
        if (normalized) relativePaths.add(normalized);
      }
    }
  }

  if (includeStatus) {
    const entries = await listStatusEntries(repoPath).catch(() => []);
    for (const entry of entries) {
      if (entry.path) relativePaths.add(entry.path);
    }
  }

  await normalizeRepositoryOwnership(repoPath, reason, [
    path.join(repoPath, '.git'),
    ...Array.from(relativePaths, (relativePath) => path.join(repoPath, relativePath)),
  ]);
}

function normalizeGitFilePath(value) {
  const normalized = normalizeRelativePath(value);
  if (!normalized || normalized.split('/').includes('..')) {
    throw createHttpError('Invalid file path', 400);
  }
  return normalized;
}

function validateBranchName(branch) {
  const value = String(branch || '').trim();
  if (!/^[A-Za-z0-9._\/-]+$/.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/')) {
    throw createHttpError('Invalid branch name', 400);
  }
  return value;
}

function getPrivateToken(userId) {
  const envToken = String(process.env[PRIVATE_TOKEN_ENV_NAME] || '').trim();
  if (envToken) return envToken;
  const token = userDb.getGitTokenForUser(userId);
  if (!token) {
    throw createHttpError('Git token is not configured for the current user', 400);
  }
  return token;
}

function usernameForRepository(repositoryUrl) {
  try {
    const host = new URL(repositoryUrl).hostname.toLowerCase();
    if (host.includes('codehub')) return 'oauth';
    if (host.includes('gitlab')) return 'oauth2';
    if (host.includes('github')) return 'x-access-token';
  } catch {
    // Fall through.
  }
  return 'git';
}

async function writeAskPassScript({ username }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudcli-codehub-git-'));
  const isWindows = process.platform === 'win32';
  const filePath = path.join(directory, isWindows ? 'git-askpass.cmd' : 'git-askpass.sh');
  if (isWindows) {
    const psPath = path.join(directory, 'git-askpass.ps1');
    await fs.writeFile(psPath, [
      '$promptText = $args -join " "',
      'if ($promptText -match "Username") {',
      '  Write-Output $env:GIT_USERNAME',
      '} else {',
      `  Write-Output $env:${PRIVATE_TOKEN_ENV_NAME}`,
      '}',
      '',
    ].join('\r\n'), { mode: 0o700 });
    await fs.writeFile(filePath, [
      '@echo off',
      `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0git-askpass.ps1" %*`,
      '',
    ].join('\r\n'), { mode: 0o700 });
  } else {
    await fs.writeFile(filePath, [
      '#!/bin/sh',
      'case "$1" in',
      `  *Username*) printf '%s\\n' "\${GIT_USERNAME:-${username}}" ;;`,
      `  *) printf '%s\\n' "$${PRIVATE_TOKEN_ENV_NAME}" ;;`,
      'esac',
      '',
    ].join('\n'), { mode: 0o700 });
  }
  await fs.chmod(filePath, 0o700).catch(() => {});
  return { directory, filePath };
}

async function runGit(args, { cwd, userId, repositoryUrl, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const token = userId ? getPrivateToken(userId) : '';
  const askPass = userId
    ? await writeAskPassScript({ username: usernameForRepository(repositoryUrl || '') })
    : null;
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        ...(token ? { [PRIVATE_TOKEN_ENV_NAME]: token } : {}),
        ...(askPass ? {
          GIT_ASKPASS: askPass.filePath,
          GIT_TERMINAL_PROMPT: '0',
          GIT_USERNAME: usernameForRepository(repositoryUrl || ''),
          GIT_SSL_NO_VERIFY: String(process.env.CODEHUB_GIT_SSL_NO_VERIFY || 'true'),
        } : {}),
      },
    });
    return { stdout, stderr };
  } catch (error) {
    const message = sanitizeOutput(error?.stderr || error?.stdout || error?.message || 'Git command failed', token);
    throw createHttpError(message || 'Git command failed', 500);
  } finally {
    if (askPass) {
      await fs.rm(askPass.directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parsePorcelainStatus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renamedPath = rawPath.split(' -> ')[1] || rawPath;
      return {
        path: normalizeRelativePath(renamedPath),
        status,
      };
    });
}

function mapStatus(status) {
  if (status === '??') return 'untracked';
  if (/U/.test(status) || ['AA', 'DD'].includes(status)) return 'conflict';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'added';
  if (status.includes('R')) return 'renamed';
  return 'modified';
}

function parseNumstat(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [additions, deletions, ...pathParts] = line.split('\t');
      const isBinary = additions === '-' || deletions === '-';
      return {
        filePath: normalizeRelativePath(pathParts.join('\t')),
        additions: isBinary ? 0 : Number(additions || 0),
        deletions: isBinary ? 0 : Number(deletions || 0),
        isBinary,
      };
    });
}

function parseCommitLog(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [commitSha, timestamp, subject = ''] = line.split('\x1f');
      return {
        commitSha: commitSha.trim(),
        committedAt: new Date(Number(timestamp || 0) * 1000).toISOString(),
        commitMessage: subject.trim(),
      };
    })
    .filter((commit) => /^[0-9a-f]{7,40}$/i.test(commit.commitSha));
}

function parseRemoteHeadRefs(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [commitSha, ref] = line.split(/\s+/);
      return {
        commitSha,
        branch: String(ref || '').replace(/^refs\/heads\//, ''),
      };
    })
    .filter((entry) => entry.commitSha && entry.branch);
}

function parseMergeTreeNameOnlyOutput(output) {
  const lines = String(output || '').split(/\r?\n/);
  const files = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value) break;
    if (/^[0-9a-f]{40}$/i.test(value)) continue;
    files.push(normalizeRelativePath(value));
  }
  return Array.from(new Set(files.filter(Boolean)));
}

function parseOverwrittenFilesFromGitError(message) {
  const output = String(message || '');
  if (!/would be overwritten by merge|would be overwritten by checkout|Please commit your changes or stash/i.test(output)) {
    return [];
  }
  const lines = output.split(/\r?\n/);
  const files = [];
  let collecting = false;
  for (const line of lines) {
    if (/following files would be overwritten/i.test(line)) {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (/Please commit your changes or stash|Aborting/i.test(line)) break;
    const file = normalizeRelativePath(line);
    if (file) files.push(file);
  }
  return Array.from(new Set(files));
}

function parseConflictFilesFromStatus(output) {
  return parsePorcelainStatus(output)
    .filter((entry) => /U/.test(entry.status) || ['AA', 'DD'].includes(entry.status))
    .map((entry) => entry.path);
}

function isConflictStatus(status) {
  return /U/.test(status) || ['AA', 'DD'].includes(status);
}

function hasConflictMarkers(content) {
  return /^(<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(String(content || ''));
}

async function getRemoteChangedFiles(repoPath, remoteBranch) {
  try {
    const { stdout } = await runGit(['diff', '--name-only', `HEAD..origin/${remoteBranch}`], { cwd: repoPath });
    return stdout
      .split(/\r?\n/)
      .map(normalizeRelativePath)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function detectMergeConflicts(repoPath, remoteBranch) {
  return withOwnershipFinalizer(async () => {
    try {
      await execFileAsync('git', ['merge-tree', '--write-tree', '--name-only', '--messages', 'HEAD', `origin/${remoteBranch}`], {
        cwd: repoPath,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
      return { status: 'clean', files: [] };
    } catch (error) {
      const files = parseMergeTreeNameOnlyOutput(error?.stdout || '');
      if (files.length > 0) {
        return { status: 'conflict', files };
      }
      return { status: 'unknown', files: [] };
    }
  }, () => normalizeRepositoryOwnership(
    repoPath,
    'codehub_merge_conflict_preview',
    [path.join(repoPath, '.git')],
  ));
}

async function listStatusEntries(repoPath) {
  const { stdout } = await runGit(['status', '--porcelain', '-uall'], { cwd: repoPath });
  return parsePorcelainStatus(stdout);
}

async function getCurrentBranch(repoPath) {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

async function getOriginUrl(repoPath) {
  try {
    const { stdout } = await runGit(['remote', 'get-url', 'origin'], { cwd: repoPath });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function hasRemoteBranch(repoPath, branch, { userId, repositoryUrl }) {
  const { stdout } = await runGit(['ls-remote', '--heads', 'origin', branch], {
    cwd: repoPath,
    userId,
    repositoryUrl,
  });
  return stdout.trim() !== '';
}

async function getCommitStats(repoPath, commitSha) {
  const sha = String(commitSha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw createHttpError('Invalid commitSha', 400);
  }
  const { stdout: committedNumstat } = await runGit(['show', '--numstat', '--format=', sha], { cwd: repoPath });
  const stats = parseNumstat(committedNumstat);
  return {
    commitSha: sha,
    files: stats.map((file) => ({
      ...file,
      status: 'modified',
    })),
    additions: stats.reduce((sum, file) => sum + file.additions, 0),
    deletions: stats.reduce((sum, file) => sum + file.deletions, 0),
    filesChanged: stats.length,
    binaryFilesChanged: stats.filter((file) => file.isBinary).length,
  };
}

async function getCommitMessages(repoPath, commitShas) {
  const shas = Array.from(new Set(
    (Array.isArray(commitShas) ? commitShas : [])
      .map((sha) => String(sha || '').trim())
      .filter(Boolean),
  ));
  return Promise.all(shas.map(async (sha) => {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
      throw createHttpError('Invalid commitSha', 400);
    }
    const { stdout } = await runGit(['show', '-s', '--format=%B', sha], { cwd: repoPath });
    return {
      commitSha: sha,
      message: stdout.trim(),
    };
  }));
}

export const codeHubGitService = {
  normalizeRelativePath,
  validateBranchName,

  async cloneRepository({ repositoryUrl, destinationPath, userId, branch }) {
    let canCleanupDestination = false;
    if (await pathExists(destinationPath)) {
      const stat = await fs.lstat(destinationPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw createHttpError('Clone destination exists and is not a directory', 409);
      }
      const entries = await fs.readdir(destinationPath);
      if (entries.length > 0) {
        throw createHttpError('Clone destination directory is not empty', 409);
      }
      canCleanupDestination = true;
    } else {
      canCleanupDestination = true;
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    const cloneArgs = ['clone', '--progress'];
    const branchName = String(branch || '').trim();
    if (branchName) {
      cloneArgs.push('--branch', validateBranchName(branchName));
    }
    cloneArgs.push(repositoryUrl, destinationPath);
    try {
      await runGit(cloneArgs, {
        userId,
        repositoryUrl,
        timeoutMs: 10 * 60 * 1000,
      });
    } catch (error) {
      if (canCleanupDestination) {
        await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
    try {
      await withOwnershipFinalizer(
        () => runGit(['remote', 'set-url', 'origin', repositoryUrl], { cwd: destinationPath }),
        () => normalizeRepositoryOwnership(destinationPath, 'codehub_clone'),
      );
    } catch (error) {
      if (canCleanupDestination) {
        await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }
  },

  async getRepositorySummary(repoPath) {
    const [branch, remoteUrl, statusResult] = await Promise.all([
      getCurrentBranch(repoPath).catch(() => ''),
      getOriginUrl(repoPath),
      runGit(['status', '--porcelain'], { cwd: repoPath }).catch(() => ({ stdout: '' })),
    ]);
    return {
      branch,
      remoteUrl,
      dirty: statusResult.stdout.trim() !== '',
    };
  },

  async listChanges(repoPath) {
    const entries = await listStatusEntries(repoPath);
    return entries.map((entry) => ({
      path: entry.path,
      status: mapStatus(entry.status),
    }));
  },

  async getDiff(repoPath, filePath) {
    const normalized = normalizeGitFilePath(filePath);
    const statusOutput = await runGit(['status', '--porcelain', '--', normalized], { cwd: repoPath });
    const status = statusOutput.stdout.slice(0, 2);
    if (status === '??') {
      const absolutePath = path.join(repoPath, normalized);
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw createHttpError('Cannot show diff for a directory', 400);
      }
      const content = await fs.readFile(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      return `--- /dev/null\n+++ b/${normalized}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
    }
    const { stdout } = await runGit(['diff', 'HEAD', '--', normalized], { cwd: repoPath });
    return stdout;
  },

  async listRemoteBranches(repoPath, { userId, repositoryUrl, remote = 'origin' }) {
    const { stdout } = await runGit(['ls-remote', '--heads', remote], {
      cwd: repoPath,
      userId,
      repositoryUrl,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/heads\//, ''));
  },

  async listSubmissionCommits(repoPath, {
    sourceBranch,
    targetBranch,
    mrTargetRepository = 'personal',
    userId,
    repositoryUrl,
    publicRepositoryUrl,
  } = {}) {
    const currentBranch = await getCurrentBranch(repoPath).catch(() => '');
    const baseBranch = validateBranchName(targetBranch || currentBranch || 'develop');
    const useUpstreamTarget = mrTargetRepository === 'upstream';

    if (sourceBranch) {
      const remoteSourceBranch = validateBranchName(sourceBranch);
      const sourceRef = `refs/codehub/source/${remoteSourceBranch}`;
      const targetRef = `refs/codehub/target/${useUpstreamTarget ? 'upstream' : 'personal'}/${baseBranch}`;
      const targetRepositoryUrl = useUpstreamTarget ? publicRepositoryUrl : repositoryUrl;
      if (!repositoryUrl) {
        throw createHttpError('Personal repository URL is not configured', 400);
      }
      if (!targetRepositoryUrl) {
        throw createHttpError('Target repository URL is not configured', 400);
      }

      return withOwnershipFinalizer(async () => {
        await runGit([
          'fetch',
          '--no-tags',
          repositoryUrl,
          `+refs/heads/${remoteSourceBranch}:${sourceRef}`,
        ], {
          cwd: repoPath,
          userId,
          repositoryUrl,
        });
        await runGit([
          'fetch',
          '--no-tags',
          targetRepositoryUrl,
          `+refs/heads/${baseBranch}:${targetRef}`,
        ], {
          cwd: repoPath,
          userId,
          repositoryUrl: targetRepositoryUrl,
        });
        const [{ stdout: sourceOutput }, { stdout: targetOutput }, remoteRefs] = await Promise.all([
          runGit(['rev-parse', sourceRef], { cwd: repoPath }),
          runGit(['rev-parse', targetRef], { cwd: repoPath }),
          runGit(['ls-remote', '--heads', 'origin'], {
            cwd: repoPath,
            userId,
            repositoryUrl,
          }).then((result) => parseRemoteHeadRefs(result.stdout)).catch(() => []),
        ]);
        const sourceSha = sourceOutput.trim();
        const targetSha = targetOutput.trim();
        const { stdout: commitOutput } = await runGit([
          'log',
          '--reverse',
          '--format=%H%x1f%ct%x1f%s',
          `${targetRef}..${sourceRef}`,
        ], { cwd: repoPath });

        return {
          currentBranch,
          sourceBranch: remoteSourceBranch,
          targetBranch: baseBranch,
          mrTargetRepository: useUpstreamTarget ? 'upstream' : 'personal',
          sourceSha,
          targetSha,
          headSha: sourceSha,
          commits: parseCommitLog(commitOutput),
          remoteBranchesAtHead: remoteRefs
            .filter((entry) => entry.commitSha === sourceSha)
            .map((entry) => entry.branch),
        };
      }, () => normalizeRepositoryOwnership(
        repoPath,
        'codehub_mr_analysis_fetch',
        [path.join(repoPath, '.git')],
      ));
    }

    const baseRef = useUpstreamTarget
      ? `refs/codehub/upstream/${baseBranch}`
      : `origin/${baseBranch}`;

    if (useUpstreamTarget) {
      if (!publicRepositoryUrl) {
        throw createHttpError('Upstream repository URL is not configured', 400);
      }
      await runGit([
        'fetch',
        '--no-tags',
        publicRepositoryUrl,
        `+refs/heads/${baseBranch}:${baseRef}`,
      ], {
        cwd: repoPath,
        userId,
        repositoryUrl: publicRepositoryUrl,
      });
    } else {
      await runGit(['fetch', 'origin', baseBranch], {
        cwd: repoPath,
        userId,
        repositoryUrl,
      }).catch(() => null);
    }
    await normalizeRepositoryOwnership(
      repoPath,
      'codehub_submission_fetch',
      [path.join(repoPath, '.git')],
    );

    const { stdout: headOutput } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
    const headSha = headOutput.trim();
    let commits = [];
    try {
      const { stdout } = await runGit([
        'log',
        '--reverse',
        '--format=%H%x1f%ct%x1f%s',
        `${baseRef}..HEAD`,
      ], { cwd: repoPath });
      commits = parseCommitLog(stdout);
    } catch {
      commits = [];
    }

    const remoteRefs = await runGit(['ls-remote', '--heads', 'origin'], {
      cwd: repoPath,
      userId,
      repositoryUrl,
    })
      .then((result) => parseRemoteHeadRefs(result.stdout))
      .catch(() => []);
    const remoteBranchesAtHead = remoteRefs
      .filter((entry) => entry.commitSha === headSha)
      .map((entry) => entry.branch);

    return {
      currentBranch,
      targetBranch: baseBranch,
      headSha,
      commits,
      remoteBranchesAtHead,
    };
  },

  async pullPreview(repoPath, { branch, userId, repositoryUrl }) {
    const remoteBranch = validateBranchName(branch || await getCurrentBranch(repoPath));
    const [statusResult] = await withOwnershipFinalizer(
      () => Promise.all([
        runGit(['status', '--porcelain'], { cwd: repoPath }),
        runGit(['fetch', 'origin', remoteBranch], { cwd: repoPath, userId, repositoryUrl }),
      ]),
      () => normalizeRepositoryOwnership(
        repoPath,
        'codehub_pull_preview_fetch',
        [path.join(repoPath, '.git')],
      ),
    );
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout } = await runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${remoteBranch}`], { cwd: repoPath });
      const [left, right] = stdout.trim().split(/\s+/).map(Number);
      ahead = left || 0;
      behind = right || 0;
    } catch {
      // Leave as zero for repositories without a comparable remote branch.
    }
    const currentBranch = await getCurrentBranch(repoPath);
    const changedFiles = parsePorcelainStatus(statusResult.stdout).map((entry) => entry.path);
    const remoteChangedFiles = behind > 0 ? await getRemoteChangedFiles(repoPath, remoteBranch) : [];
    const localConflictFiles = changedFiles.filter((file) => remoteChangedFiles.includes(file));
    const mergeConflictCheck = behind > 0 ? await detectMergeConflicts(repoPath, remoteBranch) : { status: 'clean', files: [] };
    const conflictFiles = Array.from(new Set([
      ...localConflictFiles,
      ...mergeConflictCheck.files,
    ]));
    const hasConflicts = conflictFiles.length > 0 || mergeConflictCheck.status === 'conflict';
    const localChangesBlockPull = localConflictFiles.length > 0;
    const dirty = statusResult.stdout.trim() !== '';
    const recommendation = dirty
      ? 'commit-first'
      : hasConflicts
        ? 'resolve-conflicts'
        : behind > 0
          ? 'pull'
          : 'up-to-date';

    return {
      branch: currentBranch,
      remote: 'origin',
      remoteBranch,
      dirty,
      changedFiles,
      remoteChangedFiles,
      localConflictFiles,
      mergeConflictFiles: mergeConflictCheck.files,
      conflictFiles,
      hasConflicts,
      localChangesBlockPull,
      conflictCheckStatus: mergeConflictCheck.status,
      ahead,
      behind,
      recommendation,
    };
  },

  async pull(repoPath, { branch, userId, repositoryUrl }) {
    const remoteBranch = validateBranchName(branch || await getCurrentBranch(repoPath));
    const { stdout: beforeHeadOutput } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath })
      .catch(() => ({ stdout: '' }));
    const beforeHead = beforeHeadOutput.trim();
    return withOwnershipFinalizer(async () => {
      try {
        const { stdout, stderr } = await runGit(['pull', 'origin', remoteBranch], {
          cwd: repoPath,
          userId,
          repositoryUrl,
          timeoutMs: 10 * 60 * 1000,
        });
        return { success: true, output: stdout || stderr || 'Pull completed', remote: 'origin', branch: remoteBranch };
      } catch (error) {
        const status = await runGit(['status', '--porcelain'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
        const conflicts = parseConflictFilesFromStatus(status.stdout);
        if (conflicts.length > 0) {
          return { success: false, conflict: true, conflictFiles: conflicts, error: error.message };
        }
        const overwrittenFiles = parseOverwrittenFilesFromGitError(error.message);
        if (overwrittenFiles.length > 0 || /Please commit your changes or stash/i.test(String(error.message || ''))) {
          return {
            success: false,
            localChangesBlockPull: true,
            conflict: false,
            changedFiles: overwrittenFiles,
            error: error.message,
          };
        }
        throw error;
      }
    }, () => normalizeChangedRepositoryOwnership(repoPath, 'codehub_pull', {
      beforeHead,
      includeStatus: true,
    }));
  },

  async stashLocalChanges(repoPath, { message } = {}) {
    const entries = await listStatusEntries(repoPath);
    if (entries.length === 0) {
      return { success: true, stashed: false, message: 'No local changes to stash' };
    }
    const stashMessage = String(message || `CodeHub pull preview ${new Date().toISOString()}`).slice(0, 200);
    return withOwnershipFinalizer(async () => {
      const { stdout, stderr } = await runGit(['stash', 'push', '-u', '-m', stashMessage], { cwd: repoPath });
      const listResult = await runGit(['stash', 'list', '-n', '1', '--format=%gd%x1f%H%x1f%s'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
      const [stashRef = '', stashSha = '', stashSubject = ''] = listResult.stdout.trim().split('\x1f');
      return {
        success: true,
        stashed: true,
        stashRef,
        stashSha,
        stashSubject,
        files: entries.map((entry) => entry.path),
        output: stdout || stderr || '',
      };
    }, () => normalizeChangedRepositoryOwnership(repoPath, 'codehub_stash', {
      knownPaths: entries.map((entry) => entry.path),
    }));
  },

  async restoreStash(repoPath, { stashRef } = {}) {
    const ref = String(stashRef || '').trim();
    if (!/^stash@\{\d+\}$/.test(ref)) {
      throw createHttpError('Invalid stash reference', 400);
    }
    return withOwnershipFinalizer(async () => {
      try {
        const { stdout, stderr } = await runGit(['stash', 'pop', ref], {
          cwd: repoPath,
          timeoutMs: 10 * 60 * 1000,
        });
        return {
          success: true,
          restored: true,
          stashRef: ref,
          output: stdout || stderr || '',
        };
      } catch (error) {
        const status = await runGit(['status', '--porcelain'], { cwd: repoPath }).catch(() => ({ stdout: '' }));
        const conflicts = parseConflictFilesFromStatus(status.stdout);
        if (conflicts.length > 0) {
          return {
            success: false,
            conflict: true,
            stashRef: ref,
            conflictFiles: conflicts,
            error: error.message,
          };
        }
        throw error;
      }
    }, () => normalizeChangedRepositoryOwnership(repoPath, 'codehub_restore_stash', {
      includeStatus: true,
    }));
  },

  async resolveConflictFile(repoPath, { file } = {}) {
    const normalized = normalizeGitFilePath(file);
    const statusOutput = await runGit(['status', '--porcelain', '--', normalized], { cwd: repoPath });
    const statusEntry = parsePorcelainStatus(statusOutput.stdout)[0] || null;
    if (!statusEntry || !isConflictStatus(statusEntry.status)) {
      return {
        success: true,
        file: normalized,
        conflict: false,
        resolved: false,
        status: statusEntry?.status || '',
      };
    }

    const absolutePath = path.join(repoPath, normalized);
    const content = await fs.readFile(absolutePath, 'utf8');
    if (hasConflictMarkers(content)) {
      return {
        success: true,
        file: normalized,
        conflict: true,
        resolved: false,
        hasConflictMarkers: true,
        status: statusEntry.status,
      };
    }

    return withOwnershipFinalizer(async () => {
      await runGit(['add', '--', normalized], { cwd: repoPath });
      const nextStatusOutput = await runGit(['status', '--porcelain', '--', normalized], { cwd: repoPath });
      const nextStatusEntry = parsePorcelainStatus(nextStatusOutput.stdout)[0] || null;
      const stillConflicting = Boolean(nextStatusEntry && isConflictStatus(nextStatusEntry.status));
      return {
        success: true,
        file: normalized,
        conflict: stillConflicting,
        resolved: !stillConflicting,
        hasConflictMarkers: false,
        status: nextStatusEntry?.status || '',
      };
    }, () => normalizeRepositoryOwnership(repoPath, 'codehub_resolve_conflict', [
      absolutePath,
      path.join(repoPath, '.git'),
    ]));
  },

  async discardLocalChanges(repoPath, { files } = {}) {
    const requestedFiles = Array.from(new Set(
      (Array.isArray(files) ? files : [])
        .map(normalizeRelativePath)
        .filter(Boolean),
    ));
    if (requestedFiles.length === 0) {
      throw createHttpError('At least one file is required to clear local changes', 400);
    }

    const entries = await listStatusEntries(repoPath);
    const selectedEntries = entries.filter((entry) => requestedFiles.includes(entry.path));
    if (selectedEntries.length === 0) {
      return { success: true, cleared: false, files: [] };
    }

    const untrackedFiles = selectedEntries
      .filter((entry) => entry.status === '??')
      .map((entry) => entry.path);
    const trackedFiles = selectedEntries
      .filter((entry) => entry.status !== '??')
      .map((entry) => entry.path);

    await withOwnershipFinalizer(async () => {
      if (trackedFiles.length > 0) {
        await runGit(['restore', '--staged', '--worktree', '--', ...trackedFiles], { cwd: repoPath });
      }
      if (untrackedFiles.length > 0) {
        await runGit(['clean', '-fd', '--', ...untrackedFiles], { cwd: repoPath });
      }
    }, () => normalizeRepositoryOwnership(repoPath, 'codehub_discard_changes', [
      ...trackedFiles.map((file) => path.join(repoPath, file)),
      path.join(repoPath, '.git'),
    ]));

    return {
      success: true,
      cleared: true,
      files: selectedEntries.map((entry) => entry.path),
    };
  },

  getCommitStats,
  getCommitMessages,

  async commitSelectedFiles({
    repoPath,
    userId,
    files,
    message,
  }) {
    const gitConfig = userDb.getGitConfig(userId);
    const gitName = gitConfig?.git_name?.trim();
    const gitEmail = gitConfig?.git_email?.trim();
    if (!gitName || !gitEmail) {
      throw createHttpError('Git name and email must be configured before committing CodeHub changes', 400);
    }

    return withOwnershipFinalizer(async () => {
      await runGit(['config', 'user.name', gitName], { cwd: repoPath });
      await runGit(['config', 'user.email', gitEmail], { cwd: repoPath });

      const selectedFiles = files.map(normalizeRelativePath).filter(Boolean);
      if (selectedFiles.length === 0) {
        throw createHttpError('At least one file must be selected', 400);
      }
      await runGit(['reset', '--'], { cwd: repoPath });
      await runGit(['add', '--', ...selectedFiles], { cwd: repoPath });
      const { stdout: numstatOutput } = await runGit(['diff', '--cached', '--numstat'], { cwd: repoPath });
      const fileStats = parseNumstat(numstatOutput);
      if (fileStats.length === 0) {
        throw createHttpError('No staged changes to commit', 400);
      }
      await runGit(['commit', '-m', message], { cwd: repoPath });
      const { stdout: commitShaOutput } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
      const commitSha = commitShaOutput.trim();
      const committedStats = await getCommitStats(repoPath, commitSha);
      return committedStats.files.length > 0 ? committedStats : {
        commitSha,
        files: fileStats.map((file) => ({ ...file, status: 'modified' })),
        additions: fileStats.reduce((sum, file) => sum + file.additions, 0),
        deletions: fileStats.reduce((sum, file) => sum + file.deletions, 0),
        filesChanged: fileStats.length,
        binaryFilesChanged: fileStats.filter((file) => file.isBinary).length,
      };
    }, () => normalizeRepositoryOwnership(
      repoPath,
      'codehub_commit',
      [path.join(repoPath, '.git')],
    ));
  },

  async pushHead({
    repoPath,
    userId,
    repositoryUrl,
    sourceBranch,
    sourceBranchMode,
  }) {
    const branch = validateBranchName(sourceBranch);
    const remoteBranchExists = await hasRemoteBranch(repoPath, branch, { userId, repositoryUrl });
    if (sourceBranchMode === 'new' && remoteBranchExists) {
      throw createHttpError('Remote branch already exists', 409);
    }
    if (sourceBranchMode === 'existing' && !remoteBranchExists) {
      throw createHttpError('Remote branch does not exist', 404);
    }

    await withOwnershipFinalizer(
      () => runGit(['push', 'origin', `HEAD:refs/heads/${branch}`], {
        cwd: repoPath,
        userId,
        repositoryUrl,
        timeoutMs: 10 * 60 * 1000,
      }),
      () => normalizeRepositoryOwnership(repoPath, 'codehub_push', [path.join(repoPath, '.git')]),
    );
    const { stdout: headShaOutput } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
    return {
      success: true,
      remote: 'origin',
      branch,
      pushedHeadSha: headShaOutput.trim(),
    };
  },

  async commitAndPush({
    repoPath,
    userId,
    repositoryUrl,
    files,
    message,
    sourceBranch,
    sourceBranchMode,
  }) {
    const commitResult = await codeHubGitService.commitSelectedFiles({
      repoPath,
      userId,
      files,
      message,
    });
    await codeHubGitService.pushHead({
      repoPath,
      userId,
      repositoryUrl,
      sourceBranch,
      sourceBranchMode,
    });
    return {
      ...commitResult,
    };
  },
};
