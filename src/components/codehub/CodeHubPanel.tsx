import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Maximize2,
  RefreshCw,
  RotateCw,
} from 'lucide-react';

import type { Project } from '../../types/app';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../shared/view/ui';
import { api } from '../../utils/api';
import CodeHubSideBySideDiff from './CodeHubSideBySideDiff';

type CodeHubRepository = {
  repoId: number;
  name: string;
  relativePath: string;
  repositoryUrl: string;
  projectId?: number | null;
  publicRepositoryUrl?: string | null;
  publicProjectId?: number | null;
  branch?: string;
  remoteUrl?: string;
  dirty?: boolean;
};

type CodeHubChange = {
  path: string;
  status: string;
};

type PullPreview = {
  branch?: string;
  remoteBranch?: string;
  dirty?: boolean;
  changedFiles?: string[];
  ahead?: number;
  behind?: number;
};

type CommitResult = {
  success?: boolean;
  commitSha?: string;
  commitMessage?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
};

type PushResult = {
  success?: boolean;
  branch?: string;
  remote?: string;
  pushedHeadSha?: string;
  pushedCommitShas?: string[];
  pushedAt?: string;
};

type MrResult = {
  success?: boolean;
  submissionId?: number;
  commitSha?: string;
  mrIid?: string | null;
  mrUrl?: string | null;
  status?: string;
  error?: string;
  details?: string;
};

type ExistingMergeRequest = {
  submissionId?: number;
  commitSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
  mrProjectId?: number | null;
  mrId?: string | null;
  mrIid?: string | null;
  mrUrl?: string | null;
  status?: string;
  mrState?: string | null;
};

type WorkflowStep = 'commit' | 'push' | 'mr';
type MrTargetRepository = 'personal' | 'upstream';
type CommitRecord = CommitResult & {
  commitSha: string;
  committedAt: string;
};

type CodeHubPanelProps = {
  selectedProject: Project;
  isReadOnly?: boolean;
};

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => ({}));
  return payload.error || payload.message || payload.details || fallback;
}

function inferDirectoryName(repositoryUrl: string): string {
  const clean = repositoryUrl.trim().replace(/\/$/, '');
  const last = clean.split('/').pop() || '';
  return last.replace(/\.git$/i, '') || 'repo';
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    modified: 'Modified',
    added: 'Added',
    deleted: 'Deleted',
    renamed: 'Renamed',
    untracked: 'Untracked',
  };
  return labels[status] || status;
}

function stepClassName(step: WorkflowStep, activeStep: WorkflowStep, done: boolean): string {
  if (done) return 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (step === activeStep) return 'border-primary bg-primary/10 text-primary';
  return 'border-border bg-background text-muted-foreground';
}

