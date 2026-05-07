import {
  AlertCircle,
  CheckCircle2,
  Github,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';

import { useWorkspaceSkills } from './hooks/useWorkspaceSkills';
import {
  filterWorkspaceSkills,
  getSkillDisplayName,
  getSkillKindLabelKey,
  getSkillStatusLabelKey,
  sortWorkspaceSkills,
  type WorkspaceSkill,
} from './utils/skillFormatting';

type SkillsPanelProps = {
  selectedProject: Project;
  isReadOnly: boolean;
};

type InstallMode = 'github' | 'local';

type SkillInstallPreview = {
  previewId: string;
  name: string;
  displayName?: string;
  description?: string;
  files?: string[];
  sourceType: string;
  sourceUrl?: string;
  sourceFileName?: string;
  resolvedCommit?: string;
  sourceSubdir?: string;
  conflict?: {
    type: string;
    blocking?: boolean;
  };
};

export default function SkillsPanel({ selectedProject, isReadOnly }: SkillsPanelProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode | null>(null);
  const [githubUrl, setGithubUrl] = useState('');
  const [localArchive, setLocalArchive] = useState<File | null>(null);
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const { data, error, isLoading, reload } = useWorkspaceSkills(selectedProject.workspaceId);
  const skills = useMemo(
    () => filterWorkspaceSkills(sortWorkspaceSkills(data?.skills ?? []), query),
    [data?.skills, query],
  );
  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.name === selectedSkillName) ?? null,
    [selectedSkillName, skills],
  );
  const canManage = !isReadOnly && data?.canManage !== false;

  const resetInstallState = () => {
    setGithubUrl('');
    setLocalArchive(null);
    setPreview(null);
    setInstallError(null);
    setIsPreviewing(false);
    setIsInstalling(false);
    setEnableOnInstall(true);
  };

  const openInstallModal = (mode: InstallMode) => {
    resetInstallState();
    setInstallMode(mode);
  };

  const closeInstallModal = () => {
    setInstallMode(null);
    resetInstallState();
  };

  const handlePreviewInstall = async () => {
    if (!installMode || !selectedProject.workspaceId) return;

    setInstallError(null);
    setPreview(null);
    setIsPreviewing(true);
    try {
      const response = installMode === 'github'
        ? await api.workspaceSkills.previewGithub(selectedProject.workspaceId, githubUrl)
        : await previewLocalArchive(selectedProject.workspaceId, localArchive);
      const payload = await readApiPayload(response, t('skillsMarket.installModal.previewFailed'));
      setPreview(payload.preview);
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : t('skillsMarket.installModal.previewFailed'));
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleInstallPreview = async () => {
    if (!preview || !selectedProject.workspaceId) return;

    setInstallError(null);
    setIsInstalling(true);
    try {
      await readApiPayload(
        await api.workspaceSkills.installPreview(selectedProject.workspaceId, {
          previewId: preview.previewId,
          enable: enableOnInstall,
        }),
        t('skillsMarket.installModal.installFailed'),
      );
      await reload();
      setSelectedSkillName(preview.name);
      closeInstallModal();
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : t('skillsMarket.installModal.installFailed'));
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">{t('skillsMarket.title')}</h1>
            <p className="mt-1 truncate text-sm text-muted-foreground">{selectedProject.displayName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canManage}
              onClick={() => openInstallModal('local')}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
              {t('skillsMarket.uploadSkill')}
            </button>
            <button
              type="button"
              disabled={!canManage}
              onClick={() => openInstallModal('github')}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PackagePlus className="h-4 w-4" />
              {t('skillsMarket.installFromGitHub')}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-px border-b border-border bg-border md:grid-cols-3">
        <SummaryItem label={t('skillsMarket.summary.total')} value={String(data?.summary.total ?? 0)} />
        <SummaryItem label={t('skillsMarket.summary.managed')} value={String(data?.summary.managed ?? 0)} />
        <SummaryItem label={t('skillsMarket.summary.invalid')} value={String(data?.summary.invalid ?? 0)} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t('skillsMarket.searchPlaceholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>
            <span className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {t('skillsMarket.filters.workspace')}
            </span>
          </div>

          <SkillsList
            error={error}
            isLoading={isLoading}
            onReload={reload}
            onSelect={setSelectedSkillName}
            query={query}
            selectedSkillName={selectedSkillName}
            skills={skills}
          />
        </div>

        <aside className="hidden w-[360px] min-w-[320px] flex-col bg-muted/30 lg:flex">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-foreground">{t('skillsMarket.detailTitle')}</h2>
          </div>
          <SkillDetail skill={selectedSkill} />
        </aside>
      </div>

      {installMode ? (
        <InstallSkillModal
          enableOnInstall={enableOnInstall}
          error={installError}
          githubUrl={githubUrl}
          isInstalling={isInstalling}
          isPreviewing={isPreviewing}
          localArchive={localArchive}
          mode={installMode}
          onClose={closeInstallModal}
          onEnableChange={setEnableOnInstall}
          onGithubUrlChange={(value) => {
            setGithubUrl(value);
            setPreview(null);
            setInstallError(null);
          }}
          onInstall={handleInstallPreview}
          onLocalArchiveChange={(file) => {
            setLocalArchive(file);
            setPreview(null);
            setInstallError(null);
          }}
          onModeChange={(mode) => {
            setInstallMode(mode);
            setPreview(null);
            setInstallError(null);
          }}
          onPreview={handlePreviewInstall}
          preview={preview}
        />
      ) : null}
    </section>
  );
}

function InstallSkillModal({
  enableOnInstall,
  error,
  githubUrl,
  isInstalling,
  isPreviewing,
  localArchive,
  mode,
  onClose,
  onEnableChange,
  onGithubUrlChange,
  onInstall,
  onLocalArchiveChange,
  onModeChange,
  onPreview,
  preview,
}: {
  enableOnInstall: boolean;
  error: string | null;
  githubUrl: string;
  isInstalling: boolean;
  isPreviewing: boolean;
  localArchive: File | null;
  mode: InstallMode;
  onClose: () => void;
  onEnableChange: (enabled: boolean) => void;
  onGithubUrlChange: (value: string) => void;
  onInstall: () => void;
  onLocalArchiveChange: (file: File | null) => void;
  onModeChange: (mode: InstallMode) => void;
  onPreview: () => void;
  preview: SkillInstallPreview | null;
}) {
  const { t } = useTranslation();
  const canPreview = mode === 'github' ? githubUrl.trim().length > 0 : Boolean(localArchive);
  const conflictBlocksInstall = preview?.conflict?.blocking === true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{t('skillsMarket.installModal.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('skillsMarket.installModal.description')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label={t('common.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="inline-flex rounded-md border border-border bg-muted p-1">
            <button
              type="button"
              onClick={() => onModeChange('github')}
              className={`inline-flex h-8 items-center gap-2 rounded px-3 text-sm font-medium transition ${
                mode === 'github' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Github className="h-4 w-4" />
              {t('skillsMarket.installModal.githubTab')}
            </button>
            <button
              type="button"
              onClick={() => onModeChange('local')}
              className={`inline-flex h-8 items-center gap-2 rounded px-3 text-sm font-medium transition ${
                mode === 'local' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Upload className="h-4 w-4" />
              {t('skillsMarket.installModal.localTab')}
            </button>
          </div>

          <div className="mt-4 grid gap-4">
            {mode === 'github' ? (
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">{t('skillsMarket.installModal.githubUrl')}</span>
                <input
                  type="url"
                  value={githubUrl}
                  onChange={(event) => onGithubUrlChange(event.target.value)}
                  placeholder="https://github.com/acme/skills/tree/main/my-skill"
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </label>
            ) : (
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">{t('skillsMarket.installModal.localArchive')}</span>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(event) => onLocalArchiveChange(event.target.files?.[0] ?? null)}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:h-9 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
                />
                {localArchive ? (
                  <span className="text-xs text-muted-foreground">{localArchive.name}</span>
                ) : null}
              </label>
            )}

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={enableOnInstall}
                onChange={(event) => onEnableChange(event.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              {t('skillsMarket.installModal.enableOnInstall')}
            </label>

            {error ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {preview ? <SkillPreviewCard preview={preview} /> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            disabled={!canPreview || isPreviewing || isInstalling}
            onClick={onPreview}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {t('skillsMarket.installModal.preview')}
          </button>
          <button
            type="button"
            disabled={!preview || conflictBlocksInstall || isInstalling || isPreviewing}
            onClick={onInstall}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isInstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {t('skillsMarket.installModal.install')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillPreviewCard({ preview }: { preview: SkillInstallPreview }) {
  const { t } = useTranslation();

  return (
    <div className="rounded-md border border-border bg-muted/40 p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{preview.displayName || preview.name}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{preview.description || preview.name}</p>
        </div>
        <span className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {preview.sourceType}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <DetailRow label={t('skillsMarket.detail.sourceType')} value={preview.sourceType} />
        {preview.sourceUrl ? <DetailRow label={t('skillsMarket.detail.sourceUrl')} value={preview.sourceUrl} /> : null}
        {preview.sourceFileName ? (
          <DetailRow label={t('skillsMarket.detail.sourceFileName')} value={preview.sourceFileName} />
        ) : null}
        {preview.resolvedCommit ? (
          <DetailRow label={t('skillsMarket.detail.resolvedCommit')} value={preview.resolvedCommit} />
        ) : null}
        {preview.sourceSubdir ? <DetailRow label={t('skillsMarket.detail.sourceSubdir')} value={preview.sourceSubdir} /> : null}
      </dl>

      {preview.conflict?.blocking ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t('skillsMarket.installModal.conflictBlocked', { type: preview.conflict.type })}
        </div>
      ) : preview.conflict?.type && preview.conflict.type !== 'none' ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t('skillsMarket.installModal.conflictWarning', { type: preview.conflict.type })}
        </div>
      ) : null}

      {preview.files?.length ? (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            {t('skillsMarket.installModal.files', { count: preview.files.length })}
          </div>
          <div className="mt-2 max-h-28 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
            {preview.files.slice(0, 40).map((file) => (
              <div key={file} className="truncate">{file}</div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkillsList({
  error,
  isLoading,
  onReload,
  onSelect,
  query,
  selectedSkillName,
  skills,
}: {
  error: string | null;
  isLoading: boolean;
  onReload: () => void;
  onSelect: (name: string) => void;
  query: string;
  selectedSkillName: string | null;
  skills: WorkspaceSkill[];
}) {
  const { t } = useTranslation();

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('skillsMarket.loading')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
          <h2 className="mt-3 text-sm font-semibold text-foreground">{t('skillsMarket.errorTitle')}</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('skillsMarket.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
          </div>
          <h2 className="mt-3 text-sm font-semibold text-foreground">
            {query ? t('skillsMarket.emptySearchTitle') : t('skillsMarket.emptyTitle')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {query ? t('skillsMarket.emptySearchDescription') : t('skillsMarket.emptyDescription')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <div className="grid gap-2">
        {skills.map((skill) => (
          <button
            key={`${skill.kind}:${skill.name}`}
            type="button"
            onClick={() => onSelect(skill.name)}
            className={`rounded-md border p-3 text-left transition ${
              selectedSkillName === skill.name
                ? 'border-primary bg-primary/5'
                : 'border-border bg-background hover:border-primary/40 hover:bg-accent/40'
            }`}
          >
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{getSkillDisplayName(skill)}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{skill.description || skill.name}</div>
              </div>
              <StatusBadge skill={skill} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t(getSkillKindLabelKey(skill))}
              </span>
              <span className="rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {skill.sourceType}
              </span>
              {skill.parseError ? (
                <span className="rounded-md border border-destructive/30 px-2 py-0.5 text-xs font-medium text-destructive">
                  {t('skillsMarket.parseError')}
                </span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function SkillDetail({ skill }: { skill: WorkspaceSkill | null }) {
  const { t } = useTranslation();

  if (!skill) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-[260px]">
          <AlertCircle className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('skillsMarket.detailEmpty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">{getSkillDisplayName(skill)}</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{skill.description || skill.name}</p>
          </div>
          <StatusBadge skill={skill} />
        </div>

        <dl className="mt-5 grid gap-3 text-sm">
          <DetailRow label={t('skillsMarket.detail.kind')} value={t(getSkillKindLabelKey(skill))} />
          <DetailRow label={t('skillsMarket.detail.status')} value={t(getSkillStatusLabelKey(skill))} />
          <DetailRow label={t('skillsMarket.detail.sourceType')} value={skill.sourceType} />
          {skill.sourceUrl ? <DetailRow label={t('skillsMarket.detail.sourceUrl')} value={skill.sourceUrl} /> : null}
          {skill.sourceFileName ? (
            <DetailRow label={t('skillsMarket.detail.sourceFileName')} value={skill.sourceFileName} />
          ) : null}
          {skill.resolvedCommit ? (
            <DetailRow label={t('skillsMarket.detail.resolvedCommit')} value={skill.resolvedCommit} />
          ) : null}
          {skill.sourceSubdir ? <DetailRow label={t('skillsMarket.detail.sourceSubdir')} value={skill.sourceSubdir} /> : null}
          {skill.runtimePath ? <DetailRow label={t('skillsMarket.detail.runtimePath')} value={skill.runtimePath} /> : null}
          {skill.sourcePath ? <DetailRow label={t('skillsMarket.detail.sourcePath')} value={skill.sourcePath} /> : null}
          {skill.parseError ? <DetailRow label={t('skillsMarket.detail.parseError')} value={skill.parseError} danger /> : null}
        </dl>
      </div>
    </div>
  );
}

function previewLocalArchive(workspaceId: number, archive: File | null) {
  if (!archive) {
    throw new Error('Skill archive is required.');
  }

  const formData = new FormData();
  formData.append('archive', archive);
  return api.workspaceSkills.uploadLocal(workspaceId, formData);
}

async function readApiPayload(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
}

function StatusBadge({ skill }: { skill: WorkspaceSkill }) {
  const { t } = useTranslation();
  const tone =
    skill.status === 'enabled'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : skill.status === 'invalid'
        ? 'border-destructive/30 bg-destructive/10 text-destructive'
        : 'border-border bg-muted text-muted-foreground';

  return (
    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {t(getSkillStatusLabelKey(skill))}
    </span>
  );
}

function DetailRow({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words ${danger ? 'text-destructive' : 'text-foreground'}`}>{value}</dd>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background px-6 py-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  );
}
