import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeHubDb } from '../database/db.js';

const GIT_TEST_TIMEOUT_MS = 15_000;
const GIT_REMOTE_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER_BYTES = 128 * 1024;
const PRIVATE_TOKEN_ENV_NAME = 'PRIVATE_TOKEN';

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requirePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createHttpError(`${name} is required`, 400);
  }
  return value.trim();
}

function toClientRepository(row) {
  if (!row) return null;
  return {
    id: row.id,
    targetRepository: row.target_repository,
    privateRepository: row.private_repository,
    tokenConfigured: row.token_configured === true || row.token_configured === 1,
    lastTestStatus: row.last_test_status || null,
    lastTestError: row.last_test_error || null,
    lastTestedAt: row.last_tested_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeGitOutput(value, token = '') {
  let output = String(value || '');
  if (token) {
    output = output.split(token).join('[redacted]');
  }
  output = output.replace(/https?:\/\/[^@\s]+@/gi, (match) => {
    const protocol = match.startsWith('https:') ? 'https://' : 'http://';
    return `${protocol}[redacted]@`;
  });
  return output.trim().slice(0, 2000);
}

function normalizeRepositoryReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const scpLike = raw.match(/^(?:[^@\s]+@)?([^:\s]+):(.+)$/);
  if (scpLike && !raw.includes('://')) {
    return `${scpLike[1]}/${scpLike[2]}`
      .replace(/\\/g, '/')
      .replace(/\.git$/i, '')
      .replace(/\/+$/g, '')
      .toLowerCase();
  }

  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    return `${parsed.hostname}${parsed.pathname}`
      .replace(/\\/g, '/')
      .replace(/\.git$/i, '')
      .replace(/\/+$/g, '')
      .toLowerCase();
  } catch {
    return raw
      .replace(/\\/g, '/')
      .replace(/\.git$/i, '')
      .replace(/\/+$/g, '')
      .toLowerCase();
  }
}

function usernameForRepository(repositoryUrl) {
  try {
    const host = new URL(repositoryUrl).hostname.toLowerCase();
    if (host.includes('gitlab')) return 'oauth2';
    if (host.includes('github')) return 'x-access-token';
  } catch {
    // Fall through to a generic non-empty username for Git credential prompts.
  }
  return 'git';
}

function execFileAsync(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function writeAskPassScript({ fsImpl, username }) {
  const directory = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'cloudcli-codehub-'));
  const isWindows = process.platform === 'win32';
  const filePath = path.join(directory, isWindows ? 'git-askpass.cmd' : 'git-askpass.sh');

  if (isWindows) {
    const psPath = path.join(directory, 'git-askpass.ps1');
    await fsImpl.writeFile(psPath, [
      '$promptText = $args -join " "',
      'if ($promptText -match "Username") {',
      '  if ($env:GIT_USERNAME) { Write-Output $env:GIT_USERNAME } else { Write-Output "git" }',
      '} else {',
      `  Write-Output $env:${PRIVATE_TOKEN_ENV_NAME}`,
      '}',
      '',
    ].join('\r\n'), { mode: 0o700 });
    await fsImpl.writeFile(filePath, [
      '@echo off',
      `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0git-askpass.ps1" %*`,
      '',
    ].join('\r\n'), { mode: 0o700 });
  } else {
    await fsImpl.writeFile(filePath, [
      '#!/bin/sh',
      'case "$1" in',
      `  *Username*) printf '%s\\n' "\${GIT_USERNAME:-${username}}" ;;`,
      `  *) printf '%s\\n' "$${PRIVATE_TOKEN_ENV_NAME}" ;;`,
      'esac',
      '',
    ].join('\n'), { mode: 0o700 });
  }

  await fsImpl.chmod(filePath, 0o700).catch(() => {});
  return { directory, filePath };
}

