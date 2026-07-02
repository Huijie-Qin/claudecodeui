import { promises as fs } from 'node:fs';
import path from 'node:path';

import express from 'express';

import {
  aiMrSubmissionsDb,
  codeHubWorkspaceRepositoriesDb,
} from '../database/db.js';
import { tenantContext } from '../middleware/tenant-context.js';
import { codeHubGitService } from '../services/codehub-git.js';
import { codeHubMcpService } from '../services/codehub-mcp.js';
import { workspaceAccess } from '../services/workspace-access.js';
import { handleWorkspaceError } from '../services/workspace-request.js';

const router = express.Router();
router.use(tenantContext);

const SKIP_SCAN_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-server',
  'build',
  '.npm-cache',
]);

function createHttpError(message, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

function sendRouteError(res, error, fallbackMessage = 'CodeHub operation failed') {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ error: error.message, details: error.details });
  }
  console.error(fallbackMessage, error);
  return res.status(500).json({ error: fallbackMessage, details: error?.message || String(error) });
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw createHttpError(`${name} must be a positive integer`, 400);
  }
  return number;
}

function requireNonEmptyString(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw createHttpError(`${name} is required`, 400);
  }
  return normalized;
}

function getRequestUserId(req) {
  return parsePositiveInteger(req.user?.id ?? req.user?.userId, 'userId');
}

function resolveWorkspace(req, { requireEdit = false } = {}) {
  const tenantId = parsePositiveInteger(req.tenant?.id, 'tenantId');
  const userId = getRequestUserId(req);
  const workspaceId = parsePositiveInteger(req.params.workspaceId, 'workspaceId');
  return workspaceAccess.requireWorkspace({
    tenantId,
    userId,
    workspaceId,
    requireEdit,
  });
}

function assertInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (child !== parent && !child.startsWith(`${parent}${path.sep}`)) {
    throw createHttpError('Path is outside the workspace', 400);
  }
  return child;
}

function normalizeDirectoryName(value) {
  const name = requireNonEmptyString(value, 'directoryName');
  const base = path.basename(name);
  if (base !== name || name.includes('\0') || name === '.' || name === '..') {
    throw createHttpError('directoryName must be a safe folder name', 400);
  }
  return base;
}

function toRepoRelativePath(workspacePath, repoPath) {
  return codeHubGitService.normalizeRelativePath(path.relative(workspacePath, repoPath));
}

