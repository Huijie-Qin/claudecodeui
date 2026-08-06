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
import { subscribeProjectFilesChanged } from '../file-tree/utils/fileTreeEvents';

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
  localChangesBlockPull?: boolean;
  conflictCheckStatus?: string;
  ahead?: number;
  behind?: number;
  recommendation?: string;
};

type StashRecord = {
  stashRef: string;
  stashSha?: string;
  stashSubject?: string;
};

type ConflictState = {
  source: 'pull' | 'stash';
  files: string[];
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

type CodeHubToast = {
  message: string;
  type: 'success';
} | null;

type FileSavedEventDetail = {
  workspaceId?: string | number | null;
  path?: string | null;
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
  onFileOpen?: (filePath: string) => void;
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
    conflict: translate('status.conflict'),
  };
  return labels[status] || status;
}

function stepClassName(step: WorkflowStep, activeStep: WorkflowStep, done: boolean): string {
  if (done) return 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  if (step === activeStep) return 'border-primary bg-primary/10 text-primary';
  return 'border-border bg-background text-muted-foreground';
}

function normalizeFilePath(value: string | null | undefined): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+|\/+$/g, '');
}

function toRepoRelativeSavedPath(
  savedPath: string | null | undefined,
  repoRelativePath: string,
  workspacePath: string,
): string | null {
  const normalizedWorkspacePath = normalizeFilePath(workspacePath);
  const normalizedInputPath = normalizeFilePath(savedPath);
  const normalizedSavedPath = (() => {
    if (normalizedInputPath.startsWith('/workspace/')) {
      return normalizedInputPath.slice('/workspace/'.length);
    }
    if (normalizedWorkspacePath && normalizedInputPath.startsWith(`${normalizedWorkspacePath}/`)) {
      return normalizedInputPath.slice(normalizedWorkspacePath.length + 1);
    }
    return normalizedInputPath;
  })();
  const normalizedRepoPath = normalizeFilePath(repoRelativePath);
  if (!normalizedSavedPath) return null;
  if (!normalizedRepoPath) return normalizedSavedPath;
  if (normalizedSavedPath === normalizedRepoPath) return null;
  if (!normalizedSavedPath.startsWith(`${normalizedRepoPath}/`)) return null;
  return normalizedSavedPath.slice(normalizedRepoPath.length + 1);
}