export async function runGitConnectionTest({
  repositoryUrl,
  token,
  execFileImpl = execFile,
  fsImpl = fs,
  timeoutMs = GIT_TEST_TIMEOUT_MS,
} = {}) {
  const normalizedRepositoryUrl = requireNonEmptyString(repositoryUrl, 'privateRepository');
  const privateToken = requireNonEmptyString(token, 'token');
  const username = usernameForRepository(normalizedRepositoryUrl);
  const askPass = await writeAskPassScript({ fsImpl, username });

  try {
    const result = await execFileAsync(
      execFileImpl,
      'git',
      ['ls-remote', normalizedRepositoryUrl, 'HEAD'],
      {
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        env: {
          ...process.env,
          [PRIVATE_TOKEN_ENV_NAME]: privateToken,
          GIT_ASKPASS: askPass.filePath,
          GIT_TERMINAL_PROMPT: '0',
          GIT_USERNAME: username,
        },
      },
    );

    return {
      status: 'connected',
      command: 'git ls-remote <privateRepository> HEAD',
      output: sanitizeGitOutput(result.stdout || result.stderr, privateToken),
    };
  } catch (error) {
    return {
      status: 'failed',
      command: 'git ls-remote <privateRepository> HEAD',
      error: sanitizeGitOutput(error?.stderr || error?.stdout || error?.message || 'Git connection failed', privateToken),
    };
  } finally {
    await fsImpl.rm(askPass.directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function readWorkspaceRemoteUrls({ workspacePath, execFileImpl }) {
  if (!workspacePath) return [];
  try {
    const { stdout } = await execFileAsync(
      execFileImpl,
      'git',
      ['-C', workspacePath, 'config', '--get-regexp', '^remote\\..*\\.url$'],
      {
        timeout: GIT_REMOTE_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
      },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).slice(1).join(' '))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function createCodeHubService({
  store = codeHubDb,
  gitTester = runGitConnectionTest,
  execFileImpl = execFile,
} = {}) {
  return {
    listRepositories: (userId) => (
      store.listRepositories(requirePositiveInteger(Number(userId), 'userId')).map(toClientRepository)
    ),

    createRepository: ({ userId, targetRepository, privateRepository, token }) => {
      const row = store.createRepository({
        userId: requirePositiveInteger(Number(userId), 'userId'),
        targetRepository: requireNonEmptyString(targetRepository, 'targetRepository'),
        privateRepository: requireNonEmptyString(privateRepository, 'privateRepository'),
        token: requireNonEmptyString(token, 'token'),
      });
      return toClientRepository(row);
    },

    updateRepository: ({ userId, repositoryId, targetRepository, privateRepository, token }) => {
      const row = store.updateRepository({
        userId: requirePositiveInteger(Number(userId), 'userId'),
        repositoryId: requirePositiveInteger(Number(repositoryId), 'repositoryId'),
        targetRepository: requireNonEmptyString(targetRepository, 'targetRepository'),
        privateRepository: requireNonEmptyString(privateRepository, 'privateRepository'),
        token,
      });
      if (!row) {
        throw createHttpError('CodeHub repository not found', 404);
      }
      return toClientRepository(row);
    },

    deleteRepository: ({ userId, repositoryId }) => store.deleteRepository({
      userId: requirePositiveInteger(Number(userId), 'userId'),
      repositoryId: requirePositiveInteger(Number(repositoryId), 'repositoryId'),
    }),

    testRepository: async ({ userId, repositoryId }) => {
      const secret = store.getRepositorySecret({
        userId: requirePositiveInteger(Number(userId), 'userId'),
        repositoryId: requirePositiveInteger(Number(repositoryId), 'repositoryId'),
      });
      if (!secret) {
        throw createHttpError('CodeHub repository not found', 404);
      }

      const result = await gitTester({
        repositoryUrl: secret.private_repository,
        token: secret.token,
      });
      const row = store.recordTest({
        userId,
        repositoryId,
        status: result.status === 'connected' ? 'connected' : 'failed',
        error: result.status === 'connected' ? null : result.error,
      });

      return {
        repository: toClientRepository(row),
        connection: result,
      };
    },

    resolvePrivateTokenEnvForWorkspace: async ({ userId, workspacePath }) => {
      const normalizedUserId = requirePositiveInteger(Number(userId), 'userId');
      const repositoryRows = typeof store.listRepositorySecrets === 'function'
        ? store.listRepositorySecrets(normalizedUserId)
        : [];
      if (repositoryRows.length === 0) {
        return {};
      }

      const workspaceRefs = new Set([
        normalizeRepositoryReference(workspacePath),
        ...(await readWorkspaceRemoteUrls({ workspacePath, execFileImpl })).map(normalizeRepositoryReference),
      ].filter(Boolean));

      for (const row of repositoryRows) {
        const target = normalizeRepositoryReference(row.target_repository);
        if (!target || !workspaceRefs.has(target)) {
          continue;
        }
        const token = store.decryptRepositoryToken(row);
        if (token) {
          return { [PRIVATE_TOKEN_ENV_NAME]: token };
        }
      }

      return {};
    },
  };
}

export const codeHubService = createCodeHubService();
export { normalizeRepositoryReference };