function inferCodeHubHost(repositoryUrl) {
  const configured = String(process.env.CODEHUB_HOST || '').trim();
  if (configured) return configured;
  try {
    const parsed = new URL(repositoryUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function buildLegacyCommitText({ ticketNo, description, binarySource }) {
  return [
    `[TicketNo:] ${ticketNo}`,
    `[Description:] ${description}`,
    `[Binary Source:] ${binarySource || 'NA'}`,
  ].join('\n');
}

function extractIssueNumsFromText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('[TicketNo:]'))
    .flatMap((line) => line.slice('[TicketNo:]'.length).trim().split(';'))
    .map((ticketNo) => ticketNo.trim())
    .filter(Boolean);
}

async function readIssueNumsFromCommits(repoPath, commitShas, fallbackText = '') {
  const issueNums = new Set();
  const commitMessages = await codeHubGitService.getCommitMessages(repoPath, commitShas);
  for (const { message } of commitMessages) {
    for (const issueNum of extractIssueNumsFromText(message)) {
      issueNums.add(issueNum);
    }
  }
  if (issueNums.size === 0) {
    for (const issueNum of extractIssueNumsFromText(fallbackText)) {
      issueNums.add(issueNum);
    }
  }
  return Array.from(issueNums).join(';');
}

function normalizeCommitMessage(body) {
  const commitMessage = String(body?.commitMessage || '').trim();
  if (commitMessage) return commitMessage;
  const ticketNo = requireNonEmptyString(body?.ticketNo, 'ticketNo');
  const description = requireNonEmptyString(body?.description, 'description');
  const binarySource = String(body?.binarySource || 'NA').trim() || 'NA';
  return buildLegacyCommitText({ ticketNo, description, binarySource });
}

function commitMessageSummary(commitMessage) {
  const firstLine = String(commitMessage || '').split(/\r?\n/).find((line) => line.trim()) || 'CodeHub submission';
  return firstLine.trim().slice(0, 255);
}

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readMrPollIntervalMinutes() {
  const explicitMinutes = readPositiveNumber(process.env.CODEHUB_MR_POLL_INTERVAL_MINUTES, 0);
  if (explicitMinutes > 0) return explicitMinutes;
  const legacyHours = readPositiveNumber(process.env.CODEHUB_MR_POLL_INTERVAL_HOURS, 0);
  return legacyHours > 0 ? legacyHours * 60 : 5;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function safeJsonSummary(value, maxLength = 1200) {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function requiresProjectInfo() {
  return String(process.env.CODEHUB_REQUIRE_PROJECT_INFO || '').trim().toLowerCase() === 'true';
}

function assertProjectInfoHasId(projectInfo, repositoryUrl) {
  if (projectInfo?.id) {
    console.info('[CodeHub] get_project_info resolved project id', {
      repositoryUrl,
      projectId: projectInfo.id,
      hasForkedFromProject: Boolean(projectInfo.forked_from_project),
    });
    return projectInfo;
  }
  console.warn('[CodeHub] get_project_info returned no project id', {
    repositoryUrl,
    requireProjectInfo: requiresProjectInfo(),
    projectInfo: safeJsonSummary(projectInfo),
  });
  if (!requiresProjectInfo()) return projectInfo || null;
  throw createHttpError(
    'CodeHub project info did not include id',
    502,
    {
      repositoryUrl,
      projectInfo,
    },
  );
}

function normalizeMrTargetRepository(value, repository) {
  const target = String(value || 'personal').trim().toLowerCase();
  if (target === 'upstream') {
    if (!repository.public_project_id) {
      throw createHttpError('Upstream repository project_id is not configured', 400);
    }
    return 'upstream';
  }
  return 'personal';
}

function mrProjectIdForTarget(repository, mrTargetRepository) {
  return mrTargetRepository === 'upstream' ? repository.public_project_id : repository.project_id;
}

function toExistingMergeRequestPayload(submission) {
  if (!submission) return null;
  return {
    submissionId: submission.id,
    commitSha: submission.commit_sha,
    sourceBranch: submission.source_branch,
    targetBranch: submission.target_branch,
    mrProjectId: submission.mr_project_id,
    mrId: submission.mr_id,
    mrIid: submission.mr_iid,
    mrUrl: submission.mr_url,
    status: submission.status,
    mrState: submission.mr_state,
    createdAt: submission.created_at,
  };
}

function listActiveMergeRequestsForHead({ workspace, userId, repository, targetBranch, commitSha }) {
  if (!commitSha || !targetBranch) return [];
  return aiMrSubmissionsDb.listActiveForHead({
    tenantId: workspace.tenant_id,
    userId,
    workspaceId: workspace.id,
    repoRelativePath: repository.repo_relative_path,
    targetBranch,
    commitSha,
  });
}

function findExistingMergeRequest({ workspace, userId, repository, sourceBranch, targetBranch, commitSha, mrTargetRepository }) {
  const mrProjectId = mrProjectIdForTarget(repository, mrTargetRepository);
  return listActiveMergeRequestsForHead({
    workspace,
    userId,
    repository,
    targetBranch,
    commitSha,
  }).find((submission) => (
    submission.source_branch === sourceBranch
    && Number(submission.mr_project_id || 0) === Number(mrProjectId || 0)
  )) || null;
}

async function getCombinedCommitStats(repoPath, commitShas) {
  const shas = Array.from(new Set(
    (Array.isArray(commitShas) ? commitShas : [])
      .map((sha) => String(sha || '').trim())
      .filter(Boolean),
  ));
  if (shas.length === 0) {
    throw createHttpError('At least one commitSha is required', 400);
  }
  const statsList = await Promise.all(shas.map((sha) => codeHubGitService.getCommitStats(repoPath, sha)));
  const fileMap = new Map();
  for (const stats of statsList) {
    for (const file of stats.files || []) {
      const existing = fileMap.get(file.filePath) || {
        filePath: file.filePath,
        status: file.status || 'modified',
        additions: 0,
        deletions: 0,
        isBinary: false,
      };
      existing.additions += Number(file.additions || 0);
      existing.deletions += Number(file.deletions || 0);
      existing.isBinary = existing.isBinary || Boolean(file.isBinary);
      fileMap.set(file.filePath, existing);
    }
  }
  const files = Array.from(fileMap.values());
  return {
    commitSha: shas[shas.length - 1],
    commitShas: shas,
    files,
    additions: statsList.reduce((sum, stats) => sum + Number(stats.additions || 0), 0),
    deletions: statsList.reduce((sum, stats) => sum + Number(stats.deletions || 0), 0),
    filesChanged: files.length,
    binaryFilesChanged: files.filter((file) => file.isBinary).length,
  };
}

async function readProjectInfo({ userId, repositoryUrl }) {
  try {
    console.info('[CodeHub] calling get_project_info', {
      repositoryUrl,
      requireProjectInfo: requiresProjectInfo(),
    });
    const projectInfo = await codeHubMcpService.getProjectInfo({ userId, gitUrl: repositoryUrl });
    return assertProjectInfoHasId(projectInfo, repositoryUrl);
  } catch (error) {
    console.error('[CodeHub] get_project_info failed', {
      repositoryUrl,
      requireProjectInfo: requiresProjectInfo(),
      error: error?.message || String(error),
      details: error?.details ? safeJsonSummary(error.details) : undefined,
    });
    if (requiresProjectInfo()) {
      throw error;
    }
    return null;
  }
}

function toRepositoryRecordPayload({ workspace, userId, repoRelativePath, repositoryUrl, projectInfo }) {
  const forked = projectInfo?.forked_from_project || null;
  return {
    tenantId: workspace.tenant_id,
    userId,
    workspaceId: workspace.id,
    repoRelativePath,
    repositoryUrl: projectInfo?.http_url_to_repo || repositoryUrl,
    projectId: projectInfo?.id || null,
    publicRepositoryUrl: forked?.http_url_to_repo || null,
    publicProjectId: forked?.id || null,
    codehubHost: inferCodeHubHost(projectInfo?.http_url_to_repo || repositoryUrl),
  };
}

async function scanGitRepositories(workspacePath, { maxDepth = 4 } = {}) {
  const found = [];
  async function walk(currentPath, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === '.git')) {
      found.push(currentPath);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_SCAN_DIRECTORIES.has(entry.name)) continue;
      await walk(path.join(currentPath, entry.name), depth + 1);
    }
  }
  await walk(workspacePath, 0);
  return found;
}