export default function CodeHubPanel({ selectedProject, isReadOnly = false }: CodeHubPanelProps) {
  const workspaceId = selectedProject.workspaceId;
  const [repositories, setRepositories] = useState<CodeHubRepository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [changes, setChanges] = useState<CodeHubChange[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [diff, setDiff] = useState('');
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDirectory, setCloneDirectory] = useState('');
  const [cloneBranch, setCloneBranch] = useState('');
  const [pullBranch, setPullBranch] = useState('');
  const [pullPreview, setPullPreview] = useState<PullPreview | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [sourceBranchMode, setSourceBranchMode] = useState<'new' | 'existing'>('new');
  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('develop');
  const [mrTargetRepository, setMrTargetRepository] = useState<MrTargetRepository>('personal');
  const [mrTitle, setMrTitle] = useState('');
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('commit');
  const [commitRecords, setCommitRecords] = useState<CommitRecord[]>([]);
  const [headSha, setHeadSha] = useState('');
  const [remoteBranchesAtHead, setRemoteBranchesAtHead] = useState<string[]>([]);
  const [activeMergeRequests, setActiveMergeRequests] = useState<ExistingMergeRequest[]>([]);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [mrResult, setMrResult] = useState<MrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const initializedRepoIdRef = useRef<number | null>(null);

  const selectedRepo = useMemo(
    () => repositories.find((repo) => repo.repoId === selectedRepoId) || null,
    [repositories, selectedRepoId],
  );
  const committedCommitShas = useMemo(
    () => commitRecords.map((commit) => commit.commitSha),
    [commitRecords],
  );
  const hasActiveCommitBatch = commitRecords.length > 0;
  const sourceBranchPushedAtHead = Boolean(
    sourceBranch
      && (
        remoteBranchesAtHead.includes(sourceBranch)
        || (pushResult?.success && pushResult.branch === sourceBranch && pushResult.pushedHeadSha === headSha)
      ),
  );
  const selectedMrProjectId = mrTargetRepository === 'upstream' ? selectedRepo?.publicProjectId : selectedRepo?.projectId;
  const existingMergeRequest = useMemo(
    () => activeMergeRequests.find((mr) => (
      mr.sourceBranch === sourceBranch
      && mr.targetBranch === targetBranch
      && Number(mr.mrProjectId || 0) === Number(selectedMrProjectId || 0)
    )) || null,
    [activeMergeRequests, selectedMrProjectId, sourceBranch, targetBranch],
  );
  const canCreateMr = Boolean(headSha && hasActiveCommitBatch && sourceBranchPushedAtHead && !existingMergeRequest);
  const batchCommitMessage = useMemo(
    () => commitRecords
      .map((commit) => commit.commitMessage || commit.commitSha)
      .filter(Boolean)
      .join('\n\n'),
    [commitRecords],
  );

  const loadRepositories = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.codehub.repositories(workspaceId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load CodeHub repositories'));
        return;
      }
      const payload = await response.json();
      const nextRepositories = payload.repositories || [];
      setRepositories(nextRepositories);
      setSelectedRepoId((current) => {
        if (current && nextRepositories.some((repo: CodeHubRepository) => repo.repoId === current)) {
          return current;
        }
        return nextRepositories[0]?.repoId || null;
      });
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load repositories:', caughtError);
      setError('Failed to load CodeHub repositories');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  const loadChanges = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    setError(null);
    try {
      const response = await api.codehub.changes(workspaceId, selectedRepoId);
      if (!response.ok) {
        setError(await readError(response, 'Failed to load repository changes'));
        return;
      }
      const payload = await response.json();
      const nextChanges = payload.files || [];
      setChanges(nextChanges);
      setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: CodeHubChange) => change.path === file)));
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load changes:', caughtError);
      setError('Failed to load repository changes');
    }
  }, [selectedRepoId, workspaceId]);

  const loadRemoteBranches = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    try {
      const response = await api.codehub.remoteBranches(workspaceId, selectedRepoId);
      if (!response.ok) return;
      const payload = await response.json();
      setRemoteBranches(payload.branches || []);
    } catch (caughtError) {
      console.warn('[CodeHubPanel] Failed to load remote branches:', caughtError);
    }
  }, [selectedRepoId, workspaceId]);

  const loadSubmissionCommits = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    try {
      const response = await api.codehub.submissionCommits(workspaceId, selectedRepoId, targetBranch);
      if (!response.ok) return;
      const payload = await response.json();
      const commits = payload.commits || [];
      const branchesAtHead = payload.remoteBranchesAtHead || [];
      setCommitRecords(commits);
      setHeadSha(payload.headSha || '');
      setRemoteBranchesAtHead(branchesAtHead);
      setActiveMergeRequests(payload.activeMergeRequests || []);
      setSourceBranch((current) => {
        if (current && branchesAtHead.includes(current)) return current;
        if (branchesAtHead[0]) return branchesAtHead[0];
        return current || payload.currentBranch || '';
      });
    } catch (caughtError) {
      console.warn('[CodeHubPanel] Failed to load submission commits:', caughtError);
    }
  }, [selectedRepoId, targetBranch, workspaceId]);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    void loadSubmissionCommits();
  }, [loadSubmissionCommits]);

  useEffect(() => {
    if (!selectedRepo) {
      initializedRepoIdRef.current = null;
      return;
    }
    const repoChanged = initializedRepoIdRef.current !== selectedRepo.repoId;
    initializedRepoIdRef.current = selectedRepo.repoId;
    if (!repoChanged) return;

    setPullBranch(selectedRepo.branch || 'develop');
    setSourceBranch(selectedRepo.branch || '');
    setTargetBranch(selectedRepo.branch || 'develop');
    setMrTargetRepository('personal');
    setPullPreview(null);
    setWorkflowOpen(false);
    setCommitRecords([]);
    setHeadSha('');
    setRemoteBranchesAtHead([]);
    setActiveMergeRequests([]);
    setPushResult(null);
    setMrResult(null);
    void loadChanges();
    void loadRemoteBranches();
  }, [loadChanges, loadRemoteBranches, selectedRepo]);

  const openDiff = useCallback(async (filePath: string) => {
    if (!workspaceId || !selectedRepoId) return;
    setActiveFile(filePath);
    setDiff('Loading diff...');
    try {
      const response = await api.codehub.diff(workspaceId, selectedRepoId, filePath);
      if (!response.ok) {
        setDiff(await readError(response, 'Failed to load diff'));
        return;
      }
      const payload = await response.json();
      setDiff(payload.diff || '');
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load diff:', caughtError);
      setDiff('Failed to load diff');
    }
  }, [selectedRepoId, workspaceId]);

  const toggleFile = useCallback((filePath: string, checked: boolean) => {
    setSelectedFiles((current) => {
      if (checked) return current.includes(filePath) ? current : [...current, filePath];
      return current.filter((file) => file !== filePath);
    });
  }, []);

  const openWorkflow = useCallback(() => {
    setDialogError(null);
    setWorkflowStep('commit');
    setWorkflowOpen(true);
  }, []);

  const openPushWorkflow = useCallback(() => {
    setDialogError(null);
    setWorkflowStep('push');
    setWorkflowOpen(true);
    void loadRemoteBranches();
  }, [loadRemoteBranches]);

  const openMrWorkflow = useCallback(() => {
    setDialogError(null);
    setWorkflowStep('mr');
    setWorkflowOpen(true);
  }, []);

  const cloneRepository = useCallback(async () => {
    if (!workspaceId || isReadOnly) return;
    const repositoryUrl = cloneUrl.trim();
    const directoryName = (cloneDirectory.trim() || inferDirectoryName(repositoryUrl)).trim();
    if (!repositoryUrl || !directoryName) {
      setError('Repository URL and directory are required');
      return;
    }
    setIsWorking(true);
    setError(null);
    try {
      const branch = cloneBranch.trim();
      const response = await api.codehub.cloneRepository(workspaceId, {
        repositoryUrl,
        directoryName,
        ...(branch ? { branch } : {}),
      });
      if (!response.ok) {
        setError(await readError(response, 'Failed to clone repository'));
        return;
      }
      setCloneUrl('');
      setCloneDirectory('');
      setCloneBranch('');
      await loadRepositories();
      await window.refreshProjects?.();
    } finally {
      setIsWorking(false);
    }
  }, [cloneBranch, cloneDirectory, cloneUrl, isReadOnly, loadRepositories, workspaceId]);

  const previewPull = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    setIsWorking(true);
    setError(null);
    try {
      const response = await api.codehub.pullPreview(workspaceId, selectedRepoId, { branch: pullBranch });
      if (!response.ok) {
        setError(await readError(response, 'Failed to preview pull'));
        return;
      }
      setPullPreview(await response.json());
    } finally {
      setIsWorking(false);
    }
  }, [pullBranch, selectedRepoId, workspaceId]);

  const pullRepository = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly) return;
    setIsWorking(true);
    setError(null);
    try {
      const response = await api.codehub.pull(workspaceId, selectedRepoId, { branch: pullBranch });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || 'Failed to pull repository updates');
        return;
      }
      if (payload.conflict) {
        setError(`Pull has conflicts: ${(payload.conflictFiles || []).join(', ')}`);
      }
      await loadRepositories();
      await loadChanges();
    } finally {
      setIsWorking(false);
    }
  }, [isReadOnly, loadChanges, loadRepositories, pullBranch, selectedRepoId, workspaceId]);

  const commitSelectedFiles = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    if (selectedFiles.length === 0) {
      setDialogError('Select at least one changed file');
      return;
    }
    if (!commitMessage.trim()) {
      setDialogError('Commit message is required');
      return;
    }
    setIsWorking(true);
    setDialogError(null);
    try {
      const response = await api.codehub.commit(workspaceId, selectedRepoId, {
        commitMessage,
        files: selectedFiles,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDialogError(payload.error || payload.message || 'Failed to commit CodeHub changes');
        return;
      }
      setCommitMessage('');
      setSelectedFiles([]);
      setMrResult(null);
      await loadRepositories();
      await loadChanges();
      await loadSubmissionCommits();
    } finally {
      setIsWorking(false);
    }
  }, [commitMessage, loadChanges, loadRepositories, loadSubmissionCommits, selectedFiles, selectedRepoId, workspaceId]);

  const pushBranch = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || commitRecords.length === 0) return;
    setIsWorking(true);
    setDialogError(null);
    try {
      const response = await api.codehub.push(workspaceId, selectedRepoId, {
        sourceBranchMode,
        sourceBranch,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDialogError(payload.error || payload.message || 'Failed to push CodeHub branch');
        return;
      }
      setPushResult({
        ...payload,
        pushedCommitShas: committedCommitShas,
        pushedAt: new Date().toISOString(),
      });
      setSourceBranch(payload.branch || sourceBranch);
      setMrResult(null);
      setWorkflowStep('mr');
      await loadRepositories();
      await loadRemoteBranches();
      await loadSubmissionCommits();
    } finally {
      setIsWorking(false);
    }
  }, [commitRecords.length, committedCommitShas, loadRemoteBranches, loadRepositories, loadSubmissionCommits, selectedRepoId, sourceBranch, sourceBranchMode, workspaceId]);

  const createMergeRequest = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || !headSha || !sourceBranch || !sourceBranchPushedAtHead) return;
    setIsWorking(true);
    setDialogError(null);
    setMrResult(null);
    try {
      const mrDescription = batchCommitMessage || commitRecords.map((commit) => commit.commitSha).join('\n');
      const response = await api.codehub.createMergeRequest(workspaceId, selectedRepoId, {
        commitSha: headSha,
        commitShas: committedCommitShas,
        commitMessage: mrDescription,
        sourceBranch,
        targetBranch,
        mrTargetRepository,
        mrTitle: mrTitle || mrDescription.split(/\r?\n/).find((line) => line.trim())?.trim() || 'CodeHub submission',
      });
      const payload = await response.json().catch(() => ({}));
      setMrResult(payload);
      if (!response.ok) {
        if (payload.existingMergeRequest) {
          setActiveMergeRequests((current) => [
            payload.existingMergeRequest,
            ...current.filter((mr) => mr.submissionId !== payload.existingMergeRequest.submissionId),
          ]);
        }
        setDialogError(payload.error || payload.message || 'Failed to create CodeHub MR');
        return;
      }
      setSelectedFiles([]);
      await loadRepositories();
      await loadChanges();
      await loadRemoteBranches();
      await loadSubmissionCommits();
    } finally {
      setIsWorking(false);
    }
  }, [
    batchCommitMessage,
    commitRecords,
    committedCommitShas,
    headSha,
    loadChanges,
    loadRemoteBranches,
    loadRepositories,
    loadSubmissionCommits,
    mrTargetRepository,
    mrTitle,
    selectedRepoId,
    sourceBranch,
    sourceBranchPushedAtHead,
    targetBranch,
    workspaceId,
  ]);

  const retryMr = useCallback(async () => {
    if (!mrResult?.submissionId) return;
    setIsWorking(true);
    setDialogError(null);
    try {
      const response = await api.codehub.retryMr(mrResult.submissionId);
      const payload = await response.json().catch(() => ({}));
      setMrResult(payload);
      if (!response.ok) {
        setDialogError(payload.error || payload.message || 'Failed to retry MR creation');
      }
    } finally {
      setIsWorking(false);
    }
  }, [mrResult?.submissionId]);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Current workspace does not support CodeHub.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">CodeHub</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectedProject.displayName || selectedProject.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSidebarCollapsed((value) => !value)}>
            {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {sidebarCollapsed ? 'Show repositories' : 'Hide repositories'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadRepositories()} disabled={isLoading || isWorking}>
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Refresh
          </Button>
        </div>
      </div>

      <div className={`grid min-h-0 flex-1 gap-0 overflow-hidden ${sidebarCollapsed ? 'grid-cols-1' : 'lg:grid-cols-[320px_minmax(0,1fr)]'}`}>
        {!sidebarCollapsed ? (
        <aside className="min-h-0 overflow-y-auto border-r border-border p-4">
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <GitBranch className="h-4 w-4" />
              Repositories
            </div>
            <div className="space-y-2">
              {repositories.map((repo) => (
                <button
                  key={repo.repoId}
                  type="button"
                  onClick={() => setSelectedRepoId(repo.repoId)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted/60 ${
                    repo.repoId === selectedRepoId ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-foreground">{repo.name}</span>
                    {repo.dirty ? <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700">dirty</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{repo.relativePath}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{repo.branch || '-'}</div>
                </button>
              ))}
              {repositories.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  No CodeHub repositories found.
                </div>
              ) : null}
            </div>
          </section>

          <section className="mt-5 space-y-3 border-t border-border pt-4">
            <div className="text-sm font-medium text-foreground">Clone repository</div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Repository URL</span>
              <Input
                value={cloneUrl}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  setCloneUrl(nextUrl);
                  if (!cloneDirectory.trim()) {
                    setCloneDirectory(inferDirectoryName(nextUrl));
                  }
                }}
                placeholder="https://codehub.../repo.git"
                disabled={isReadOnly || isWorking}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Workspace folder name</span>
              <Input
                value={cloneDirectory}
                onChange={(event) => setCloneDirectory(event.target.value)}
                placeholder="folder-name"
                disabled={isReadOnly || isWorking}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Branch (optional)</span>
              <Input
                value={cloneBranch}
                onChange={(event) => setCloneBranch(event.target.value)}
                placeholder="Optional, uses default branch when empty"
                disabled={isReadOnly || isWorking}
              />
            </label>
            <Button className="w-full" onClick={() => void cloneRepository()} disabled={isReadOnly || isWorking}>
              Clone
            </Button>
          </section>
        </aside>
        ) : null}

        <main className="min-h-0 overflow-y-auto p-4">
          {selectedRepo ? (
            <div className="space-y-4">
              <section className="rounded-md border border-border bg-background p-3">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{selectedRepo.name}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{selectedRepo.repositoryUrl}</div>
                    {selectedRepo.publicRepositoryUrl ? (
                      <div className="mt-1 truncate text-xs text-muted-foreground">Upstream: {selectedRepo.publicRepositoryUrl}</div>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <Input value={pullBranch} onChange={(event) => setPullBranch(event.target.value)} placeholder="Branch to pull" />
                      <div className="flex gap-2 sm:justify-end">
                        <Button variant="outline" size="sm" onClick={() => void previewPull()} disabled={isWorking}>
                          Preview
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => void pullRepository()} disabled={isReadOnly || isWorking}>
                          <RotateCw className="h-4 w-4" />
                          Pull
                        </Button>
                      </div>
                    </div>
                    {pullPreview ? (
                      <div className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        {pullPreview.remoteBranch}: ahead {pullPreview.ahead || 0}, behind {pullPreview.behind || 0}.
                        {pullPreview.dirty ? ` Local changes: ${(pullPreview.changedFiles || []).join(', ')}` : ' Worktree clean.'}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">Submission batch</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {commitRecords.length} commits from origin/{targetBranch} to HEAD
                      {remoteBranchesAtHead.length > 0 ? `, pushed to ${remoteBranchesAtHead.map((branch) => `origin/${branch}`).join(', ')}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={openPushWorkflow}
                      disabled={isReadOnly || isWorking || commitRecords.length === 0}
                    >
                      <GitBranch className="h-4 w-4" />
                      Push commits
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={openMrWorkflow}
                      disabled={isReadOnly || isWorking || !canCreateMr}
                    >
                      <GitPullRequest className="h-4 w-4" />
                      Create MR
                    </Button>
                  </div>
                </div>
                {commitRecords.length > 0 ? (
                  <div className="mt-3 max-h-28 overflow-y-auto rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {commitRecords.map((commit) => (
                      <div key={commit.commitSha} className="flex min-w-0 items-center justify-between gap-3 py-0.5">
                        <span className="min-w-0 truncate">{commit.commitMessage?.split(/\r?\n/)[0] || commit.commitSha}</span>
                        <span className="shrink-0 font-mono">{commit.commitSha.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {existingMergeRequest ? (
                  <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    Existing MR detected for this HEAD
                    {existingMergeRequest.mrIid ? `: !${existingMergeRequest.mrIid}` : ''}
                    {existingMergeRequest.mrUrl ? (
                      <a className="ml-2 underline" href={existingMergeRequest.mrUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="rounded-md border border-border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">Changed files</div>
                      <div className="text-xs text-muted-foreground">{selectedFiles.length} selected</div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openWorkflow}
                        disabled={isReadOnly || isWorking || selectedFiles.length === 0}
                      >
                        <GitCommitHorizontal className="h-4 w-4" />
                        Commit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void loadChanges()} disabled={isWorking}>
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-[520px] overflow-y-auto p-2">
                    {changes.map((change) => (
                      <div
                        key={change.path}
                        className={`grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded px-2 py-2 text-sm hover:bg-muted/50 ${
                          activeFile === change.path ? 'bg-muted/60' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                          checked={selectedFiles.includes(change.path)}
                          onChange={(event) => toggleFile(change.path, event.target.checked)}
                        />
                        <button type="button" className="min-w-0 text-left" onClick={() => void openDiff(change.path)}>
                          <div className="truncate text-foreground">{change.path}</div>
                          <div className="text-xs text-muted-foreground">{statusLabel(change.status)}</div>
                        </button>
                      </div>
                    ))}
                    {changes.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-muted-foreground">No local changes.</div>
                    ) : null}
                  </div>
                </div>

                <div className="min-h-[420px] rounded-md border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div className="min-w-0 truncate text-sm font-medium text-foreground">{activeFile || 'Diff'}</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setDiffDialogOpen(true)}
                      disabled={!diff}
                      aria-label="Open diff in large view"
                      title="Open diff in large view"
                    >
                      <Maximize2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="h-[520px]">
                    <CodeHubSideBySideDiff diff={diff} />
                  </div>
                </div>
              </section>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select or clone a CodeHub repository.
            </div>
          )}

          {error ? (
            <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </main>
      </div>

      <Dialog open={diffDialogOpen} onOpenChange={setDiffDialogOpen}>
        <DialogContent className="flex h-[88vh] max-h-[88vh] w-[94vw] max-w-[94vw] flex-col overflow-hidden rounded-lg p-0">
          <DialogTitle>{activeFile || 'Diff'}</DialogTitle>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">{activeFile || 'Diff'}</div>
            <Button type="button" variant="outline" size="sm" onClick={() => setDiffDialogOpen(false)}>
              Close
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <CodeHubSideBySideDiff diff={diff} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={workflowOpen} onOpenChange={setWorkflowOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-lg">
          <DialogTitle>Commit, push, and create MR</DialogTitle>
          <div className="space-y-5 p-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">Submit selected CodeHub changes</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Commit, push, and MR creation are separate steps. A later step can be retried without repeating earlier successful steps.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('commit', workflowStep, commitRecords.length > 0)}`}>
                1. Commit
              </div>
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('push', workflowStep, sourceBranchPushedAtHead)}`}>
                2. Push
              </div>
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('mr', workflowStep, Boolean(mrResult?.success))}`}>
                3. MR
              </div>
            </div>

            {workflowStep === 'commit' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">Commit message</div>
                <textarea
                  className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="Enter commit message"
                />
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {selectedFiles.length} files selected. This message will be added to the current submission batch.
                </div>
                <Button onClick={() => void commitSelectedFiles()} disabled={isWorking}>
                  <GitCommitHorizontal className="h-4 w-4" />
                  Commit selected files
                </Button>
              </section>
            ) : null}

            {workflowStep === 'push' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">Push branch</div>
                {commitRecords.length > 0 ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {commitRecords.length} commits from origin/{targetBranch} to current HEAD. Pushing will update the selected remote branch to HEAD.
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-1">
                  <Button
                    variant={sourceBranchMode === 'new' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSourceBranchMode('new')}
                  >
                    New branch
                  </Button>
                  <Button
                    variant={sourceBranchMode === 'existing' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSourceBranchMode('existing')}
                  >
                    Existing
                  </Button>
                </div>
                {sourceBranchMode === 'existing' ? (
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
                    value={sourceBranch}
                    onChange={(event) => setSourceBranch(event.target.value)}
                  >
                    <option value="">Select source branch</option>
                    {remoteBranches.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                ) : (
                  <Input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} placeholder="feature/AR00000001" />
                )}
                <Button onClick={() => void pushBranch()} disabled={isWorking || commitRecords.length === 0}>
                  <GitBranch className="h-4 w-4" />
                  Push commits
                </Button>
              </section>
            ) : null}

            {workflowStep === 'mr' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">Create merge request</div>
                {pushResult?.success ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Pushed: {pushResult.remote || 'origin'}/{pushResult.branch}
                    {pushResult.pushedHeadSha ? ` at ${pushResult.pushedHeadSha.slice(0, 8)}` : ''}
                  </div>
                ) : remoteBranchesAtHead.length > 0 ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    Current HEAD is available on {remoteBranchesAtHead.map((branch) => `origin/${branch}`).join(', ')}.
                  </div>
                ) : null}
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">Source branch</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
                    value={sourceBranch}
                    onChange={(event) => setSourceBranch(event.target.value)}
                    disabled={remoteBranchesAtHead.length === 0}
                  >
                    {remoteBranchesAtHead.length === 0 ? (
                      <option value="">Push HEAD to a remote branch first</option>
                    ) : null}
                    {remoteBranchesAtHead.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
                <Input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} placeholder="target branch" />
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Merge target repository</div>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-1">
                    <Button
                      variant={mrTargetRepository === 'personal' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setMrTargetRepository('personal')}
                    >
                      Personal repo
                    </Button>
                    <Button
                      variant={mrTargetRepository === 'upstream' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setMrTargetRepository('upstream')}
                      disabled={!selectedRepo?.publicProjectId}
                      title={selectedRepo?.publicProjectId ? 'Create MR into upstream repository' : 'No upstream repository detected'}
                    >
                      Upstream repo
                    </Button>
                  </div>
                </div>
                <Input value={mrTitle} onChange={(event) => setMrTitle(event.target.value)} placeholder="MR title" />
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  MR description will use the commit messages from origin/{targetBranch} to HEAD.
                </div>
                {existingMergeRequest ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    A merge request already exists for this source branch and HEAD
                    {existingMergeRequest.mrIid ? `: !${existingMergeRequest.mrIid}` : ''}.
                    {existingMergeRequest.mrUrl ? (
                      <a className="ml-2 underline" href={existingMergeRequest.mrUrl} target="_blank" rel="noreferrer">
                        Open MR
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <Button onClick={() => void createMergeRequest()} disabled={isWorking || !canCreateMr}>
                  <GitPullRequest className="h-4 w-4" />
                  Create MR
                </Button>
              </section>
            ) : null}

            {mrResult ? (
              <section className="space-y-2 rounded-md border border-border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {mrResult.success ? <Check className="h-4 w-4 text-emerald-600" /> : <GitMerge className="h-4 w-4 text-amber-600" />}
                  Submission {mrResult.status || ''}
                </div>
                {mrResult.commitSha ? <div className="break-all text-xs text-muted-foreground">Commit: {mrResult.commitSha}</div> : null}
                {mrResult.mrIid ? <div className="text-xs text-muted-foreground">MR: !{mrResult.mrIid}</div> : null}
                {mrResult.mrUrl ? (
                  <a className="block truncate text-xs text-primary underline" href={mrResult.mrUrl} target="_blank" rel="noreferrer">
                    {mrResult.mrUrl}
                  </a>
                ) : null}
                {!mrResult.success && mrResult.submissionId ? (
                  <Button variant="outline" size="sm" onClick={() => void retryMr()} disabled={isWorking}>
                    Retry MR creation
                  </Button>
                ) : null}
                {mrResult.details ? <div className="text-xs text-destructive">{mrResult.details}</div> : null}
              </section>
            ) : null}

            {dialogError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {dialogError}
              </div>
            ) : null}

            <div className="flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="outline" onClick={() => setWorkflowOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
