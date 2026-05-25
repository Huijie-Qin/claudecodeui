import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Folder,
  Loader2,
  PackagePlus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { dispatchProjectFilesChanged } from '../file-tree/utils/fileTreeEvents';

type SkillMarketDialogProps = {
  open: boolean;
  selectedProject: Project;
  isReadOnly: boolean;
  onClose: () => void;
};

type MarketSkillSummary = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  description?: string;
  nspPath?: string;
  createUserId?: string;
  version?: number;
  importedVersion?: number;
  fileCount?: number;
  imported?: boolean;
  runtimeExists?: boolean;
  conflict?: boolean;
  updateAvailable?: boolean;
  canPublish?: boolean;
  importedAt?: string;
  updatedAt?: string;
};

type MarketSkillFile = {
  path: string;
  content?: string;
  size?: number;
};

type MarketSkillDetail = MarketSkillSummary & {
  targetPath?: string;
  files: MarketSkillFile[];
};

type DirectoryRow = {
  id: string;
  label: string;
  depth: number;
  type: 'directory' | 'file';
  filePath?: string;
};

export default function SkillMarketDialog({
  open,
  selectedProject,
  isReadOnly,
  onClose,
}: SkillMarketDialogProps) {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<MarketSkillSummary[]>([]);
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketSkillDetail | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [canManage, setCanManage] = useState(!isReadOnly);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removeTargetName, setRemoveTargetName] = useState<string | null>(null);

  const workspaceId = selectedProject.workspaceId;
  const visibleSkills = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => [
      skill.name,
      skill.displayName,
      skill.description,
      skill.createUserId,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery));
  }, [query, skills]);
  const directoryRows = useMemo(() => createDirectoryRows(detail?.files ?? []), [detail?.files]);
  const selectedDisplayName = detail?.displayName || detail?.name || '';
  const canWrite = canManage && !isReadOnly && Boolean(workspaceId);

  const loadSkills = useCallback(async (searchContent = '') => {
    if (!workspaceId) {
      setError(t('skillMarketDialog.workspaceUnavailable', 'Current workspace does not support Skill Market.'));
      return;
    }

    setListLoading(true);
    setError(null);
    try {
      const payload = await readApiPayload(
        await api.skillMarket.list(workspaceId, { searchContent }),
        t('skillMarketDialog.loadFailed', 'Failed to load Skill Market.'),
      );
      const nextSkills = payload.skills ?? [];
      setCanManage(payload.canManage !== false);
      setSkills(nextSkills);
      setSelectedName((current) => {
        if (current && nextSkills.some((skill: MarketSkillSummary) => skill.name === current)) {
          return current;
        }
        return nextSkills[0]?.name ?? null;
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : t('skillMarketDialog.loadFailed', 'Failed to load Skill Market.'));
    } finally {
      setListLoading(false);
    }
  }, [t, workspaceId]);

  const fetchFileContent = useCallback(async (name: string, filePath: string) => {
    if (!workspaceId) return;

    setFileLoading(true);
    setError(null);
    try {
      const payload = await readApiPayload(
        await api.skillMarket.file(workspaceId, name, filePath),
        t('skillMarketDialog.fileFailed', 'Failed to load skill file.'),
      );
      const nextFile = payload.file as MarketSkillFile;
      setDetail((current) => {
        if (!current || current.name !== name) return current;
        return {
          ...current,
          files: current.files.map((file) => (
            file.path === nextFile.path ? { ...file, ...nextFile } : file
          )),
        };
      });
      setSelectedFilePath(nextFile.path);
      setFileContent(nextFile.content ?? '');
    } catch (error) {
      setFileContent('');
      setError(error instanceof Error ? error.message : t('skillMarketDialog.fileFailed', 'Failed to load skill file.'));
    } finally {
      setFileLoading(false);
    }
  }, [t, workspaceId]);

  const loadDetail = useCallback(async (name: string, preferredFilePath?: string | null) => {
    if (!workspaceId) return;

    setDetailLoading(true);
    setError(null);
    try {
      const payload = await readApiPayload(
        await api.skillMarket.detail(workspaceId, name),
        t('skillMarketDialog.detailFailed', 'Failed to load skill detail.'),
      );
      const nextDetail = payload.skill as MarketSkillDetail;
      const nextFile = findDefaultFile(nextDetail.files, preferredFilePath);
      setDetail(nextDetail);
      setSelectedFilePath(nextFile?.path ?? null);
      setFileContent('');
      if (nextFile) {
        await fetchFileContent(nextDetail.name, nextFile.path);
      }
    } catch (error) {
      setDetail(null);
      setError(error instanceof Error ? error.message : t('skillMarketDialog.detailFailed', 'Failed to load skill detail.'));
    } finally {
      setDetailLoading(false);
    }
  }, [fetchFileContent, t, workspaceId]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setNotice(null);
      setFileContent('');
      setRemoveTargetName(null);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void loadSkills(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadSkills, open, query]);

  useEffect(() => {
    if (open && selectedName) {
      void loadDetail(selectedName);
    }
  }, [loadDetail, open, selectedName]);

  useEffect(() => {
    setCanManage(!isReadOnly);
  }, [isReadOnly]);

  const selectSkill = (name: string) => {
    setSelectedName(name);
    setNotice(null);
  };

  const selectFile = (filePath: string) => {
    if (filePath === selectedFilePath) return;
    setSelectedFilePath(filePath);
    setFileContent('');
    if (selectedName) {
      void fetchFileContent(selectedName, filePath);
    }
  };

  const refreshAfterMutation = async (skillName: string, changedPath: string, reason: string) => {
    dispatchProjectFilesChanged({
      projectName: selectedProject.name,
      workspaceId,
      changedPath,
      reason,
    });
    await loadSkills(query);
    await loadDetail(skillName, selectedFilePath);
  };

  const importSkill = async () => {
    if (!selectedName || !workspaceId) return;
    const skillName = selectedName;
    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await readApiPayload(
        await api.skillMarket.importSkill(workspaceId, skillName),
        t('skillMarketDialog.importFailed', 'Failed to import skill.'),
      );
      const importedSkill = payload.skill as MarketSkillDetail;
      setDetail(importedSkill);
      setSelectedName(importedSkill.name);
      setNotice(t('skillMarketDialog.imported', 'Imported to Files/.claude/skills.'));
      await refreshAfterMutation(importedSkill.name, `.claude/skills/${importedSkill.name}`, 'skill-market-import');
    } catch (error) {
      setError(error instanceof Error ? error.message : t('skillMarketDialog.importFailed', 'Failed to import skill.'));
    } finally {
      setActionLoading(false);
    }
  };

  const updateImportedSkill = async () => {
    if (!selectedName || !workspaceId) return;
    const skillName = selectedName;
    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      const payload = await readApiPayload(
        await api.skillMarket.updateImport(workspaceId, skillName),
        t('skillMarketDialog.updateFailed', 'Failed to update imported skill.'),
      );
      const updatedSkill = payload.skill as MarketSkillDetail;
      setDetail(updatedSkill);
      setSelectedName(updatedSkill.name);
      setNotice(t('skillMarketDialog.updated', 'Updated local skill from the latest market version.'));
      await refreshAfterMutation(updatedSkill.name, `.claude/skills/${updatedSkill.name}`, 'skill-market-update');
    } catch (error) {
      setError(error instanceof Error ? error.message : t('skillMarketDialog.updateFailed', 'Failed to update imported skill.'));
    } finally {
      setActionLoading(false);
    }
  };

  const requestRemoveSkill = () => {
    if (!selectedName || actionLoading) return;
    setError(null);
    setNotice(null);
    setRemoveTargetName(selectedName);
  };

  const removeSkill = async () => {
    if (!removeTargetName || !workspaceId) return;
    const skillName = removeTargetName;

    setActionLoading(true);
    setError(null);
    setNotice(null);
    try {
      await readApiPayload(
        await api.skillMarket.remove(workspaceId, skillName),
        t('skillMarketDialog.removeFailed', 'Failed to remove skill.'),
      );
      setNotice(t('skillMarketDialog.removed', 'Removed from Files/.claude/skills.'));
      setRemoveTargetName(null);
      dispatchProjectFilesChanged({
        projectName: selectedProject.name,
        workspaceId,
        changedPath: `.claude/skills/${skillName}`,
        reason: 'skill-market-remove',
      });
      await loadSkills(query);
    } catch (error) {
      setRemoveTargetName(null);
      setError(error instanceof Error ? error.message : t('skillMarketDialog.removeFailed', 'Failed to remove skill.'));
    } finally {
      setActionLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-3 sm:p-5">
      <div className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">
              {t('skillMarketDialog.title', 'Skill Market')}
            </h2>
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {selectedProject.displayName} - Files/.claude/skills
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadSkills(query)}
              disabled={listLoading || actionLoading}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('common.refresh', 'Refresh')}
            >
              <RefreshCw className={`h-4 w-4 ${listLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground"
              aria-label={t('common.close', 'Close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_280px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
            <div className="border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('skillMarketDialog.search', 'Search skills...')}
                  className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {listLoading ? (
                <CenteredState icon={<Loader2 className="h-4 w-4 animate-spin" />} text={t('skillMarketDialog.loading', 'Loading...')} />
              ) : visibleSkills.length === 0 ? (
                <CenteredState icon={<AlertCircle className="h-4 w-4" />} text={t('skillMarketDialog.empty', 'No matching skills.')} />
              ) : (
                <div className="grid gap-1.5">
                  {visibleSkills.map((skill) => (
                    <button
                      key={skill.name}
                      type="button"
                      onClick={() => selectSkill(skill.name)}
                      className={`rounded-md border p-3 text-left transition ${
                        selectedName === skill.name
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-accent/50'
                      }`}
                    >
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">{skill.displayName || skill.name}</div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description}</p>
                        </div>
                        <SkillStatusBadge skill={skill} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {typeof skill.version === 'number' ? <span>v{skill.version}</span> : null}
                        {skill.importedVersion !== undefined ? <span>local v{skill.importedVersion}</span> : null}
                        {skill.createUserId ? <span>owner {skill.createUserId}</span> : null}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
            <div className="border-b border-border px-3 py-2">
              <div className="text-xs font-medium uppercase text-muted-foreground">{t('skillMarketDialog.directory', 'Directory')}</div>
              {detail?.targetPath ? (
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{detail.targetPath}</div>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {detailLoading ? (
                <CenteredState icon={<Loader2 className="h-4 w-4 animate-spin" />} text={t('skillMarketDialog.loadingDetail', 'Loading detail...')} />
              ) : directoryRows.length === 0 ? (
                <CenteredState icon={<AlertCircle className="h-4 w-4" />} text={t('skillMarketDialog.noFiles', 'No files.')} />
              ) : (
                <div className="grid gap-0.5">
                  {directoryRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      disabled={row.type === 'directory'}
                      onClick={() => row.filePath && selectFile(row.filePath)}
                      className={`flex h-8 min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm transition ${
                        row.filePath === selectedFilePath
                          ? 'bg-primary/10 text-primary'
                          : row.type === 'file'
                            ? 'text-foreground hover:bg-accent'
                            : 'cursor-default text-muted-foreground'
                      }`}
                      style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                    >
                      {row.type === 'directory' ? <Folder className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
                      <span className="truncate">{row.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <main className="flex min-h-0 flex-col">
            <div className="border-b border-border px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{selectedDisplayName || t('skillMarketDialog.noSelection', 'No skill selected')}</h3>
                    {detail ? <SkillStatusBadge skill={detail} /> : null}
                    {detail?.updateAvailable ? <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">Update available</span> : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{detail?.description}</p>
                  {detail ? (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {typeof detail.version === 'number' ? <span>Market v{detail.version}</span> : null}
                      {detail.importedVersion !== undefined ? <span>Local v{detail.importedVersion}</span> : null}
                      {detail.createUserId ? <span>Creator {detail.createUserId}</span> : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void importSkill()}
                    disabled={!canWrite || !detail || detail.imported || detail.conflict || actionLoading}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <PackagePlus className="h-4 w-4" />}
                    {t('skillMarketDialog.import', 'Import')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateImportedSkill()}
                    disabled={!canWrite || !detail?.imported || !detail.updateAvailable || actionLoading}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-blue-200 px-3 text-sm font-medium text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    {t('skillMarketDialog.update', 'Update')}
                  </button>
                  <button
                    type="button"
                    onClick={requestRemoveSkill}
                    disabled={!canWrite || !detail?.imported || actionLoading}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-destructive/30 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('skillMarketDialog.remove', 'Remove')}
                  </button>
                </div>
              </div>

              {detail?.conflict ? (
                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {t('skillMarketDialog.conflict', 'A same-name .claude/skills directory already exists but was not imported from the market.')}
                </div>
              ) : null}
              {isReadOnly ? (
                <div className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {t('skillMarketDialog.readOnly', 'This workspace is read-only.')}
                </div>
              ) : null}
              {error ? (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}
              {notice ? (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  {notice}
                </div>
              ) : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-9 items-center justify-between gap-2 border-b border-border px-4">
                <div className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {selectedFilePath || t('skillMarketDialog.noFileSelected', 'No file selected')}
                </div>
                {fileLoading ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('skillMarketDialog.loadingFile', 'Loading')}
                  </span>
                ) : null}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-sm leading-6 text-foreground">
                {fileLoading
                  ? t('skillMarketDialog.loadingFileContent', 'Loading file content...')
                  : selectedFilePath
                    ? fileContent
                    : t('skillMarketDialog.filePlaceholder', 'Select a file to view its content.')}
              </pre>
            </div>
          </main>
        </div>
      </div>

      {removeTargetName ? (
        <div
          className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="skill-market-remove-title"
        >
          <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
                <Trash2 className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 id="skill-market-remove-title" className="text-base font-semibold text-foreground">
                  {t('skillMarketDialog.removeDialog.title', 'Remove Skill')}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t(
                    'skillMarketDialog.removeDialog.description',
                    'This removes the imported skill from Files/.claude/skills. The remote skill will not be deleted.',
                  )}
                </p>
                <div className="mt-3 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                  .claude/skills/{removeTargetName}
                </div>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRemoveTargetName(null)}
                disabled={actionLoading}
                className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={() => void removeSkill()}
                disabled={actionLoading}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {t('skillMarketDialog.removeDialog.confirm', 'Remove')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkillStatusBadge({ skill }: { skill: MarketSkillSummary }) {
  const { t } = useTranslation();
  const label = skill.imported
    ? t('skillMarketDialog.status.imported', 'Imported')
    : skill.conflict
      ? t('skillMarketDialog.status.conflict', 'Conflict')
      : t('skillMarketDialog.status.available', 'Available');
  const tone = skill.imported
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : skill.conflict
      ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-border bg-muted text-muted-foreground';

  return (
    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

function CenteredState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center p-4 text-center text-sm text-muted-foreground">
      <div className="flex items-center gap-2">
        {icon}
        <span>{text}</span>
      </div>
    </div>
  );
}

function findDefaultFile(files: MarketSkillFile[], preferredFilePath?: string | null) {
  if (preferredFilePath) {
    const preferred = files.find((file) => file.path === preferredFilePath);
    if (preferred) return preferred;
  }

  return files.find((file) => file.path.split('/').pop()?.toLowerCase() === 'skill.md') ?? files[0] ?? null;
}

function createDirectoryRows(files: MarketSkillFile[]): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  const seenFolders = new Set<string>();

  [...files]
    .sort((left, right) => {
      if (left.path.split('/').pop()?.toLowerCase() === 'skill.md') return -1;
      if (right.path.split('/').pop()?.toLowerCase() === 'skill.md') return 1;
      return left.path.localeCompare(right.path);
    })
    .forEach((file) => {
      const parts = file.path.split('/').filter(Boolean);
      let folderPath = '';
      parts.slice(0, -1).forEach((part, index) => {
        folderPath = folderPath ? `${folderPath}/${part}` : part;
        if (!seenFolders.has(folderPath)) {
          seenFolders.add(folderPath);
          rows.push({
            id: `directory:${folderPath}`,
            label: part,
            depth: index,
            type: 'directory',
          });
        }
      });
      rows.push({
        id: `file:${file.path}`,
        label: parts[parts.length - 1] || file.path,
        depth: Math.max(parts.length - 1, 0),
        type: 'file',
        filePath: file.path,
      });
    });

  return rows;
}

async function readApiPayload(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
}