async function isGitRepositoryPath(repoPath) {
  try {
    const [repoStat, gitStat] = await Promise.all([
      fs.stat(repoPath),
      fs.stat(path.join(repoPath, '.git')),
    ]);
    return repoStat.isDirectory() && gitStat.isDirectory();
  } catch {
    return false;
  }
}

async function resolveRepository(req, { requireEdit = false } = {}) {
  const { workspace } = resolveWorkspace(req, { requireEdit });
  const userId = getRequestUserId(req);
  const repositoryId = parsePositiveInteger(req.params.repoId, 'repoId');
  const repository = codeHubWorkspaceRepositoriesDb.getById({
    tenantId: workspace.tenant_id,
    userId,
    workspaceId: workspace.id,
    repositoryId,
  });
  if (!repository) {
    throw createHttpError('CodeHub workspace repository not found', 404);
  }
  const repoPath = assertInside(workspace.path, path.resolve(workspace.path, repository.repo_relative_path));
  if (!await isGitRepositoryPath(repoPath)) {
    throw createHttpError('CodeHub repository folder no longer exists in the workspace', 404);
  }
  return { workspace, userId, repository, repoPath };
}

async function createMergeRequestSubmission({
  workspace,
  userId,
  repository,
  commitStats,
  sourceBranch,
  targetBranch,
  commitMessage,
  mrTitle,
  mrTargetRepository = 'personal',
  issueNums = '',
}) {
  const commitText = normalizeCommitMessage({ commitMessage });
  const summary = commitMessageSummary(commitText);
  const isCrossProject = mrTargetRepository === 'upstream';
  const mrProjectId = mrProjectIdForTarget(repository, mrTargetRepository);
  const now = new Date();
  const expireDays = Number(process.env.CODEHUB_MR_EXPIRE_DAYS || 7);
  const intervalMinutes = readMrPollIntervalMinutes();
  let mrResult = null;
  let mrError = null;

  try {
    mrResult = await codeHubMcpService.createMergeRequest({
      userId,
      projectId: repository.project_id,
      sourceProjectId: isCrossProject ? repository.project_id : null,
      targetProjectId: isCrossProject ? repository.public_project_id : null,
      sourceBranch,
      targetBranch,
      title: mrTitle,
      description: commitText,
      issueNums,
    });
  } catch (error) {
    mrError = error;
  }

  const submission = aiMrSubmissionsDb.create({
    submission: {
      tenantId: workspace.tenant_id,
      userId,
      workspaceId: workspace.id,
      repoRelativePath: repository.repo_relative_path,
      repositoryUrl: repository.repository_url,
      projectId: repository.project_id,
      publicRepositoryUrl: repository.public_repository_url,
      publicProjectId: repository.public_project_id,
      sourceBranch,
      targetBranch,
      commitSha: commitStats.commitSha,
      mrId: mrResult?.id || null,
      mrIid: mrResult?.iid || null,
      mrProjectId,
      mrUrl: mrResult?.web_url || mrResult?.webUrl || null,
      ticketNo: summary,
      description: commitText,
      binarySource: 'NA',
      mrTitle,
      additions: commitStats.additions,
      deletions: commitStats.deletions,
      filesChanged: commitStats.filesChanged,
      binaryFilesChanged: commitStats.binaryFilesChanged,
      status: mrResult ? 'pending' : 'mr_failed',
      mrState: mrResult?.state || 'opened',
      mrCreatedAt: mrResult?.created_at || null,
      mrUpdatedAt: mrResult?.updated_at || null,
      expiresAt: new Date(now.getTime() + expireDays * 24 * 60 * 60 * 1000).toISOString(),
      nextCheckAt: mrResult ? addMinutes(now, intervalMinutes).toISOString() : null,
      lastError: mrError?.message || null,
    },
    files: commitStats.files,
  });

  return { submission, mrError };
}

