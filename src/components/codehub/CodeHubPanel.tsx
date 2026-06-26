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
import { useTranslation } from 'react-i18next';

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
  remote?: string;
  remoteBranch?: string;
  dirty?: boolean;
  changedFiles?: string[];
  remoteChangedFiles?: string[];
  localConflictFiles?: string[];
  mergeConflictFiles?: string[];
  conflictFiles?: string[];
  hasConflicts?: boolean;
  conflictCheckStatus?: string;
  ahead?: number;
  behind?: number;
  recommendation?: string;
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

function statusLabel(status: string, translate: (key: string) => string): string {
  const labels: Record<string, string> = {
    modified: translate('status.modified'),
    added: translate('status.added'),
    deleted: translate('status.deleted'),
    renamed: translate('status.renamed'),
    untracked: translate('status.untracked'),
  };
  return labels[status] || status;
}

function stepClassName(step: WorkflowStep, activeStep: WorkflowStep, done: boolean): string {
  if (done) return 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (step === activeStep) return 'border-primary bg-primary/10 text-primary';
  return 'border-border bg-background text-muted-foreground';
}

export default function CodeHubPanel({ selectedProject, isReadOnly = false }: CodeHubPanelProps) {
  const { t } = useTranslation('codehub');
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
  const pullPreviewRecommendation = useMemo(() => {
    if (!pullPreview) return null;
    const recommendation = pullPreview.recommendation || (pullPreview.dirty ? 'commit-first' : 'pull');
    if (recommendation === 'commit-first') return t('pull.recommendation.commitFirst');
    if (recommendation === 'resolve-conflicts') return t('pull.recommendation.resolveConflicts');
    if (recommendation === 'up-to-date') return t('pull.recommendation.upToDate');
    if (pullPreview.conflictCheckStatus === 'unknown') return t('pull.recommendation.unknown');
    return t('pull.recommendation.pull');
  }, [pullPreview, t]);
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
        setError(await readError(response, t('errors.loadRepositories')));
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
      setError(t('errors.loadRepositories'));
    } finally {
      setIsLoading(false);
    }
  }, [t, workspaceId]);

  const loadChanges = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    setError(null);
    try {
      const response = await api.codehub.changes(workspaceId, selectedRepoId);
      if (!response.ok) {
        setError(await readError(response, t('errors.loadChanges')));
        return;
      }
      const payload = await response.json();
      const nextChanges = payload.files || [];
      setChanges(nextChanges);
      setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: CodeHubChange) => change.path === file)));
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load changes:', caughtError);
      setError(t('errors.loadChanges'));
    }
  }, [selectedRepoId, t, workspaceId]);

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
    setDiff(t('diff.loading'));
    try {
      const response = await api.codehub.diff(workspaceId, selectedRepoId, filePath);
      if (!response.ok) {
        setDiff(await readError(response, t('errors.loadDiff')));
        return;
      }
      const payload = await response.json();
      setDiff(payload.diff || '');
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load diff:', caughtError);
      setDiff(t('errors.loadDiff'));
    }
  }, [selectedRepoId, t, workspaceId]);

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

  const openCommitForPullPreview = useCallback(() => {
    const previewFiles = pullPreview?.changedFiles || [];
    if (previewFiles.length > 0) {
      setSelectedFiles(previewFiles);
    }
    openWorkflow();
  }, [openWorkflow, pullPreview]);

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
      setError(t('errors.cloneRequired'));
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
        setError(await readError(response, t('errors.cloneFailed')));
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
  }, [cloneBranch, cloneDirectory, cloneUrl, isReadOnly, loadRepositories, t, workspaceId]);

  const previewPull = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    setIsWorking(true);
    setError(null);
    try {
      const response = await api.codehub.pullPreview(workspaceId, selectedRepoId, { branch: pullBranch });
      if (!response.ok) {
        setError(await readError(response, t('errors.pullPreviewFailed')));
        return;
      }
      const payload = await response.json();
      setPullPreview(payload);
      await loadChanges();
    } finally {
      setIsWorking(false);
    }
  }, [loadChanges, pullBranch, selectedRepoId, t, workspaceId]);

  const pullRepository = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly) return;
    setIsWorking(true);
    setError(null);
    try {
      const response = await api.codehub.pull(workspaceId, selectedRepoId, { branch: pullBranch });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.pullFailed'));
        return;
      }
      if (payload.conflict) {
        setError(t('errors.pullConflicts', { files: (payload.conflictFiles || []).join(', ') }));
      }
      setPullPreview(null);
      await loadRepositories();
      await loadChanges();
    } finally {
      setIsWorking(false);
    }
  }, [isReadOnly, loadChanges, loadRepositories, pullBranch, selectedRepoId, t, workspaceId]);

  const commitSelectedFiles = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    if (selectedFiles.length === 0) {
      setDialogError(t('errors.selectFile'));
      return;
    }
    if (!commitMessage.trim()) {
      setDialogError(t('errors.commitMessageRequired'));
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
        setDialogError(payload.error || payload.message || t('errors.commitFailed'));
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
  }, [commitMessage, loadChanges, loadRepositories, loadSubmissionCommits, selectedFiles, selectedRepoId, t, workspaceId]);

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
        setDialogError(payload.error || payload.message || t('errors.pushFailed'));
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
  }, [commitRecords.length, committedCommitShas, loadRemoteBranches, loadRepositories, loadSubmissionCommits, selectedRepoId, sourceBranch, sourceBranchMode, t, workspaceId]);

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
        mrTitle: mrTitle || mrDescription.split(/\r?\n/).find((line) => line.trim())?.trim() || t('title'),
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
        setDialogError(payload.error || payload.message || t('errors.createMrFailed'));
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
    t,
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
        setDialogError(payload.error || payload.message || t('errors.retryMrFailed'));
      }
    } finally {
      setIsWorking(false);
    }
  }, [mrResult?.submissionId, t]);

  if (!workspaceId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('workspaceUnsupported')}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{selectedProject.displayName || selectedProject.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSidebarCollapsed((value) => !value)}>
            {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {sidebarCollapsed ? t('showRepositories') : t('hideRepositories')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadRepositories()} disabled={isLoading || isWorking}>
            <RefreshCw className={isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {t('common:buttons.refresh')}
          </Button>
        </div>
      </div>

      <div className={`grid min-h-0 flex-1 gap-0 overflow-hidden ${sidebarCollapsed ? 'grid-cols-1' : 'lg:grid-cols-[320px_minmax(0,1fr)]'}`}>
        {!sidebarCollapsed ? (
        <aside className="min-h-0 overflow-y-auto border-r border-border p-4">
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <GitBranch className="h-4 w-4" />
              {t('repositories.title')}
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
                    {repo.dirty ? <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700">{t('repositories.dirty')}</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{repo.relativePath}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{repo.branch || '-'}</div>
                </button>
              ))}
              {repositories.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  {t('selectOrCloneRepository')}
                </div>
              ) : null}
            </div>
          </section>

          <section className="mt-5 space-y-3 border-t border-border pt-4">
            <div className="text-sm font-medium text-foreground">{t('clone.title')}</div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t('clone.repositoryUrl')}</span>
              <Input
                value={cloneUrl}
                onChange={(event) => {
                  const nextUrl = event.target.value;
                  setCloneUrl(nextUrl);
                  if (!cloneDirectory.trim()) {
                    setCloneDirectory(inferDirectoryName(nextUrl));
                  }
                }}
                placeholder={t('clone.repositoryUrlPlaceholder')}
                disabled={isReadOnly || isWorking}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t('clone.folderName')}</span>
              <Input
                value={cloneDirectory}
                onChange={(event) => setCloneDirectory(event.target.value)}
                placeholder={t('clone.folderNamePlaceholder')}
                disabled={isReadOnly || isWorking}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{t('clone.branch')}</span>
              <Input
                value={cloneBranch}
                onChange={(event) => setCloneBranch(event.target.value)}
                placeholder={t('clone.branchPlaceholder')}
                disabled={isReadOnly || isWorking}
              />
            </label>
            <Button className="w-full" onClick={() => void cloneRepository()} disabled={isReadOnly || isWorking}>
              {t('clone.button')}
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
                      <div className="mt-1 truncate text-xs text-muted-foreground">{t('repository.upstream', { url: selectedRepo.publicRepositoryUrl })}</div>
                    ) : null}
                  </div>

                  <div className="min-w-0">
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <Input
                        value={pullBranch}
                        onChange={(event) => {
                          setPullBranch(event.target.value);
                          setPullPreview(null);
                        }}
                        placeholder={t('pull.branchPlaceholder')}
                      />
                      <div className="flex gap-2 sm:justify-end">
                        <Button variant="outline" size="sm" onClick={() => void previewPull()} disabled={isWorking}>
                          {t('pull.preview')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void pullRepository()}
                          disabled={isReadOnly || isWorking || Boolean(pullPreview?.hasConflicts)}
                          title={pullPreview?.hasConflicts ? t('pull.conflictPullDisabled') : undefined}
                        >
                          <RotateCw className="h-4 w-4" />
                          {t('pull.button')}
                        </Button>
                      </div>
                    </div>
                    {pullPreview ? (
                      <div className={`mt-3 space-y-3 rounded-md border px-3 py-2 text-xs ${
                        pullPreview.hasConflicts
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                          : 'border-border bg-muted/40 text-muted-foreground'
                      }`}
                      >
                        <div>
                          {t('pull.summary', {
                            branch: pullPreview.branch || '-',
                            remote: pullPreview.remote || 'origin',
                            remoteBranch: pullPreview.remoteBranch || pullBranch || '-',
                            ahead: pullPreview.ahead || 0,
                            behind: pullPreview.behind || 0,
                          })}
                        </div>
                        {pullPreviewRecommendation ? (
                          <div className="font-medium text-foreground">{pullPreviewRecommendation}</div>
                        ) : null}
                        {pullPreview.dirty ? (
                          <div>
                            {t('pull.localChanges', {
                              files: (pullPreview.changedFiles || []).length > 0
                                ? (pullPreview.changedFiles || []).join(', ')
                                : t('pull.localChangesUnknown'),
                            })}
                          </div>
                        ) : (
                          <div>{t('pull.clean')}</div>
                        )}
                        {pullPreview.hasConflicts ? (
                          <div className="space-y-3">
                            <div>
                              <div className="font-medium text-foreground">{t('pull.conflictsTitle')}</div>
                              <div className="mt-1 break-words">
                                {t('pull.conflictFiles', {
                                  files: (pullPreview.conflictFiles || []).length > 0
                                    ? (pullPreview.conflictFiles || []).join(', ')
                                    : t('pull.conflictFilesUnknown'),
                                })}
                              </div>
                            </div>
                            <div className="grid gap-2 md:grid-cols-3">
                              <div className="rounded-md border border-border/70 bg-background/70 p-2">
                                <div className="font-medium text-foreground">{t('pull.options.commitFirstTitle')}</div>
                                <div className="mt-1 text-muted-foreground">{t('pull.options.commitFirstDescription')}</div>
                                <Button className="mt-2 w-full" variant="outline" size="sm" onClick={openCommitForPullPreview} disabled={isReadOnly || isWorking}>
                                  {t('pull.options.commitFirstButton')}
                                </Button>
                              </div>
                              <div className="rounded-md border border-border/70 bg-background/70 p-2">
                                <div className="font-medium text-foreground">{t('pull.options.stashTitle')}</div>
                                <div className="mt-1 text-muted-foreground">{t('pull.options.stashDescription')}</div>
                              </div>
                              <div className="rounded-md border border-border/70 bg-background/70 p-2">
                                <div className="font-medium text-foreground">{t('pull.options.manualTitle')}</div>
                                <div className="mt-1 text-muted-foreground">{t('pull.options.manualDescription')}</div>
                                <Button className="mt-2 w-full" variant="outline" size="sm" onClick={() => void pullRepository()} disabled={isReadOnly || isWorking}>
                                  {t('pull.options.manualButton')}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="rounded-md border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{t('submission.title')}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t('submission.summary', { count: commitRecords.length, targetBranch })}
                      {remoteBranchesAtHead.length > 0 ? t('submission.pushedTo', { branches: remoteBranchesAtHead.map((branch) => `origin/${branch}`).join(', ') }) : ''}
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
                      {t('submission.pushCommits')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={openMrWorkflow}
                      disabled={isReadOnly || isWorking || !canCreateMr}
                    >
                      <GitPullRequest className="h-4 w-4" />
                      {t('submission.createMr')}
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
                    {t('submission.existingMr')}
                    {existingMergeRequest.mrIid ? `: !${existingMergeRequest.mrIid}` : ''}
                    {existingMergeRequest.mrUrl ? (
                      <a className="ml-2 underline" href={existingMergeRequest.mrUrl} target="_blank" rel="noreferrer">
                        {t('submission.open')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </section>

              <section className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                <div className="rounded-md border border-border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div>
                      <div className="text-sm font-medium text-foreground">{t('changes.title')}</div>
                      <div className="text-xs text-muted-foreground">{t('changes.selected', { count: selectedFiles.length })}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openWorkflow}
                        disabled={isReadOnly || isWorking || selectedFiles.length === 0}
                      >
                        <GitCommitHorizontal className="h-4 w-4" />
                        {t('changes.commit')}
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
                          <div className="text-xs text-muted-foreground">{statusLabel(change.status, t)}</div>
                        </button>
                      </div>
                    ))}
                    {changes.length === 0 ? (
                      <div className="px-3 py-8 text-center text-sm text-muted-foreground">{t('changes.empty')}</div>
                    ) : null}
                  </div>
                </div>

                <div className="min-h-[420px] rounded-md border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                    <div className="min-w-0 truncate text-sm font-medium text-foreground">{activeFile || t('diff.title')}</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setDiffDialogOpen(true)}
                      disabled={!diff}
                      aria-label={t('diff.largeView')}
                      title={t('diff.largeView')}
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
              {t('selectOrCloneRepository')}
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
          <DialogTitle>{activeFile || t('diff.title')}</DialogTitle>
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 truncate text-sm font-medium text-foreground">{activeFile || t('diff.title')}</div>
            <Button type="button" variant="outline" size="sm" onClick={() => setDiffDialogOpen(false)}>
              {t('diff.close')}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <CodeHubSideBySideDiff diff={diff} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={workflowOpen} onOpenChange={setWorkflowOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-lg">
          <DialogTitle>{t('workflow.title')}</DialogTitle>
          <div className="space-y-5 p-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">{t('workflow.heading')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('workflow.description')}
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('commit', workflowStep, commitRecords.length > 0)}`}>
                {t('workflow.steps.commit')}
              </div>
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('push', workflowStep, sourceBranchPushedAtHead)}`}>
                {t('workflow.steps.push')}
              </div>
              <div className={`rounded-md border px-3 py-2 text-sm ${stepClassName('mr', workflowStep, Boolean(mrResult?.success))}`}>
                {t('workflow.steps.mr')}
              </div>
            </div>

            {workflowStep === 'commit' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">{t('workflow.commitMessage')}</div>
                <textarea
                  className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={t('workflow.commitMessagePlaceholder')}
                />
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {t('workflow.selectedFilesMessage', { count: selectedFiles.length })}
                </div>
                <Button onClick={() => void commitSelectedFiles()} disabled={isWorking}>
                  <GitCommitHorizontal className="h-4 w-4" />
                  {t('workflow.commitSelectedFiles')}
                </Button>
              </section>
            ) : null}

            {workflowStep === 'push' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">{t('workflow.pushBranch')}</div>
                {commitRecords.length > 0 ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t('workflow.pushSummary', { count: commitRecords.length, targetBranch })}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-1">
                  <Button
                    variant={sourceBranchMode === 'new' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSourceBranchMode('new')}
                  >
                    {t('workflow.newBranch')}
                  </Button>
                  <Button
                    variant={sourceBranchMode === 'existing' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setSourceBranchMode('existing')}
                  >
                    {t('workflow.existingBranch')}
                  </Button>
                </div>
                {sourceBranchMode === 'existing' ? (
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
                    value={sourceBranch}
                    onChange={(event) => setSourceBranch(event.target.value)}
                  >
                    <option value="">{t('workflow.selectSourceBranch')}</option>
                    {remoteBranches.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                ) : (
                  <Input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} placeholder={t('workflow.sourceBranchPlaceholder')} />
                )}
                <Button onClick={() => void pushBranch()} disabled={isWorking || commitRecords.length === 0}>
                  <GitBranch className="h-4 w-4" />
                  {t('submission.pushCommits')}
                </Button>
              </section>
            ) : null}

            {workflowStep === 'mr' ? (
              <section className="space-y-3">
                <div className="text-sm font-medium text-foreground">{t('workflow.createMergeRequest')}</div>
                {pushResult?.success ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t('workflow.pushed', { remote: pushResult.remote || 'origin', branch: pushResult.branch })}
                    {pushResult.pushedHeadSha ? t('workflow.pushedAt', { sha: pushResult.pushedHeadSha.slice(0, 8) }) : ''}
                  </div>
                ) : remoteBranchesAtHead.length > 0 ? (
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    {t('workflow.headAvailable', { branches: remoteBranchesAtHead.map((branch) => `origin/${branch}`).join(', ') })}
                  </div>
                ) : null}
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('workflow.sourceBranch')}</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
                    value={sourceBranch}
                    onChange={(event) => setSourceBranch(event.target.value)}
                    disabled={remoteBranchesAtHead.length === 0}
                  >
                    {remoteBranchesAtHead.length === 0 ? (
                      <option value="">{t('workflow.pushHeadFirst')}</option>
                    ) : null}
                    {remoteBranchesAtHead.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
                <Input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} placeholder={t('workflow.targetBranchPlaceholder')} />
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{t('workflow.mergeTargetRepository')}</div>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-1">
                    <Button
                      variant={mrTargetRepository === 'personal' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setMrTargetRepository('personal')}
                    >
                      {t('workflow.personalRepo')}
                    </Button>
                    <Button
                      variant={mrTargetRepository === 'upstream' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => setMrTargetRepository('upstream')}
                      disabled={!selectedRepo?.publicProjectId}
                      title={selectedRepo?.publicProjectId ? t('workflow.upstreamRepoTitle') : t('workflow.noUpstreamRepoTitle')}
                    >
                      {t('workflow.upstreamRepo')}
                    </Button>
                  </div>
                </div>
                <Input value={mrTitle} onChange={(event) => setMrTitle(event.target.value)} placeholder={t('workflow.mrTitlePlaceholder')} />
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {t('workflow.mrDescriptionMessage', { targetBranch })}
                </div>
                {existingMergeRequest ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {t('workflow.existingMrMessage')}
                    {existingMergeRequest.mrIid ? `: !${existingMergeRequest.mrIid}` : ''}.
                    {existingMergeRequest.mrUrl ? (
                      <a className="ml-2 underline" href={existingMergeRequest.mrUrl} target="_blank" rel="noreferrer">
                        {t('workflow.openMr')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <Button onClick={() => void createMergeRequest()} disabled={isWorking || !canCreateMr}>
                  <GitPullRequest className="h-4 w-4" />
                  {t('submission.createMr')}
                </Button>
              </section>
            ) : null}

            {mrResult ? (
              <section className="space-y-2 rounded-md border border-border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {mrResult.success ? <Check className="h-4 w-4 text-emerald-600" /> : <GitMerge className="h-4 w-4 text-amber-600" />}
                  {t('workflow.submissionStatus', { status: mrResult.status || '' })}
                </div>
                {mrResult.commitSha ? <div className="break-all text-xs text-muted-foreground">{t('workflow.commitSha', { sha: mrResult.commitSha })}</div> : null}
                {mrResult.mrIid ? <div className="text-xs text-muted-foreground">{t('workflow.mrIid', { iid: mrResult.mrIid })}</div> : null}
                {mrResult.mrUrl ? (
                  <a className="block truncate text-xs text-primary underline" href={mrResult.mrUrl} target="_blank" rel="noreferrer">
                    {mrResult.mrUrl}
                  </a>
                ) : null}
                {!mrResult.success && mrResult.submissionId ? (
                  <Button variant="outline" size="sm" onClick={() => void retryMr()} disabled={isWorking}>
                    {t('workflow.retryMrCreation')}
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
                {t('workflow.close')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