export default function CodeHubPanel({ selectedProject, isReadOnly = false, onFileOpen }: CodeHubPanelProps) {
  const { t } = useTranslation('codehub');
  const workspaceId = selectedProject.workspaceId;
  const [repositories, setRepositories] = useState<CodeHubRepository[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [changes, setChanges] = useState<CodeHubChange[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState('');
  const [diff, setDiff] = useState('');
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [mrTargetBranches, setMrTargetBranches] = useState<string[]>([]);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDirectory, setCloneDirectory] = useState('');
  const [cloneBranch, setCloneBranch] = useState('');
  const [pullBranch, setPullBranch] = useState('');
  const [pullPreview, setPullPreview] = useState<PullPreview | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [sourceBranchMode, setSourceBranchMode] = useState<'new' | 'existing'>('new');
  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState('develop');
  const [mrSourceBranch, setMrSourceBranch] = useState('');
  const [mrTargetBranch, setMrTargetBranch] = useState('develop');
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
  const [mrCommitRecords, setMrCommitRecords] = useState<CommitRecord[]>([]);
  const [mrSourceSha, setMrSourceSha] = useState('');
  const [mrTargetSha, setMrTargetSha] = useState('');
  const [mrAnalysisKey, setMrAnalysisKey] = useState('');
  const [mrOptionsError, setMrOptionsError] = useState<string | null>(null);
  const [mrAnalysisError, setMrAnalysisError] = useState<string | null>(null);
  const [isMrAnalysisLoading, setIsMrAnalysisLoading] = useState(false);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [mrResult, setMrResult] = useState<MrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<CodeHubToast>(null);
  const [lastStash, setLastStash] = useState<StashRecord | null>(null);
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const initializedRepoIdRef = useRef<number | null>(null);
  const conflictStateRef = useRef<ConflictState | null>(null);
  const mrAnalysisRequestRef = useRef(0);
  const mrTargetBranchesRequestRef = useRef(0);

  const clearDiffPreview = useCallback(() => {
    setActiveFile('');
    setDiff('');
    setDiffDialogOpen(false);
  }, []);

  const showSuccessToast = useCallback((message: string) => {
    setToast({ message, type: 'success' });
  }, []);

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
  const mrSelectionKey = `${selectedRepoId || ''}:${mrSourceBranch}:${mrTargetRepository}:${mrTargetBranch}`;
  const existingMergeRequest = useMemo(
    () => activeMergeRequests.find((mr) => (
      mr.sourceBranch === mrSourceBranch
      && mr.targetBranch === mrTargetBranch
      && Number(mr.mrProjectId || 0) === Number(selectedMrProjectId || 0)
    )) || null,
    [activeMergeRequests, mrSourceBranch, mrTargetBranch, selectedMrProjectId],
  );
  const canOpenMrWorkflow = Boolean(selectedRepo?.projectId);
  const canCreateMr = Boolean(
    mrSourceSha
      && mrTargetSha
      && mrCommitRecords.length > 0
      && mrAnalysisKey === mrSelectionKey
      && !existingMergeRequest
      && !isMrAnalysisLoading
      && !mrOptionsError
      && !mrAnalysisError,
  );
  const canOpenPushStep = hasActiveCommitBatch;
  const canOpenMrStep = canOpenMrWorkflow;
  const canRestoreLastStash = Boolean(lastStash && !pullPreview && !conflictState);
  const pullPreviewRecommendation = useMemo(() => {
    if (!pullPreview) return null;
    const recommendation = pullPreview.recommendation || (pullPreview.dirty ? 'commit-first' : 'pull');
    if (recommendation === 'commit-first') return t('pull.recommendation.commitFirst');
    if (recommendation === 'resolve-conflicts') return t('pull.recommendation.resolveConflicts');
    if (recommendation === 'up-to-date') return t('pull.recommendation.upToDate');
    if (pullPreview.conflictCheckStatus === 'unknown') return t('pull.recommendation.unknown');
    return t('pull.recommendation.pull');
  }, [pullPreview, t]);
  const mrCommitMessage = useMemo(
    () => mrCommitRecords
      .map((commit) => commit.commitMessage || commit.commitSha)
      .filter(Boolean)
      .join('\n\n'),
    [mrCommitRecords],
  );

  const loadRepositories = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    setError(null);
    setNotice(null);
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
        if (response.status === 404) {
          setChanges([]);
          setSelectedFiles([]);
          clearDiffPreview();
          setError(t('errors.repositoryMissing'));
          await loadRepositories();
          return;
        }
        setError(await readError(response, t('errors.loadChanges')));
        return;
      }
      const payload = await response.json();
      const nextChanges = payload.files || [];
      setChanges(nextChanges);
      setActiveFile((current) => {
        if (!current || nextChanges.some((change: CodeHubChange) => change.path === current)) {
          return current;
        }
        setDiff('');
        setDiffDialogOpen(false);
        return '';
      });
      const conflictFiles = nextChanges
        .filter((change: CodeHubChange) => change.status === 'conflict')
        .map((change: CodeHubChange) => change.path);
      if (conflictFiles.length === 0 && conflictStateRef.current?.source === 'stash') {
        setLastStash(null);
      }
      setConflictState((current) => {
        if (conflictFiles.length === 0) return null;
        return {
          source: current?.source || 'pull',
          files: conflictFiles,
        };
      });
      setSelectedFiles((current) => current.filter((file) => nextChanges.some((change: CodeHubChange) => change.path === file)));
    } catch (caughtError) {
      console.error('[CodeHubPanel] Failed to load changes:', caughtError);
      setError(t('errors.loadChanges'));
    }
  }, [clearDiffPreview, loadRepositories, selectedRepoId, t, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !selectedRepoId || !selectedRepo || !conflictState) return undefined;

    const handleFileSaved = (event: Event) => {
      const detail = (event as CustomEvent<FileSavedEventDetail>).detail || {};
      if (detail.workspaceId && String(detail.workspaceId) !== String(workspaceId)) return;

      const repoFilePath = toRepoRelativeSavedPath(
        detail.path,
        selectedRepo.relativePath,
        selectedProject.fullPath || selectedProject.path || '',
      );
      if (!repoFilePath || !conflictState.files.includes(repoFilePath)) return;

      void (async () => {
        try {
          const response = await api.codehub.resolveConflictFile(workspaceId, selectedRepoId, {
            file: repoFilePath,
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            setError(payload.error || payload.message || t('errors.resolveConflictFileFailed'));
            return;
          }
          if (payload.resolved) {
            setNotice(t('pull.conflictState.fileResolved', { file: repoFilePath }));
          }
          await loadChanges();
        } catch (caughtError) {
          console.error('[CodeHubPanel] Failed to resolve conflict file after save:', caughtError);
          setError(t('errors.resolveConflictFileFailed'));
        }
      })();
    };

    window.addEventListener('cloudcli:file-saved', handleFileSaved);
    return () => window.removeEventListener('cloudcli:file-saved', handleFileSaved);
  }, [conflictState, loadChanges, selectedProject.fullPath, selectedProject.path, selectedRepo, selectedRepoId, t, workspaceId]);

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

  const loadMrTargetBranches = useCallback(async () => {
    const requestId = mrTargetBranchesRequestRef.current + 1;
    mrTargetBranchesRequestRef.current = requestId;
    if (!workspaceId || !selectedRepoId) return;
    setMrOptionsError(null);
    try {
      const response = await api.codehub.remoteBranches(workspaceId, selectedRepoId, mrTargetRepository);
      if (!response.ok) {
        const message = await readError(response, t('errors.loadRemoteBranches'));
        if (mrTargetBranchesRequestRef.current !== requestId) return;
        setMrTargetBranches([]);
        setMrOptionsError(message);
        return;
      }
      const payload = await response.json();
      if (mrTargetBranchesRequestRef.current !== requestId) return;
      const branches = payload.branches || [];
      setMrTargetBranches(branches);
      setMrTargetBranch((current) => {
        if (current && branches.includes(current)) return current;
        if (selectedRepo?.branch && branches.includes(selectedRepo.branch)) return selectedRepo.branch;
        if (branches.includes('develop')) return 'develop';
        if (branches.includes('main')) return 'main';
        return branches[0] || '';
      });
    } catch (caughtError) {
      if (mrTargetBranchesRequestRef.current !== requestId) return;
      console.warn('[CodeHubPanel] Failed to load MR target branches:', caughtError);
      setMrTargetBranches([]);
      setMrOptionsError(t('errors.loadRemoteBranches'));
    }
  }, [mrTargetRepository, selectedRepo?.branch, selectedRepoId, t, workspaceId]);

  const loadSubmissionCommits = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    try {
      const response = await api.codehub.submissionCommits(
        workspaceId,
        selectedRepoId,
        targetBranch,
        'personal',
      );
      if (!response.ok) return;
      const payload = await response.json();
      const commits = payload.commits || [];
      const branchesAtHead = payload.remoteBranchesAtHead || [];
      setCommitRecords(commits);
      setHeadSha(payload.headSha || '');
      setRemoteBranchesAtHead(branchesAtHead);
      setSourceBranch((current) => {
        if (current) return current;
        if (branchesAtHead[0]) return branchesAtHead[0];
        return payload.currentBranch || '';
      });
    } catch (caughtError) {
      console.warn('[CodeHubPanel] Failed to load submission commits:', caughtError);
    }
  }, [selectedRepoId, targetBranch, workspaceId]);

  const loadMrAnalysis = useCallback(async () => {
    const requestId = mrAnalysisRequestRef.current + 1;
    mrAnalysisRequestRef.current = requestId;
    if (
      !workspaceId
      || !selectedRepoId
      || !mrSourceBranch
      || !mrTargetBranch
      || !remoteBranches.includes(mrSourceBranch)
      || !mrTargetBranches.includes(mrTargetBranch)
    ) {
      setMrCommitRecords([]);
      setMrSourceSha('');
      setMrTargetSha('');
      setMrAnalysisKey('');
      setActiveMergeRequests([]);
      setMrAnalysisError(null);
      setIsMrAnalysisLoading(false);
      return;
    }

    setIsMrAnalysisLoading(true);
    setMrAnalysisKey('');
    setMrAnalysisError(null);
    try {
      const response = await api.codehub.submissionCommits(
        workspaceId,
        selectedRepoId,
        mrTargetBranch,
        mrTargetRepository,
        mrSourceBranch,
      );
      if (!response.ok) {
        const message = await readError(response, t('errors.loadMrAnalysis'));
        if (mrAnalysisRequestRef.current !== requestId) return;
        setMrCommitRecords([]);
        setMrSourceSha('');
        setMrTargetSha('');
        setMrAnalysisKey('');
        setActiveMergeRequests([]);
        setMrAnalysisError(message);
        return;
      }
      const payload = await response.json();
      if (mrAnalysisRequestRef.current !== requestId) return;
      setMrCommitRecords(payload.commits || []);
      setMrSourceSha(payload.sourceSha || payload.headSha || '');
      setMrTargetSha(payload.targetSha || '');
      setMrAnalysisKey(`${selectedRepoId}:${mrSourceBranch}:${mrTargetRepository}:${mrTargetBranch}`);
      setActiveMergeRequests(payload.activeMergeRequests || []);
    } catch (caughtError) {
      if (mrAnalysisRequestRef.current !== requestId) return;
      console.warn('[CodeHubPanel] Failed to analyze merge request:', caughtError);
      setMrCommitRecords([]);
      setMrSourceSha('');
      setMrTargetSha('');
      setMrAnalysisKey('');
      setActiveMergeRequests([]);
      setMrAnalysisError(t('errors.loadMrAnalysis'));
    } finally {
      if (mrAnalysisRequestRef.current === requestId) {
        setIsMrAnalysisLoading(false);
      }
    }
  }, [mrSourceBranch, mrTargetBranch, mrTargetBranches, mrTargetRepository, remoteBranches, selectedRepoId, t, workspaceId]);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  useEffect(() => {
    return subscribeProjectFilesChanged((event) => {
      if (event.reason !== 'delete') return;
      if (event.workspaceId && String(event.workspaceId) !== String(workspaceId)) return;
      void loadRepositories();
    });
  }, [loadRepositories, workspaceId]);

  useEffect(() => {
    conflictStateRef.current = conflictState;
  }, [conflictState]);

  useEffect(() => {
    if (!toast) return undefined;

    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    void loadSubmissionCommits();
  }, [loadSubmissionCommits]);

  useEffect(() => {
    if (!workflowOpen || workflowStep !== 'mr') return;
    void loadRemoteBranches();
    void loadMrTargetBranches();
  }, [loadMrTargetBranches, loadRemoteBranches, workflowOpen, workflowStep]);

  useEffect(() => {
    if (!workflowOpen || workflowStep !== 'mr' || remoteBranches.length === 0) return;
    setMrSourceBranch((current) => {
      if (current && remoteBranches.includes(current)) return current;
      if (pushResult?.branch && remoteBranches.includes(pushResult.branch)) return pushResult.branch;
      if (selectedRepo?.branch && remoteBranches.includes(selectedRepo.branch)) return selectedRepo.branch;
      return remoteBranches[0];
    });
  }, [pushResult?.branch, remoteBranches, selectedRepo?.branch, workflowOpen, workflowStep]);

  useEffect(() => {
    if (!workflowOpen || workflowStep !== 'mr') return;
    void loadMrAnalysis();
  }, [loadMrAnalysis, workflowOpen, workflowStep]);

  useEffect(() => {
    if (!selectedRepo) {
      initializedRepoIdRef.current = null;
      return;
    }
    const repoChanged = initializedRepoIdRef.current !== selectedRepo.repoId;
    initializedRepoIdRef.current = selectedRepo.repoId;
    if (!repoChanged) return;
    mrAnalysisRequestRef.current += 1;
    mrTargetBranchesRequestRef.current += 1;

    setPullBranch(selectedRepo.branch || 'develop');
    setSourceBranch(selectedRepo.branch || '');
    setTargetBranch(selectedRepo.branch || 'develop');
    setMrSourceBranch('');
    setMrTargetBranch(selectedRepo.branch || 'develop');
    setMrTargetRepository('personal');
    setPullPreview(null);
    setWorkflowOpen(false);
    setCommitRecords([]);
    setHeadSha('');
    setRemoteBranchesAtHead([]);
    setMrTargetBranches([]);
    setActiveMergeRequests([]);
    setMrCommitRecords([]);
    setMrSourceSha('');
    setMrTargetSha('');
    setMrAnalysisKey('');
    setMrOptionsError(null);
    setMrAnalysisError(null);
    setPushResult(null);
    setMrResult(null);
    setLastStash(null);
    setConflictState(null);
    clearDiffPreview();
    void loadChanges();
    void loadRemoteBranches();
  }, [clearDiffPreview, loadChanges, loadRemoteBranches, selectedRepo]);

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

  const toProjectRelativePath = useCallback((repoFilePath: string) => {
    const repoRoot = String(selectedRepo?.relativePath || '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+|\/+$/g, '');
    const filePath = String(repoFilePath || '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, '')
      .replace(/^\/+/g, '');

    return repoRoot ? `${repoRoot}/${filePath}` : filePath;
  }, [selectedRepo?.relativePath]);

  const openRepositoryFile = useCallback((filePath: string) => {
    setActiveFile(filePath);
    if (onFileOpen) {
      onFileOpen(toProjectRelativePath(filePath));
      return;
    }
    void openDiff(filePath);
  }, [onFileOpen, openDiff, toProjectRelativePath]);

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
    setMrResult(null);
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
    clearDiffPreview();
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
      showSuccessToast(t('toast.cloneSuccess', { name: directoryName }));
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, cloneBranch, cloneDirectory, cloneUrl, isReadOnly, loadRepositories, showSuccessToast, t, workspaceId]);

  const previewPull = useCallback(async () => {
    if (!workspaceId || !selectedRepoId) return;
    setIsWorking(true);
    setError(null);
    setNotice(null);
    clearDiffPreview();
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
  }, [clearDiffPreview, loadChanges, pullBranch, selectedRepoId, t, workspaceId]);

  const pullRepository = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly) return;
    setIsWorking(true);
    setError(null);
    setNotice(null);
    clearDiffPreview();
    try {
      const response = await api.codehub.pull(workspaceId, selectedRepoId, { branch: pullBranch });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.pullFailed'));
        return;
      }
      if (payload.localChangesBlockPull) {
        setError(t('errors.pullLocalChangesWouldBeOverwritten', {
          files: (payload.changedFiles || []).length > 0
            ? (payload.changedFiles || []).join(', ')
            : t('pull.conflictFilesUnknown'),
        }));
        await loadChanges();
        return;
      }
      if (payload.conflict) {
        const files = payload.conflictFiles || [];
        setConflictState({ source: 'pull', files });
        setError(null);
        setNotice(t('pull.conflictState.pullNotice'));
        await loadRepositories();
        await loadChanges();
        return;
      }
      setPullPreview(null);
      setConflictState(null);
      await loadRepositories();
      await loadChanges();
      showSuccessToast(t('toast.pullSuccess', { branch: payload.branch || pullBranch || selectedRepo?.branch || '-' }));
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, isReadOnly, loadChanges, loadRepositories, pullBranch, selectedRepo?.branch, selectedRepoId, showSuccessToast, t, workspaceId]);

  const stashLocalChanges = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly) return;
    setIsWorking(true);
    setError(null);
    setNotice(null);
    setConflictState(null);
    clearDiffPreview();
    try {
      const response = await api.codehub.stashLocalChanges(workspaceId, selectedRepoId, {
        message: `CodeHub pull preview ${new Date().toISOString()}`,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.stashLocalChangesFailed'));
        return;
      }
      if (payload.stashed && payload.stashRef) {
        setLastStash({
          stashRef: payload.stashRef,
          stashSha: payload.stashSha,
          stashSubject: payload.stashSubject,
        });
      }
      if (!payload.stashed) {
        setNotice(t('pull.options.stashNoChanges'));
        await loadRepositories();
        await loadChanges();
        return;
      }

      const pullResponse = await api.codehub.pull(workspaceId, selectedRepoId, { branch: pullBranch });
      const pullPayload = await pullResponse.json().catch(() => ({}));
      if (!pullResponse.ok) {
        setError(pullPayload.error || pullPayload.message || t('errors.pullFailed'));
        await loadRepositories();
        await loadChanges();
        return;
      }
      if (pullPayload.localChangesBlockPull) {
        setError(t('errors.pullLocalChangesWouldBeOverwritten', {
          files: (pullPayload.changedFiles || []).length > 0
            ? (pullPayload.changedFiles || []).join(', ')
            : t('pull.conflictFilesUnknown'),
        }));
        await loadRepositories();
        await loadChanges();
        return;
      }
      if (pullPayload.conflict) {
        const files = pullPayload.conflictFiles || [];
        setPullPreview(null);
        setConflictState({ source: 'pull', files });
        setNotice(t('pull.conflictState.pullNotice'));
        await loadRepositories();
        await loadChanges();
        return;
      }

      setPullPreview(null);
      setConflictState(null);
      setNotice(t('pull.options.stashAndPullSuccess', {
        ref: payload.stashRef || t('pull.options.stashFallbackRef'),
        branch: pullPayload.branch || pullBranch || selectedRepo?.branch || '-',
      }));
      await loadRepositories();
      await loadChanges();
      showSuccessToast(t('toast.pullSuccess', { branch: pullPayload.branch || pullBranch || selectedRepo?.branch || '-' }));
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, isReadOnly, loadChanges, loadRepositories, pullBranch, selectedRepo?.branch, selectedRepoId, showSuccessToast, t, workspaceId]);

  const restoreLastStash = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly || !lastStash?.stashRef) return;
    setIsWorking(true);
    setError(null);
    setNotice(null);
    clearDiffPreview();
    try {
      const response = await api.codehub.restoreStash(workspaceId, selectedRepoId, {
        stashRef: lastStash.stashRef,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.restoreStashFailed'));
        return;
      }
      if (payload.conflict) {
        const files = payload.conflictFiles || [];
        setConflictState({ source: 'stash', files });
        setError(null);
        setNotice(t('pull.conflictState.stashNotice'));
        await loadRepositories();
        await loadChanges();
        return;
      }
      setLastStash(null);
      setConflictState(null);
      setPullPreview(null);
      setNotice(t('pull.restore.success', { ref: lastStash.stashRef }));
      await loadRepositories();
      await loadChanges();
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, isReadOnly, lastStash, loadChanges, loadRepositories, selectedRepoId, t, workspaceId]);

  const clearLocalChanges = useCallback(async () => {
    if (!workspaceId || !selectedRepoId || isReadOnly || !pullPreview) return;
    const files = pullPreview.changedFiles || [];
    if (files.length === 0) {
      setError(t('errors.clearLocalChangesNoFiles'));
      return;
    }
    if (!window.confirm(t('pull.options.clearConfirm', { files: files.join(', ') }))) {
      return;
    }
    setIsWorking(true);
    setError(null);
    setNotice(null);
    setConflictState(null);
    clearDiffPreview();
    try {
      const response = await api.codehub.clearLocalChanges(workspaceId, selectedRepoId, { files });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || payload.message || t('errors.clearLocalChangesFailed'));
        return;
      }
      setNotice(payload.cleared
        ? t('pull.options.clearSuccess', { count: (payload.files || []).length })
        : t('pull.options.clearNoChanges'));
      await loadRepositories();
      await loadChanges();
      await previewPull();
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, isReadOnly, loadChanges, loadRepositories, previewPull, pullPreview, selectedRepoId, t, workspaceId]);

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
      clearDiffPreview();
      if (payload.commitSha) {
        setCommitRecords((current) => {
          if (current.some((commit) => commit.commitSha === payload.commitSha)) {
            return current;
          }
          return [
            ...current,
            {
              commitSha: payload.commitSha,
              commitMessage: payload.commitMessage || commitMessage,
              committedAt: new Date().toISOString(),
              additions: payload.additions,
              deletions: payload.deletions,
              filesChanged: payload.filesChanged,
            },
          ];
        });
        setHeadSha(payload.commitSha);
      }
      setWorkflowStep('push');
      await loadRepositories();
      await loadChanges();
      await loadRemoteBranches();
      await loadSubmissionCommits();
    } finally {
      setIsWorking(false);
    }
  }, [clearDiffPreview, commitMessage, loadChanges, loadRemoteBranches, loadRepositories, loadSubmissionCommits, selectedFiles, selectedRepoId, t, workspaceId]);

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
      setMrSourceBranch(payload.branch || sourceBranch);
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
    if (!workspaceId || !selectedRepoId || !canCreateMr) return;
    setIsWorking(true);
    setDialogError(null);
    setMrResult(null);
    try {
      const mrDescription = mrCommitMessage || mrCommitRecords.map((commit) => commit.commitSha).join('\n');
      const response = await api.codehub.createMergeRequest(workspaceId, selectedRepoId, {
        commitMessage: mrDescription,
        sourceBranch: mrSourceBranch,
        targetBranch: mrTargetBranch,
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
      clearDiffPreview();
      await loadRepositories();
      await loadChanges();
      await loadRemoteBranches();
      await loadSubmissionCommits();
      await loadMrAnalysis();
    } finally {
      setIsWorking(false);
    }
  }, [
    canCreateMr,
    clearDiffPreview,
    loadChanges,
    loadMrAnalysis,
    loadRemoteBranches,
    loadRepositories,
    loadSubmissionCommits,
    mrTargetRepository,
    mrCommitMessage,
    mrCommitRecords,
    mrSourceBranch,
    mrTargetBranch,
    mrTitle,
    selectedRepoId,
    t,
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
    <div className="relative flex h-full flex-col bg-background">
      {toast ? (
        <div
          className="animate-in slide-in-from-bottom-2 pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[min(360px,calc(100vw-2rem))] items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white shadow-lg"
          role="status"
          aria-live="polite"
        >
          <Check className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">{toast.message}</span>
        </div>
      ) : null}
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
                  onClick={() => {
                    clearDiffPreview();
                    setSelectedRepoId(repo.repoId);
                  }}
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
                          clearDiffPreview();
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
                  </div>
                </div>
                {pullPreview ? (
                  <div className={`mt-4 overflow-hidden rounded-md border text-xs ${
                    pullPreview.hasConflicts
                      ? 'border-amber-500/30 bg-amber-500/[0.06]'
                      : 'border-border bg-muted/30'
                  }`}
                  >
                    <div className={`flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 ${
                      pullPreview.hasConflicts ? 'border-amber-500/20' : 'border-border'
                    }`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">{t('pull.previewResult')}</div>
                        <div className="mt-1 text-muted-foreground">
                          {t('pull.summary', {
                            branch: pullPreview.branch || '-',
                            remote: pullPreview.remote || 'origin',
                            remoteBranch: pullPreview.remoteBranch || pullBranch || '-',
                            ahead: pullPreview.ahead || 0,
                            behind: pullPreview.behind || 0,
                          })}
                        </div>
                      </div>
                      <div className={`rounded-full px-2.5 py-1 font-medium ${
                        pullPreview.hasConflicts
                          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
                          : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      }`}
                      >
                        {pullPreview.hasConflicts ? t('pull.previewNeedsAction') : t('pull.previewReady')}
                      </div>
                    </div>

                    <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                      <div className={`min-w-0 px-4 py-3 ${pullPreview.hasConflicts ? 'lg:border-r lg:border-amber-500/20' : 'lg:border-r lg:border-border'}`}>
                        <div className="text-xs font-medium text-foreground">{t('pull.recommendationTitle')}</div>
                        <div className="mt-1 text-muted-foreground">{pullPreviewRecommendation}</div>
                      </div>
                      <div className="min-w-0 px-4 py-3">
                        <div className="text-xs font-medium text-foreground">{t('pull.localStateTitle')}</div>
                        <div className="mt-1 break-words text-muted-foreground">
                          {pullPreview.dirty ? (
                            <span>
                              {t('pull.localChanges', {
                                files: (pullPreview.changedFiles || []).length > 0
                                  ? (pullPreview.changedFiles || []).join(', ')
                                  : t('pull.localChangesUnknown'),
                              })}
                            </span>
                          ) : (
                            <span>{t('pull.clean')}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {pullPreview.hasConflicts ? (
                      <div className="border-t border-amber-500/20 px-4 py-3">
                        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{t('pull.conflictsTitle')}</div>
                            <div className="mt-1 break-words text-muted-foreground">
                              {t('pull.conflictFiles', {
                                files: (pullPreview.conflictFiles || []).length > 0
                                  ? (pullPreview.conflictFiles || []).join(', ')
                                  : t('pull.conflictFilesUnknown'),
                              })}
                            </div>
                          </div>
                          <div className="text-xs font-medium text-muted-foreground">{t('pull.optionsTitle')}</div>
                        </div>
                        <div className="grid gap-3 lg:grid-cols-3">
                          <div className="flex min-h-[140px] flex-col rounded-md border border-border/70 bg-background p-3 shadow-sm">
                            <div className="font-medium text-foreground">{t('pull.options.commitFirstTitle')}</div>
                            <div className="mt-1 flex-1 text-muted-foreground">{t('pull.options.commitFirstDescription')}</div>
                            <Button className="mt-3 w-full" variant="outline" size="sm" onClick={openCommitForPullPreview} disabled={isReadOnly || isWorking}>
                              {t('pull.options.commitFirstButton')}
                            </Button>
                          </div>
                          <div className="flex min-h-[140px] flex-col rounded-md border border-border/70 bg-background p-3 shadow-sm">
                            <div className="font-medium text-foreground">{t('pull.options.stashTitle')}</div>
                            <div className="mt-1 flex-1 text-muted-foreground">{t('pull.options.stashDescription')}</div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                              <Button className="w-full" variant="outline" size="sm" onClick={() => void stashLocalChanges()} disabled={isReadOnly || isWorking || !pullPreview.dirty}>
                                {t('pull.options.stashButton')}
                              </Button>
                              <Button className="w-full" variant="outline" size="sm" onClick={() => void clearLocalChanges()} disabled={isReadOnly || isWorking || !pullPreview.dirty}>
                                {t('pull.options.clearButton')}
                              </Button>
                            </div>
                          </div>
                          {pullPreview.localChangesBlockPull ? (
                            <div className="min-h-[140px] rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                              <div className="font-medium text-foreground">{t('pull.options.manualBlockedTitle')}</div>
                              <div className="mt-1 text-muted-foreground">{t('pull.options.manualBlockedDescription')}</div>
                            </div>
                          ) : (
                            <div className="flex min-h-[140px] flex-col rounded-md border border-border/70 bg-background p-3 shadow-sm">
                              <div className="font-medium text-foreground">{t('pull.options.manualTitle')}</div>
                              <div className="mt-1 flex-1 text-muted-foreground">{t('pull.options.manualDescription')}</div>
                              <Button
                                className="mt-3 w-full"
                                variant="outline"
                                size="sm"
                                onClick={() => void pullRepository()}
                                disabled={isReadOnly || isWorking}
                              >
                                {t('pull.options.manualButton')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {lastStash ? (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs text-sky-800 dark:text-sky-200">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">
                        {t('pull.restore.title', { ref: lastStash.stashRef })}
                      </div>
                      <div className="mt-1">
                        {conflictState
                          ? t('pull.restore.waitForConflict')
                          : canRestoreLastStash ? t('pull.restore.description') : t('pull.restore.waitForPull')}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void restoreLastStash()}
                      disabled={isReadOnly || isWorking || !canRestoreLastStash}
                    >
                      {t('pull.restore.button')}
                    </Button>
                  </div>
                ) : null}
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
                      disabled={isReadOnly || isWorking || !canOpenMrWorkflow}
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

              {conflictState ? (
                <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">{t('pull.conflictState.title')}</div>
                      <div className="mt-1 text-xs">
                        {conflictState.source === 'stash'
                          ? t('pull.conflictState.stashDescription')
                          : t('pull.conflictState.pullDescription')}
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => void loadChanges()} disabled={isWorking}>
                      <RefreshCw className="h-4 w-4" />
                      {t('pull.conflictState.refresh')}
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {conflictState.files.length > 0 ? conflictState.files.map((file) => (
                      <Button
                        key={file}
                        variant="outline"
                        size="sm"
                        className="max-w-full justify-start"
                        onClick={() => openRepositoryFile(file)}
                      >
                        <span className="truncate">{file}</span>
                      </Button>
                    )) : (
                      <span className="text-xs">{t('pull.conflictFilesUnknown')}</span>
                    )}
                  </div>
                  <div className="mt-3 text-xs">{t('pull.conflictState.resolveHint')}</div>
                </section>
              ) : null}

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
                        } ${change.status === 'conflict' ? 'border border-amber-500/30 bg-amber-500/10' : ''}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
                          checked={selectedFiles.includes(change.path)}
                          onChange={(event) => toggleFile(change.path, event.target.checked)}
                        />
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => {
                            if (change.status === 'conflict') {
                              openRepositoryFile(change.path);
                              return;
                            }
                            void openDiff(change.path);
                          }}
                        >
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
          {notice ? (
            <div className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              {notice}
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
              <button
                type="button"
                className={`rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted/50 ${stepClassName('commit', workflowStep, commitRecords.length > 0)}`}
                onClick={() => setWorkflowStep('commit')}
              >
                {t('workflow.steps.commit')}
              </button>
              <button
                type="button"
                className={`rounded-md border px-3 py-2 text-left text-sm transition enabled:hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60 ${stepClassName('push', workflowStep, sourceBranchPushedAtHead)}`}
                onClick={() => setWorkflowStep('push')}
                disabled={!canOpenPushStep}
              >
                {t('workflow.steps.push')}
              </button>
              <button
                type="button"
                className={`rounded-md border px-3 py-2 text-left text-sm transition enabled:hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60 ${stepClassName('mr', workflowStep, Boolean(mrResult?.success))}`}
                onClick={() => setWorkflowStep('mr')}
                disabled={!canOpenMrStep}
              >
                {t('workflow.steps.mr')}
              </button>
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
                    value={mrSourceBranch}
                    onChange={(event) => {
                      setMrSourceBranch(event.target.value);
                      setMrResult(null);
                      setDialogError(null);
                    }}
                    disabled={isWorking || remoteBranches.length === 0}
                  >
                    <option value="">{t('workflow.selectSourceBranch')}</option>
                    {remoteBranches.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">{t('workflow.mergeTargetRepository')}</div>
                  <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-1">
                    <Button
                      variant={mrTargetRepository === 'personal' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        if (mrTargetRepository === 'personal') return;
                        setMrTargetBranches([]);
                        setMrTargetRepository('personal');
                        setMrResult(null);
                        setDialogError(null);
                      }}
                      disabled={isWorking}
                    >
                      {t('workflow.personalRepo')}
                    </Button>
                    <Button
                      variant={mrTargetRepository === 'upstream' ? 'default' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        if (mrTargetRepository === 'upstream') return;
                        setMrTargetBranches([]);
                        setMrTargetRepository('upstream');
                        setMrResult(null);
                        setDialogError(null);
                      }}
                      disabled={isWorking || !selectedRepo?.publicProjectId || !selectedRepo?.publicRepositoryUrl}
                      title={selectedRepo?.publicProjectId && selectedRepo?.publicRepositoryUrl ? t('workflow.upstreamRepoTitle') : t('workflow.noUpstreamRepoTitle')}
                    >
                      {t('workflow.upstreamRepo')}
                    </Button>
                  </div>
                </div>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">{t('workflow.targetBranch')}</span>
                  <select
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm"
                    value={mrTargetBranch}
                    onChange={(event) => {
                      setMrTargetBranch(event.target.value);
                      setMrResult(null);
                      setDialogError(null);
                    }}
                    disabled={isWorking || mrTargetBranches.length === 0}
                  >
                    <option value="">{t('workflow.selectTargetBranch')}</option>
                    {mrTargetBranches.map((branch) => (
                      <option key={branch} value={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
                <Input value={mrTitle} onChange={(event) => setMrTitle(event.target.value)} placeholder={t('workflow.mrTitlePlaceholder')} />
                <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {isMrAnalysisLoading
                    ? t('workflow.analyzingMr')
                    : t('workflow.mrDescriptionMessage', {
                      sourceBranch: mrSourceBranch || '-',
                      targetBranch: mrTargetBranch || '-',
                      count: mrCommitRecords.length,
                    })}
                </div>
                {mrOptionsError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {mrOptionsError}
                  </div>
                ) : null}
                {mrAnalysisError ? (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                    {mrAnalysisError}
                  </div>
                ) : null}
                {!isMrAnalysisLoading
                  && !mrAnalysisError
                  && remoteBranches.includes(mrSourceBranch)
                  && mrTargetBranches.includes(mrTargetBranch)
                  && mrCommitRecords.length === 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    {t('workflow.noMrCommits')}
                  </div>
                ) : null}
                {mrCommitRecords.length > 0 ? (
                  <div className="max-h-28 overflow-y-auto rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                    {mrCommitRecords.map((commit) => (
                      <div key={commit.commitSha} className="flex min-w-0 items-center justify-between gap-3 py-0.5">
                        <span className="min-w-0 truncate">{commit.commitMessage?.split(/\r?\n/)[0] || commit.commitSha}</span>
                        <span className="shrink-0 font-mono">{commit.commitSha.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
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