router.get('/workspaces/:workspaceId/repositories', async (req, res) => {
  try {
    const { workspace } = resolveWorkspace(req);
    const userId = getRequestUserId(req);
    const existingByPath = new Map(
      codeHubWorkspaceRepositoriesDb
        .listForWorkspace({ tenantId: workspace.tenant_id, userId, workspaceId: workspace.id })
        .map((repo) => [repo.repo_relative_path, repo]),
    );

    const scannedPaths = await scanGitRepositories(workspace.path);
    for (const repoPath of scannedPaths) {
      const repoRelativePath = toRepoRelativePath(workspace.path, repoPath);
      const summary = await codeHubGitService.getRepositorySummary(repoPath);
      if (!summary.remoteUrl) continue;
      const existing = existingByPath.get(repoRelativePath);
      if (existing?.project_id) continue;
      const projectInfo = await readProjectInfo({ userId, repositoryUrl: summary.remoteUrl });
      if (existing && !projectInfo?.id) continue;
      const record = codeHubWorkspaceRepositoriesDb.upsert(toRepositoryRecordPayload({
        workspace,
        userId,
        repoRelativePath,
        repositoryUrl: summary.remoteUrl,
        projectInfo,
      }));
      existingByPath.set(repoRelativePath, record);
    }

    const repositories = await Promise.all(
      Array.from(existingByPath.values()).map(async (repo) => {
        const repoPath = assertInside(workspace.path, path.resolve(workspace.path, repo.repo_relative_path));
        if (!await isGitRepositoryPath(repoPath)) {
          return null;
        }
        const summary = await codeHubGitService.getRepositorySummary(repoPath).catch(() => ({
          branch: '',
          remoteUrl: repo.repository_url,
          dirty: false,
        }));
        return {
          repoId: repo.id,
          name: path.basename(repo.repo_relative_path),
          relativePath: repo.repo_relative_path,
          repositoryUrl: repo.repository_url,
          projectId: repo.project_id,
          publicRepositoryUrl: repo.public_repository_url,
          publicProjectId: repo.public_project_id,
          branch: summary.branch,
          remoteUrl: summary.remoteUrl || repo.repository_url,
          dirty: summary.dirty,
        };
      }),
    );
    res.json({ repositories: repositories.filter(Boolean) });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to list CodeHub repositories');
  }
});

router.post('/workspaces/:workspaceId/repositories/clone', async (req, res) => {
  try {
    const { workspace } = resolveWorkspace(req, { requireEdit: true });
    const userId = getRequestUserId(req);
    const repositoryUrl = requireNonEmptyString(req.body?.repositoryUrl, 'repositoryUrl');
    const directoryName = normalizeDirectoryName(req.body?.directoryName);
    const branch = String(req.body?.branch || '').trim();
    const destinationPath = assertInside(workspace.path, path.join(workspace.path, directoryName));

    await codeHubGitService.cloneRepository({ repositoryUrl, destinationPath, userId, branch });
    const projectInfo = await readProjectInfo({ userId, repositoryUrl });
    const repository = codeHubWorkspaceRepositoriesDb.upsert(toRepositoryRecordPayload({
      workspace,
      userId,
      repoRelativePath: toRepoRelativePath(workspace.path, destinationPath),
      repositoryUrl,
      projectInfo,
    }));
    res.status(201).json({ success: true, repository });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to clone CodeHub repository');
  }
});

router.get('/workspaces/:workspaceId/repositories/:repoId/changes', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req);
    const files = await codeHubGitService.listChanges(repoPath);
    res.json({ files });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to list repository changes');
  }
});

router.get('/workspaces/:workspaceId/repositories/:repoId/diff', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req);
    const file = requireNonEmptyString(req.query?.file, 'file');
    const diff = await codeHubGitService.getDiff(repoPath, file);
    res.json({ file, diff });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to load repository diff');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/pull-preview', async (req, res) => {
  try {
    const { repoPath, repository, userId } = await resolveRepository(req, { requireEdit: true });
    const preview = await codeHubGitService.pullPreview(repoPath, {
      branch: req.body?.branch,
      userId,
      repositoryUrl: repository.repository_url,
    });
    res.json(preview);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to preview pull');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/stash-local-changes', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req, { requireEdit: true });
    const result = await codeHubGitService.stashLocalChanges(repoPath, {
      message: req.body?.message,
    });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to stash local changes');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/restore-stash', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req, { requireEdit: true });
    const result = await codeHubGitService.restoreStash(repoPath, {
      stashRef: req.body?.stashRef,
    });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to restore stashed changes');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/resolve-conflict-file', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req, { requireEdit: true });
    const file = requireNonEmptyString(req.body?.file, 'file');
    const result = await codeHubGitService.resolveConflictFile(repoPath, { file });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to resolve conflict file');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/clear-local-changes', async (req, res) => {
  try {
    const { repoPath } = await resolveRepository(req, { requireEdit: true });
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const result = await codeHubGitService.discardLocalChanges(repoPath, { files });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to clear local changes');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/pull', async (req, res) => {
  try {
    const { repoPath, repository, userId } = await resolveRepository(req, { requireEdit: true });
    const result = await codeHubGitService.pull(repoPath, {
      branch: req.body?.branch,
      userId,
      repositoryUrl: repository.repository_url,
    });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to pull repository updates');
  }
});

router.get('/workspaces/:workspaceId/repositories/:repoId/remote-branches', async (req, res) => {
  try {
    const { repoPath, repository, userId } = await resolveRepository(req);
    const branches = await codeHubGitService.listRemoteBranches(repoPath, {
      userId,
      repositoryUrl: repository.repository_url,
    });
    res.json({ remote: 'origin', branches });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to list remote branches');
  }
});

router.get('/workspaces/:workspaceId/repositories/:repoId/submission-commits', async (req, res) => {
  try {
    const { workspace, repoPath, repository, userId } = await resolveRepository(req);
    const result = await codeHubGitService.listSubmissionCommits(repoPath, {
      targetBranch: req.query?.targetBranch,
      userId,
      repositoryUrl: repository.repository_url,
    });
    const activeMergeRequests = listActiveMergeRequestsForHead({
      workspace,
      userId,
      repository,
      targetBranch: result.targetBranch,
      commitSha: result.headSha,
    }).map(toExistingMergeRequestPayload);
    res.json({
      ...result,
      activeMergeRequests,
    });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to list submission commits');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/sync-fork', async (req, res) => {
  try {
    const { repository, userId } = await resolveRepository(req, { requireEdit: true });
    if (!repository.project_id) {
      throw createHttpError('Repository project_id is not configured', 400);
    }
    const branch = requireNonEmptyString(req.body?.branch, 'branch');
    const result = await codeHubMcpService.syncRepo({
      userId,
      projectId: repository.project_id,
      branch,
    });
    res.json({ success: true, result });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to sync fork repository');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/commit', async (req, res) => {
  try {
    const { repoPath, userId } = await resolveRepository(req, { requireEdit: true });
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const commitMessage = normalizeCommitMessage(req.body);
    const result = await codeHubGitService.commitSelectedFiles({
      repoPath,
      userId,
      files,
      message: commitMessage,
    });
    res.status(201).json({
      success: true,
      ...result,
      commitMessage,
    });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to commit CodeHub changes');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/push', async (req, res) => {
  try {
    const { repoPath, repository, userId } = await resolveRepository(req, { requireEdit: true });
    const sourceBranchMode = req.body?.sourceBranchMode === 'existing' ? 'existing' : 'new';
    const sourceBranch = requireNonEmptyString(req.body?.sourceBranch, 'sourceBranch');
    const result = await codeHubGitService.pushHead({
      repoPath,
      userId,
      repositoryUrl: repository.repository_url,
      sourceBranch,
      sourceBranchMode,
    });
    res.json(result);
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to push CodeHub branch');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/merge-requests', async (req, res) => {
  try {
    const { workspace, repoPath, repository, userId } = await resolveRepository(req, { requireEdit: true });
    if (!repository.project_id) {
      throw createHttpError('Repository project_id is not configured', 400);
    }
    const commitSha = requireNonEmptyString(req.body?.commitSha, 'commitSha');
    const commitShas = Array.isArray(req.body?.commitShas) && req.body.commitShas.length > 0
      ? req.body.commitShas
      : [commitSha];
    const sourceBranch = requireNonEmptyString(req.body?.sourceBranch, 'sourceBranch');
    const targetBranch = requireNonEmptyString(req.body?.targetBranch, 'targetBranch');
    const commitMessage = normalizeCommitMessage(req.body);
    const mrTitle = requireNonEmptyString(req.body?.mrTitle || commitMessageSummary(commitMessage), 'mrTitle');
    const mrTargetRepository = normalizeMrTargetRepository(req.body?.mrTargetRepository, repository);
    const existingMergeRequest = findExistingMergeRequest({
      workspace,
      userId,
      repository,
      sourceBranch,
      targetBranch,
      commitSha,
      mrTargetRepository,
    });
    if (existingMergeRequest) {
      return res.status(409).json({
        success: false,
        error: 'Merge request already exists for this pushed HEAD',
        existingMergeRequest: toExistingMergeRequestPayload(existingMergeRequest),
      });
    }
    const commitStats = await getCombinedCommitStats(repoPath, commitShas);
    const issueNums = await readIssueNumsFromCommits(repoPath, commitShas, commitMessage);
    const { submission, mrError } = await createMergeRequestSubmission({
      workspace,
      userId,
      repository,
      commitStats,
      sourceBranch,
      targetBranch,
      commitMessage,
      mrTitle,
      mrTargetRepository,
      issueNums,
    });

    if (mrError) {
      return res.status(502).json({
        success: false,
        submissionId: submission.id,
        commitSha: commitStats.commitSha,
        status: submission.status,
        error: 'Branch was pushed, but creating the merge request failed',
        details: mrError.message,
      });
    }

    return res.status(201).json({
      success: true,
      submissionId: submission.id,
      commitSha: commitStats.commitSha,
      mrId: submission.mr_id,
      mrIid: submission.mr_iid,
      mrUrl: submission.mr_url,
      status: submission.status,
      additions: submission.additions,
      deletions: submission.deletions,
      filesChanged: submission.files_changed,
    });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to create CodeHub merge request');
  }
});

router.post('/workspaces/:workspaceId/repositories/:repoId/submit-mr', async (req, res) => {
  try {
    const { workspace, repoPath, repository, userId } = await resolveRepository(req, { requireEdit: true });
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const sourceBranchMode = req.body?.sourceBranchMode === 'existing' ? 'existing' : 'new';
    const sourceBranch = requireNonEmptyString(req.body?.sourceBranch, 'sourceBranch');
    const targetBranch = requireNonEmptyString(req.body?.targetBranch, 'targetBranch');
    const commitText = normalizeCommitMessage(req.body);
    const summary = commitMessageSummary(commitText);
    const mrTitle = requireNonEmptyString(req.body?.mrTitle || summary, 'mrTitle');
    const mrTargetRepository = normalizeMrTargetRepository(req.body?.mrTargetRepository, repository);

    if (!repository.project_id) {
      throw createHttpError('Repository project_id is not configured', 400);
    }

    const commitResult = await codeHubGitService.commitAndPush({
      repoPath,
      userId,
      repositoryUrl: repository.repository_url,
      files,
      message: commitText,
      sourceBranch,
      sourceBranchMode,
    });

    const isCrossProject = mrTargetRepository === 'upstream';
    const mrProjectId = isCrossProject ? repository.public_project_id : repository.project_id;
    const now = new Date();
    const expireDays = Number(process.env.CODEHUB_MR_EXPIRE_DAYS || 7);
    const intervalMinutes = readMrPollIntervalMinutes();
    const issueNums = await readIssueNumsFromCommits(repoPath, [commitResult.commitSha], commitText);
    let mrResult = null;
    let mrError = null;
    try {
      mrResult = await codeHubMcpService.createMergeRequest({
        userId,
        projectId: repository.project_id,
        sourceProjectId: isCrossProject ? repository.project_id : null,
        targetProjectId: isCrossProject ? repository.public_project_id : null,
        sourceBranch,
        targetBranch,
        title: mrTitle,
        description: commitText,
        issueNums,
      });
    } catch (error) {
      mrError = error;
    }
    const submission = aiMrSubmissionsDb.create({
      submission: {
        tenantId: workspace.tenant_id,
        userId,
        workspaceId: workspace.id,
        repoRelativePath: repository.repo_relative_path,
        repositoryUrl: repository.repository_url,
        projectId: repository.project_id,
        publicRepositoryUrl: repository.public_repository_url,
        publicProjectId: repository.public_project_id,
        sourceBranch,
        targetBranch,
        commitSha: commitResult.commitSha,
        mrId: mrResult?.id || null,
        mrIid: mrResult?.iid || null,
        mrProjectId,
        mrUrl: mrResult?.web_url || mrResult?.webUrl || null,
        ticketNo: summary,
        description: commitText,
        binarySource: 'NA',
        mrTitle,
        additions: commitResult.additions,
        deletions: commitResult.deletions,
        filesChanged: commitResult.filesChanged,
        binaryFilesChanged: commitResult.binaryFilesChanged,
        status: mrResult ? 'pending' : 'mr_failed',
        mrState: mrResult?.state || 'opened',
        mrCreatedAt: mrResult?.created_at || null,
        mrUpdatedAt: mrResult?.updated_at || null,
        expiresAt: new Date(now.getTime() + expireDays * 24 * 60 * 60 * 1000).toISOString(),
        nextCheckAt: mrResult ? addMinutes(now, intervalMinutes).toISOString() : null,
        lastError: mrError?.message || null,
      },
      files: commitResult.files,
    });

    if (mrError) {
      return res.status(502).json({
        success: false,
        submissionId: submission.id,
        commitSha: commitResult.commitSha,
        status: submission.status,
        error: 'Commit was pushed, but creating the merge request failed',
        details: mrError.message,
      });
    }

    res.status(201).json({
      success: true,
      submissionId: submission.id,
      commitSha: commitResult.commitSha,
      mrId: submission.mr_id,
      mrIid: submission.mr_iid,
      mrUrl: submission.mr_url,
      status: submission.status,
      additions: submission.additions,
      deletions: submission.deletions,
      filesChanged: submission.files_changed,
    });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to submit CodeHub merge request');
  }
});

router.post('/submissions/:submissionId/retry-mr', async (req, res) => {
  try {
    const tenantId = parsePositiveInteger(req.tenant?.id, 'tenantId');
    const userId = getRequestUserId(req);
    const submissionId = parsePositiveInteger(req.params.submissionId, 'submissionId');
    const submission = aiMrSubmissionsDb.getById(submissionId);
    if (!submission || Number(submission.tenant_id) !== tenantId || Number(submission.user_id) !== userId) {
      throw createHttpError('CodeHub submission not found', 404);
    }
    if (submission.status !== 'mr_failed') {
      throw createHttpError('Only submissions with failed MR creation can be retried', 400);
    }
    if (!submission.project_id) {
      throw createHttpError('Submission project_id is not configured', 400);
    }

    const isCrossProject = Boolean(submission.public_project_id)
      && Number(submission.mr_project_id) === Number(submission.public_project_id);
    const mrProjectId = isCrossProject ? submission.public_project_id : submission.project_id;
    const intervalMinutes = readMrPollIntervalMinutes();
    const commitText = normalizeCommitMessage({
      commitMessage: submission.description || submission.ticket_no,
    });
    const issueNums = extractIssueNumsFromText(commitText).join(';');
    const mrResult = await codeHubMcpService.createMergeRequest({
      userId,
      projectId: submission.project_id,
      sourceProjectId: isCrossProject ? submission.project_id : null,
      targetProjectId: isCrossProject ? submission.public_project_id : null,
      sourceBranch: submission.source_branch,
      targetBranch: submission.target_branch,
      title: submission.mr_title || commitMessageSummary(commitText),
      description: commitText,
      issueNums,
    });

    const updated = aiMrSubmissionsDb.attachMergeRequest({
      submissionId,
      mrId: mrResult?.id || null,
      mrIid: mrResult?.iid || null,
      mrProjectId,
      mrUrl: mrResult?.web_url || mrResult?.webUrl || null,
      mrState: mrResult?.state || 'opened',
      mrCreatedAt: mrResult?.created_at || null,
      mrUpdatedAt: mrResult?.updated_at || null,
      nextCheckAt: addMinutes(new Date(), intervalMinutes).toISOString(),
    });

    res.status(201).json({
      success: true,
      submissionId: updated.id,
      mrId: updated.mr_id,
      mrIid: updated.mr_iid,
      mrUrl: updated.mr_url,
      status: updated.status,
    });
  } catch (error) {
    if (error?.statusCode) return handleWorkspaceError(res, error);
    return sendRouteError(res, error, 'Failed to retry CodeHub merge request creation');
  }
});

export default router;
