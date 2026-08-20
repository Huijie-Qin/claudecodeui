import CodeMirror from '@uiw/react-codemirror';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  FileCode2,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Project } from '../../types/app';
import { api } from '../../utils/api';
import { dispatchSlashCommandsChangedForPath } from '../chat/utils/slashCommandEvents';
import MarkdownPreview from '../code-editor/view/subcomponents/markdown/MarkdownPreview';
import { dispatchProjectFilesChanged } from '../file-tree/utils/fileTreeEvents';

import RemovalConfirmDialog, { type RemovalDialogTarget } from './RemovalConfirmDialog';
import SkillFileTree from './SkillFileTree';
import { useWorkspaceSkills } from './hooks/useWorkspaceSkills';
import type { WorkspaceSkill, WorkspaceSkillEntry } from './utils/skillFormatting';

type SkillsWorkspacePanelProps = {
  selectedProject: Project;
  isReadOnly: boolean;
};

type SkillsView = 'market' | 'mine';
type DetailSource = 'market' | 'mine';

type MarketSkill = {
  id?: string;
  skillId?: string;
  name: string;
  displayName?: string;
  description?: string;
  version?: number;
  importedVersion?: number;
  createUserId?: string;
  imported?: boolean;
  conflict?: boolean;
  remoteDeleted?: boolean;
  updateAvailable?: boolean;
  targetPath?: string;
  files?: Array<{ path: string; size?: number; type?: string; mimeType?: string }>;
};

type SkillDetail = MarketSkill & Partial<WorkspaceSkill> & {
  origin?: 'market' | 'local';
  manageable?: boolean;
  files: WorkspaceSkillEntry[];
};

type SkillFile = {
  path: string;
  content?: string;
  contentBase64?: string;
  size?: number;
  isBinary?: boolean;
  mimeType?: string;
  revision?: string;
};

type UploadPreview = {
  previewId: string;
  name: string;
  displayName?: string;
  description?: string;
  files?: string[];
  conflict?: { blocking?: boolean; type?: string };
};

type RemovalTarget = (RemovalDialogTarget & {
  kind: 'entry';
  entryPath: string;
  skillName: string;
}) | (RemovalDialogTarget & {
  kind: 'local-skill';
  skillName: string;
}) | (RemovalDialogTarget & {
  kind: 'market-skill';
  skillName: string;
});

const MARKET_PAGE_SIZE = 20;

export default function SkillsWorkspacePanel({ selectedProject, isReadOnly }: SkillsWorkspacePanelProps) {
  const workspaceId = selectedProject.workspaceId;
  const [view, setView] = useState<SkillsView>(() => {
    if (typeof window === 'undefined') return 'market';
    return window.localStorage.getItem('skillsWorkspaceView') === 'mine' ? 'mine' : 'market';
  });
  const [query, setQuery] = useState('');
  const [originFilter, setOriginFilter] = useState<'all' | 'market' | 'local'>('all');
  const [marketSkills, setMarketSkills] = useState<MarketSkill[]>([]);
  const [marketPage, setMarketPage] = useState(1);
  const [marketHasMore, setMarketHasMore] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketLoadingMore, setMarketLoadingMore] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [detailTarget, setDetailTarget] = useState<{ source: DetailSource; name: string } | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedEntryPath, setSelectedEntryPath] = useState<string | null>(null);
  const [file, setFile] = useState<SkillFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [previewMode, setPreviewMode] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadArchive, setUploadArchive] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<UploadPreview | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const mine = useWorkspaceSkills(workspaceId);
  const canManage = !isReadOnly && mine.data?.canManage !== false;
  const dirty = editing && file?.content !== editContent;

  const loadMarket = useCallback(async (page = 1, reset = true) => {
    if (!workspaceId) {
      setMarketError('当前工作区不支持技能市场。');
      return;
    }
    if (reset) {
      setMarketLoading(true);
    } else {
      setMarketLoadingMore(true);
    }
    setMarketError(null);
    try {
      const payload = await readPayload(
        await api.skillMarket.list(workspaceId, { searchContent: query.trim(), page, pageSize: MARKET_PAGE_SIZE }),
        '技能市场加载失败。',
      );
      const nextSkills = (payload.skills ?? []) as MarketSkill[];
      setMarketSkills((current) => reset ? nextSkills : mergeMarketSkills(current, nextSkills));
      setMarketPage(page);
      setMarketHasMore(Boolean(payload.pageInfo?.hasNextPage ?? nextSkills.length >= MARKET_PAGE_SIZE));
    } catch (error) {
      setMarketError(toErrorMessage(error, '技能市场加载失败。'));
    } finally {
      setMarketLoading(false);
      setMarketLoadingMore(false);
    }
  }, [query, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMarket(1, true), 250);
    return () => window.clearTimeout(timer);
  }, [loadMarket]);

  useEffect(() => {
    setDetailTarget(null);
    setDetail(null);
    setSelectedFilePath(null);
    setSelectedEntryPath(null);
    setFile(null);
    setEditing(false);
    setMessage(null);
    setRemovalTarget(null);
  }, [workspaceId]);

  useEffect(() => {
    window.localStorage.setItem('skillsWorkspaceView', view);
  }, [view]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty]);

  const loadSkillFile = useCallback(async (target: { source: DetailSource; name: string }, filePath: string) => {
    if (!workspaceId) return;
    setFileLoading(true);
    setMessage(null);
    try {
      const response = target.source === 'market'
        ? await api.skillMarket.file(workspaceId, target.name, filePath)
        : await api.workspaceSkills.file(workspaceId, target.name, filePath);
      const payload = await readPayload(response, '技能文件加载失败。');
      const nextFile = (payload.file ?? payload) as SkillFile;
      setSelectedFilePath(nextFile.path);
      setSelectedEntryPath(nextFile.path);
      setFile(nextFile);
      setEditContent(nextFile.content ?? '');
      setEditing(false);
      setPreviewMode(isMarkdownFile(nextFile.path));
    } catch (error) {
      setFile(null);
      setMessage({ kind: 'error', text: toErrorMessage(error, '技能文件加载失败。') });
    } finally {
      setFileLoading(false);
    }
  }, [workspaceId]);

  const loadDetail = useCallback(async (target: { source: DetailSource; name: string }, preferredFile?: string | null) => {
    if (!workspaceId) return;
    setDetailLoading(true);
    setMessage(null);
    try {
      const payload = await readPayload(
        target.source === 'market'
          ? await api.skillMarket.detail(workspaceId, target.name)
          : await api.workspaceSkills.detail(workspaceId, target.name),
        '技能详情加载失败。',
      );
      let rawDetail = (payload.skill ?? payload) as SkillDetail;
      if (target.source === 'mine' && rawDetail.origin === 'market') {
        try {
          const marketPayload = await readPayload(
            await api.skillMarket.detail(workspaceId, target.name),
            '市场版本状态加载失败。',
          );
          const marketDetail = marketPayload.skill as MarketSkill;
          rawDetail = {
            ...rawDetail,
            marketVersion: marketDetail.version,
            localVersion: marketDetail.importedVersion ?? rawDetail.localVersion,
            updateAvailable: marketDetail.updateAvailable,
            remoteDeleted: marketDetail.remoteDeleted,
            createUserId: marketDetail.createUserId ?? rawDetail.createUserId,
          };
        } catch {
          // Local files remain usable when the market is temporarily unavailable.
        }
      }
      const selectedSummary = mine.data?.skills.find((skill) => skill.name === target.name);
      const nextDetail = normalizeDetail({ ...selectedSummary, ...rawDetail }, target.source);
      setDetail(nextDetail);
      setDetailTarget(target);
      const nextFile = findDefaultFile(nextDetail.files, preferredFile);
      setSelectedFilePath(nextFile?.path ?? null);
      setSelectedEntryPath(nextFile?.path ?? null);
      setFile(null);
      if (nextFile) await loadSkillFile(target, nextFile.path);
    } catch (error) {
      setDetail(null);
      setMessage({ kind: 'error', text: toErrorMessage(error, '技能详情加载失败。') });
    } finally {
      setDetailLoading(false);
    }
  }, [loadSkillFile, mine.data?.skills, workspaceId]);

  const guardUnsaved = () => !dirty || window.confirm('当前文件有未保存的修改，确定放弃吗？');

  const changeView = (nextView: SkillsView) => {
    if (nextView === view || !guardUnsaved()) return;
    setView(nextView);
    setDetailTarget(null);
    setDetail(null);
    setSelectedFilePath(null);
    setSelectedEntryPath(null);
    setFile(null);
    setEditing(false);
    setMessage(null);
  };

  const selectFile = (filePath: string) => {
    if (!detailTarget || filePath === selectedFilePath || !guardUnsaved()) return;
    void loadSkillFile(detailTarget, filePath);
  };

  const resetDetail = () => {
    setDetailTarget(null);
    setDetail(null);
    setSelectedFilePath(null);
    setSelectedEntryPath(null);
    setFile(null);
    setEditing(false);
    setMessage(null);
  };

  const leaveDetail = () => {
    if (!guardUnsaved()) return;
    resetDetail();
  };

  const notifyWorkspaceChanged = (skillName: string, reason: string) => {
    const changedPath = `.claude/skills/${skillName}`;
    dispatchProjectFilesChanged({
      projectName: selectedProject.name,
      workspaceId,
      changedPath,
      reason,
    });
    dispatchSlashCommandsChangedForPath(changedPath, {
      projectName: selectedProject.name,
      workspaceId,
      reason,
    });
  };

  const refreshAll = async () => {
    await Promise.all([loadMarket(1, true), mine.reload()]);
  };

  const runMarketAction = async (action: 'import' | 'update') => {
    if (!workspaceId || !detailTarget || actionLoading) return;
    setActionLoading(true);
    setMessage(null);
    try {
      if (action === 'import') {
        await readPayload(await api.skillMarket.importSkill(workspaceId, detailTarget.name), '技能导入失败。');
      } else {
        await readPayload(await api.skillMarket.updateImport(workspaceId, detailTarget.name), '技能更新失败。');
      }
      notifyWorkspaceChanged(detailTarget.name, `skill-market-${action}`);
      await refreshAll();
      await loadDetail(detailTarget, selectedFilePath);
      setMessage({
        kind: 'success',
        text: action === 'import' ? '技能已导入。' : '技能已更新。',
      });
    } catch (error) {
      setMessage({ kind: 'error', text: toErrorMessage(error, '技能操作失败。') });
    } finally {
      setActionLoading(false);
    }
  };

  const saveFile = async () => {
    if (!workspaceId || !detailTarget || !file || !dirty) return;
    setActionLoading(true);
    setMessage(null);
    try {
      const payload = await readPayload(
        await api.workspaceSkills.saveFile(workspaceId, detailTarget.name, {
          filePath: file.path,
          content: editContent,
          revision: file.revision,
        }),
        '文件保存失败。',
      );
      const nextFile = payload.file as SkillFile;
      setFile(nextFile);
      setEditContent(nextFile.content ?? '');
      setEditing(false);
      notifyWorkspaceChanged(detailTarget.name, 'workspace-skill-file-update');
      await Promise.all([mine.reload(), loadDetail(detailTarget, nextFile.path)]);
      setMessage({ kind: 'success', text: '文件已保存。' });
    } catch (error) {
      setMessage({ kind: 'error', text: toErrorMessage(error, '文件保存失败。') });
    } finally {
      setActionLoading(false);
    }
  };

  const createEntry = async (entryPath: string, type: 'file' | 'directory'): Promise<boolean> => {
    if (!workspaceId || !detailTarget || detail?.origin !== 'local') return false;
    setActionLoading(true);
    setMessage(null);
    try {
      await readPayload(
        await api.workspaceSkills.createEntry(workspaceId, detailTarget.name, { path: entryPath, type }),
        '创建失败。',
      );
      notifyWorkspaceChanged(detailTarget.name, 'workspace-skill-entry-create');
      await loadDetail(detailTarget, type === 'file' ? entryPath : selectedFilePath);
      if (type === 'directory') setSelectedEntryPath(entryPath);
      setMessage({ kind: 'success', text: type === 'file' ? '文件已创建。' : '文件夹已创建。' });
      return true;
    } catch (error) {
      setMessage({ kind: 'error', text: toErrorMessage(error, '创建失败。') });
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  const renameEntry = async (entryPath: string, nextPath: string): Promise<boolean> => {
    if (!workspaceId || !detailTarget || entryPath === 'SKILL.md' || nextPath === entryPath) return false;
    setActionLoading(true);
    setMessage(null);
    try {
      await readPayload(
        await api.workspaceSkills.renameEntry(workspaceId, detailTarget.name, { path: entryPath, nextPath }),
        '重命名失败。',
      );
      notifyWorkspaceChanged(detailTarget.name, 'workspace-skill-entry-rename');
      const preferredFile = selectedFilePath && (selectedFilePath === entryPath || selectedFilePath.startsWith(`${entryPath}/`))
        ? `${nextPath}${selectedFilePath.slice(entryPath.length)}`
        : selectedFilePath;
      await loadDetail(detailTarget, preferredFile);
      setSelectedEntryPath(nextPath);
      setMessage({ kind: 'success', text: '已重命名。' });
      return true;
    } catch (error) {
      setMessage({ kind: 'error', text: toErrorMessage(error, '重命名失败。') });
      return false;
    } finally {
      setActionLoading(false);
    }
  };

  const requestEntryRemoval = (entryPath: string) => {
    if (!detailTarget || entryPath === 'SKILL.md') return;
    const entry = detail?.files.find((candidate) => candidate.path === entryPath);
    const isDirectory = entry?.type === 'directory' || detail?.files.some((candidate) => candidate.path.startsWith(`${entryPath}/`));
    setRemovalTarget({
      kind: 'entry',
      entryPath,
      skillName: detailTarget.name,
      title: isDirectory ? '移除文件夹' : '移除文件',
      description: isDirectory ? '这会移除该文件夹及其中的全部内容，此操作无法撤销。' : '这会从当前 Skill 中移除该文件，此操作无法撤销。',
      path: `.claude/skills/${detailTarget.name}/${entryPath}`,
    });
  };

  const requestSkillRemoval = (kind: 'local-skill' | 'market-skill') => {
    if (!detailTarget) return;
    setRemovalTarget({
      kind,
      skillName: detailTarget.name,
      title: '移除 Skill',
      description: kind === 'market-skill'
        ? '这会移除当前工作区中已导入的 Skill，远端技能市场中的内容不会被删除。'
        : '这会移除该本地 Skill 及其中的全部内容，此操作无法撤销。',
      path: `.claude/skills/${detailTarget.name}`,
    });
  };

  const confirmRemoval = async () => {
    if (!workspaceId || !detailTarget || !removalTarget || actionLoading) return;
    const target = removalTarget;
    setActionLoading(true);
    setMessage(null);
    try {
      if (target.kind === 'market-skill') {
        await readPayload(await api.skillMarket.remove(workspaceId, target.skillName), '技能移除失败。');
        notifyWorkspaceChanged(target.skillName, 'skill-market-remove');
        await refreshAll();
        if (detailTarget.source === 'mine') {
          resetDetail();
        } else {
          await loadDetail(detailTarget, selectedFilePath);
        }
        setMessage({ kind: 'success', text: '技能已移除。' });
      } else if (target.kind === 'local-skill') {
        await readPayload(await api.workspaceSkills.deleteLocal(workspaceId, target.skillName), '技能移除失败。');
        notifyWorkspaceChanged(target.skillName, 'workspace-skill-delete');
        await mine.reload();
        resetDetail();
        setMessage({ kind: 'success', text: '技能已移除。' });
      } else {
        await readPayload(
          await api.workspaceSkills.deleteEntry(workspaceId, target.skillName, target.entryPath),
          '移除失败。',
        );
        notifyWorkspaceChanged(target.skillName, 'workspace-skill-entry-delete');
        const preferredFile = selectedFilePath && (
          selectedFilePath === target.entryPath
          || selectedFilePath.startsWith(`${target.entryPath}/`)
        ) ? null : selectedFilePath;
        await loadDetail(detailTarget, preferredFile);
        setMessage({ kind: 'success', text: '已移除。' });
      }
      setRemovalTarget(null);
    } catch (error) {
      setMessage({ kind: 'error', text: toErrorMessage(error, '移除失败。') });
    } finally {
      setActionLoading(false);
    }
  };

  const previewUpload = async () => {
    if (!workspaceId || !uploadArchive) return;
    setUploadLoading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('archive', uploadArchive);
      const payload = await readPayload(await api.workspaceSkills.uploadLocal(workspaceId, formData), '上传校验失败。');
      setUploadPreview(payload.preview as UploadPreview);
    } catch (error) {
      setUploadError(toErrorMessage(error, '上传校验失败。'));
    } finally {
      setUploadLoading(false);
    }
  };

  const importUpload = async () => {
    if (!workspaceId || !uploadPreview || uploadPreview.conflict?.blocking) return;
    setUploadLoading(true);
    setUploadError(null);
    try {
      await readPayload(
        await api.workspaceSkills.installPreview(workspaceId, { previewId: uploadPreview.previewId, enable: true }),
        '技能上传失败。',
      );
      notifyWorkspaceChanged(uploadPreview.name, 'workspace-skill-upload');
      await mine.reload();
      setUploadOpen(false);
      setUploadArchive(null);
      setUploadPreview(null);
      setView('mine');
      await loadDetail({ source: 'mine', name: uploadPreview.name });
    } catch (error) {
      setUploadError(toErrorMessage(error, '技能上传失败。'));
    } finally {
      setUploadLoading(false);
    }
  };

  const mineSkills = useMemo(() => (mine.data?.skills ?? [])
    .filter((skill) => skill.kind !== 'system' && skill.enabled !== false)
    .filter((skill) => originFilter === 'all' || skill.origin === originFilter)
    .filter((skill) => matchesSkillQuery(skill, query)), [mine.data?.skills, originFilter, query]);

  const marketSummary = useMemo(() => ({
    total: marketSkills.length,
    installed: marketSkills.filter((skill) => skill.imported).length,
    updates: marketSkills.filter((skill) => skill.updateAvailable).length,
  }), [marketSkills]);

  const detailEditable = detailTarget?.source === 'mine' && detail?.origin === 'local' && canManage;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="inline-flex rounded-md border border-border bg-muted p-1" role="tablist" aria-label="技能页面">
          <SubTab active={view === 'market'} onClick={() => changeView('market')}>技能市场</SubTab>
          <SubTab active={view === 'mine'} onClick={() => changeView('mine')}>我的技能</SubTab>
        </div>
        <div className="flex items-center gap-2">
          {view === 'mine' && !detailTarget ? (
            <>
              <ActionButton icon={Upload} label="上传技能" onClick={() => setUploadOpen(true)} disabled={!canManage} />
              <ActionButton icon={Plus} label="新建技能" primary onClick={() => setCreateOpen(true)} disabled={!canManage} />
            </>
          ) : null}
          <button
            type="button"
            onClick={() => view === 'market' ? void loadMarket(1, true) : void mine.reload()}
            disabled={marketLoading || mine.isLoading || actionLoading}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label="刷新"
          >
            <RefreshCw className={`h-4 w-4 ${marketLoading || mine.isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {message ? <InlineMessage message={message} onClose={() => setMessage(null)} /> : null}

      {detailTarget ? (
        <SkillDetailView
          actionLoading={actionLoading}
          canManage={canManage}
          detail={detail}
          detailEditable={detailEditable}
          detailLoading={detailLoading}
          dirty={dirty}
          editContent={editContent}
          editing={editing}
          file={file}
          fileLoading={fileLoading}
          onBack={leaveDetail}
          onCreateEntry={createEntry}
          onDeleteEntry={requestEntryRemoval}
          onDeleteLocalSkill={() => requestSkillRemoval('local-skill')}
          onEditContent={setEditContent}
          onEditingChange={(nextEditing) => {
            if (!nextEditing && dirty && !window.confirm('确定放弃未保存的修改吗？')) return;
            setEditing(nextEditing);
            if (!nextEditing) setEditContent(file?.content ?? '');
          }}
          onMarketAction={(action) => {
            if (action === 'remove') requestSkillRemoval('market-skill');
            else void runMarketAction(action);
          }}
          onPreviewModeChange={setPreviewMode}
          onRenameEntry={renameEntry}
          onSave={saveFile}
          onSelectFile={selectFile}
          onSelectEntry={(entryPath) => setSelectedEntryPath(entryPath)}
          previewMode={previewMode}
          selectedFilePath={selectedFilePath}
          selectedEntryPath={selectedEntryPath}
          source={detailTarget.source}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <SummaryStrip
            items={view === 'market'
              ? [['全部', marketSummary.total], ['已导入', marketSummary.installed], ['待更新', marketSummary.updates]]
              : [['全部', (mine.data?.skills ?? []).filter((skill) => skill.kind !== 'system' && skill.enabled !== false).length], ['市场安装', mine.data?.summary.market ?? 0], ['本地创建', mine.data?.summary.local ?? 0]]}
          />
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={view === 'market' ? '搜索技能名称、描述或创建者…' : '搜索我的技能…'}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20"
              />
            </div>
            {view === 'mine' ? (
              <div className="inline-flex rounded-md border border-border p-1">
                {(['all', 'market', 'local'] as const).map((origin) => (
                  <button
                    key={origin}
                    type="button"
                    onClick={() => setOriginFilter(origin)}
                    className={`rounded px-2.5 py-1 text-xs font-medium transition ${originFilter === origin ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {{ all: '全部', market: '市场安装', local: '本地创建' }[origin]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {view === 'market' ? (
            <SkillList
              error={marketError}
              hasMore={marketHasMore}
              loading={marketLoading}
              loadingMore={marketLoadingMore}
              onLoadMore={() => void loadMarket(marketPage + 1, false)}
              onRetry={() => void loadMarket(1, true)}
              onSelect={(name) => void loadDetail({ source: 'market', name })}
              skills={marketSkills}
              source="market"
            />
          ) : (
            <SkillList
              error={mine.error}
              loading={mine.isLoading}
              onRetry={() => void mine.reload()}
              onSelect={(name) => void loadDetail({ source: 'mine', name })}
              skills={mineSkills}
              source="mine"
            />
          )}
        </div>
      )}

      {createOpen ? (
        <CreateSkillDialog
          workspaceId={workspaceId}
          onClose={() => setCreateOpen(false)}
          onCreated={async (name) => {
            notifyWorkspaceChanged(name, 'workspace-skill-create');
            await mine.reload();
            setCreateOpen(false);
            setView('mine');
            await loadDetail({ source: 'mine', name });
            setEditing(true);
            setPreviewMode(false);
          }}
        />
      ) : null}

      {uploadOpen ? (
        <UploadSkillDialog
          archive={uploadArchive}
          error={uploadError}
          loading={uploadLoading}
          onArchiveChange={(nextArchive) => {
            setUploadArchive(nextArchive);
            setUploadPreview(null);
            setUploadError(null);
          }}
          onClose={() => {
            if (uploadLoading) return;
            setUploadOpen(false);
            setUploadArchive(null);
            setUploadPreview(null);
            setUploadError(null);
          }}
          onImport={() => void importUpload()}
          onPreview={() => void previewUpload()}
          preview={uploadPreview}
        />
      ) : null}

      {removalTarget ? (
        <RemovalConfirmDialog
          busy={actionLoading}
          onCancel={() => setRemovalTarget(null)}
          onConfirm={() => void confirmRemoval()}
          target={removalTarget}
        />
      ) : null}
    </section>
  );
}

function SkillList({
  error,
  hasMore = false,
  loading,
  loadingMore = false,
  onLoadMore,
  onRetry,
  onSelect,
  skills,
  source,
}: {
  error?: string | null;
  hasMore?: boolean;
  loading: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onRetry: () => void;
  onSelect: (name: string) => void;
  skills: Array<MarketSkill | WorkspaceSkill>;
  source: DetailSource;
}) {
  if (loading) return <CenteredState icon={<Loader2 className="h-5 w-5 animate-spin" />} title="正在加载技能…" />;
  if (error) return <CenteredState icon={<AlertCircle className="h-5 w-5" />} title={error} action="重试" onAction={onRetry} />;
  if (skills.length === 0) return <CenteredState icon={<FileCode2 className="h-5 w-5" />} title="没有匹配的技能" />;

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        {skills.map((skill) => (
          <button
            key={`${source}-${skill.name}`}
            type="button"
            onClick={() => onSelect(skill.name)}
            className="flex w-full min-w-0 items-center gap-3 border-b border-border/70 px-4 py-3 text-left transition last:border-b-0 hover:bg-accent/40"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FileCode2 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{skill.displayName || skill.name}</span>
                <SkillBadges skill={skill} source={source} />
              </div>
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{skill.description || skill.name}</p>
            </div>
            <div className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
              {'version' in skill && typeof skill.version === 'number' ? <div>市场 v{skill.version}</div> : null}
              {'marketVersion' in skill && typeof skill.marketVersion === 'number' ? <div>市场 v{skill.marketVersion}</div> : null}
              {'localVersion' in skill && typeof skill.localVersion === 'number' ? <div>本地 v{skill.localVersion}</div> : null}
              {'importedVersion' in skill && typeof skill.importedVersion === 'number' ? <div>本地 v{skill.importedVersion}</div> : null}
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      {hasMore ? (
        <div className="flex justify-center py-4">
          <button type="button" onClick={onLoadMore} disabled={loadingMore} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-4 text-sm hover:bg-accent disabled:opacity-50">
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            加载更多
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SkillDetailView({
  actionLoading,
  canManage,
  detail,
  detailEditable,
  detailLoading,
  dirty,
  editContent,
  editing,
  file,
  fileLoading,
  onBack,
  onCreateEntry,
  onDeleteEntry,
  onDeleteLocalSkill,
  onEditContent,
  onEditingChange,
  onMarketAction,
  onPreviewModeChange,
  onRenameEntry,
  onSave,
  onSelectEntry,
  onSelectFile,
  previewMode,
  selectedEntryPath,
  selectedFilePath,
  source,
}: {
  actionLoading: boolean;
  canManage: boolean;
  detail: SkillDetail | null;
  detailEditable: boolean;
  detailLoading: boolean;
  dirty: boolean;
  editContent: string;
  editing: boolean;
  file: SkillFile | null;
  fileLoading: boolean;
  onBack: () => void;
  onCreateEntry: (path: string, type: 'file' | 'directory') => Promise<boolean>;
  onDeleteEntry: (path: string) => void;
  onDeleteLocalSkill: () => void;
  onEditContent: (content: string) => void;
  onEditingChange: (editing: boolean) => void;
  onMarketAction: (action: 'import' | 'update' | 'remove') => void;
  onPreviewModeChange: (preview: boolean) => void;
  onRenameEntry: (path: string, nextPath: string) => Promise<boolean>;
  onSave: () => void;
  onSelectEntry: (path: string) => void;
  onSelectFile: (path: string) => void;
  previewMode: boolean;
  selectedEntryPath: string | null;
  selectedFilePath: string | null;
  source: DetailSource;
}) {
  if (detailLoading) return <CenteredState icon={<Loader2 className="h-5 w-5 animate-spin" />} title="正在加载技能详情…" />;
  if (!detail) return <CenteredState icon={<AlertCircle className="h-5 w-5" />} title="技能详情不可用" action="返回" onAction={onBack} />;
  const isLocalOrigin = source === 'mine' && detail.origin === 'local';
  const marketInstalled = source === 'market' ? detail.imported === true : detail.origin === 'market';
  const updateAvailable = detail.updateAvailable === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={onBack} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> 返回
          </button>
          <span className="text-muted-foreground">/</span>
          <span className="truncate text-sm font-medium">{source === 'market' ? '技能市场' : '我的技能'}</span>
          <span className="text-muted-foreground">/</span>
          <span className="truncate text-sm text-muted-foreground">{detail.displayName || detail.name}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {source === 'market' && !marketInstalled ? <ActionButton icon={Plus} label="导入" primary onClick={() => onMarketAction('import')} disabled={!canManage || detail.conflict || actionLoading} /> : null}
          {marketInstalled && updateAvailable ? <ActionButton icon={RefreshCw} label="更新" primary onClick={() => onMarketAction('update')} disabled={!canManage || actionLoading} /> : null}
          {marketInstalled ? <ActionButton icon={Trash2} label="移除" onClick={() => onMarketAction('remove')} disabled={!canManage || actionLoading} danger /> : null}
          {isLocalOrigin ? <ActionButton icon={Trash2} label="移除" onClick={onDeleteLocalSkill} disabled={!canManage || actionLoading} danger /> : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <SkillFileTree
          busy={actionLoading}
          editable={detailEditable}
          entries={detail.files}
          onCreateEntry={onCreateEntry}
          onRenameEntry={onRenameEntry}
          onRequestRemove={onDeleteEntry}
          onSelectEntry={onSelectEntry}
          onSelectFile={onSelectFile}
          selectedEntryPath={selectedEntryPath}
          targetPath={detail.targetPath || `.claude/skills/${detail.name}`}
          treeKey={`${source}:${detail.name}`}
        />

        <main className="flex min-h-0 flex-col">
          <div className="border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-base font-semibold">{detail.displayName || detail.name}</h2>
                  <SkillBadges skill={detail} source={source} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{detail.description || '暂无描述'}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {typeof detail.version === 'number' ? <span>市场版本 v{detail.version}</span> : null}
                  {typeof detail.marketVersion === 'number' ? <span>市场版本 v{detail.marketVersion}</span> : null}
                  {typeof detail.importedVersion === 'number' ? <span>本地版本 v{detail.importedVersion}</span> : null}
                  {typeof detail.localVersion === 'number' ? <span>本地版本 v{detail.localVersion}</span> : null}
                  {detail.createUserId ? <span>创建者 {detail.createUserId}</span> : null}
                </div>
              </div>
              {detailEditable && selectedFilePath ? (
                <div className="flex flex-wrap items-center gap-1">
                  {!file?.isBinary ? (
                    <ActionButton icon={editing ? X : Pencil} label={editing ? '取消编辑' : '编辑'} onClick={() => onEditingChange(!editing)} disabled={actionLoading} />
                  ) : null}
                  {editing ? <ActionButton icon={Save} label={dirty ? '保存' : '已保存'} primary onClick={onSave} disabled={!dirty || actionLoading} /> : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {fileLoading ? <CenteredState icon={<Loader2 className="h-5 w-5 animate-spin" />} title="正在加载文件…" /> : file ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <span className="truncate font-mono text-xs text-muted-foreground">{file.path}</span>
                  {isMarkdownFile(file.path) && !editing ? (
                    <div className="inline-flex rounded-md border border-border p-0.5">
                      <SmallToggle active={previewMode} onClick={() => onPreviewModeChange(true)}>预览</SmallToggle>
                      <SmallToggle active={!previewMode} onClick={() => onPreviewModeChange(false)}>源码</SmallToggle>
                    </div>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <FileContentView
                    content={editing ? editContent : file.content ?? ''}
                    editing={editing}
                    file={file}
                    onChange={onEditContent}
                    previewMode={previewMode}
                  />
                </div>
              </>
            ) : <CenteredState icon={<FileText className="h-5 w-5" />} title="选择文件后查看内容" />}
          </div>
        </main>
      </div>
    </div>
  );
}

function FileContentView({ content, editing, file, onChange, previewMode }: { content: string; editing: boolean; file: SkillFile; onChange: (content: string) => void; previewMode: boolean }) {
  if (file.isBinary) {
    if (file.mimeType?.startsWith('image/') && file.contentBase64) {
      return <div className="flex min-h-full items-center justify-center bg-muted/20 p-6"><img src={`data:${file.mimeType};base64,${file.contentBase64}`} alt={file.path} className="max-h-full max-w-full rounded-md border border-border object-contain" /></div>;
    }
    return (
      <CenteredState
        icon={<FileCode2 className="h-5 w-5" />}
        title="该二进制文件不支持可视化"
        action={file.contentBase64 ? '下载文件' : undefined}
        onAction={file.contentBase64 ? () => downloadBase64File(file) : undefined}
      />
    );
  }
  if (!editing && previewMode && isMarkdownFile(file.path)) {
    return <div className="prose prose-sm mx-auto max-w-4xl px-8 py-6 dark:prose-invert"><MarkdownPreview content={content} /></div>;
  }
  if (editing) {
    return <CodeMirror value={content} onChange={onChange} height="100%" style={{ height: '100%', fontSize: '13px' }} basicSetup={{ lineNumbers: true, foldGutter: true, bracketMatching: true, closeBrackets: true }} />;
  }
  return <pre className="min-h-full overflow-auto p-4 font-mono text-xs leading-6 text-foreground"><code>{content}</code></pre>;
}

function CreateSkillDialog({ workspaceId, onClose, onCreated }: { workspaceId?: number; onClose: () => void; onCreated: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generatedContent = content || ['---', `name: ${JSON.stringify(displayName || name || 'my-skill')}`, `description: ${JSON.stringify(description || '描述这个技能适用的场景。')}`, '---', '', `# ${displayName || name || 'My Skill'}`, ''].join('\n');

  const submit = async () => {
    if (!workspaceId || !name.trim() || !description.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await readPayload(await api.workspaceSkills.createLocal(workspaceId, { name, displayName, description, content: generatedContent }), '技能创建失败。');
      await onCreated(name.trim());
    } catch (error) {
      setError(toErrorMessage(error, '技能创建失败。'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="新建技能" description="创建到当前 workspace 的 .claude/skills 目录" onClose={onClose} busy={loading}>
      <div className="space-y-4">
        <Field label="技能目录名" value={name} onChange={setName} placeholder="my-skill" helper={`目标路径：.claude/skills/${name || '<name>'}/`} />
        <Field label="展示名称" value={displayName} onChange={setDisplayName} placeholder="我的技能" />
        <Field label="描述" value={description} onChange={setDescription} placeholder="说明什么时候应该使用这个技能" />
        <label className="block text-sm font-medium">初始 SKILL.md
          <textarea value={generatedContent} onChange={(event) => setContent(event.target.value)} className="mt-2 min-h-48 w-full rounded-md border border-input bg-background p-3 font-mono text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" />
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" onClick={onClose} disabled={loading} className="h-9 rounded-md border border-border px-4 text-sm hover:bg-accent">取消</button>
          <button type="button" onClick={() => void submit()} disabled={loading || !name.trim() || !description.trim()} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} 创建
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UploadSkillDialog({ archive, error, loading, onArchiveChange, onClose, onImport, onPreview, preview }: { archive: File | null; error: string | null; loading: boolean; onArchiveChange: (file: File | null) => void; onClose: () => void; onImport: () => void; onPreview: () => void; preview: UploadPreview | null }) {
  return (
    <Modal title="上传技能" description="上传包含一个技能目录和 SKILL.md 的 ZIP 文件" onClose={onClose} busy={loading}>
      <div className="space-y-4">
        <label className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20 p-6 text-center transition hover:bg-muted/40">
          <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
          <span className="text-sm font-medium">选择 ZIP 文件</span>
          <span className="mt-1 text-xs text-muted-foreground">导入后统一标记为“本地创建”</span>
          <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(event) => onArchiveChange(event.target.files?.[0] ?? null)} />
        </label>
        {archive ? <div className="rounded-md border border-border px-3 py-2 text-sm">{archive.name}</div> : null}
        {preview ? (
          <div className={`rounded-md border p-3 text-sm ${preview.conflict?.blocking ? 'border-destructive/40 bg-destructive/5' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20'}`}>
            <div className="font-medium">{preview.displayName || preview.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">{preview.description || '暂无描述'} · {preview.files?.length ?? 0} 个文件</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">.claude/skills/{preview.name}/</p>
            {preview.conflict?.blocking ? <p className="mt-2 text-xs text-destructive">目标目录已存在，不能覆盖。</p> : null}
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" onClick={onClose} disabled={loading} className="h-9 rounded-md border border-border px-4 text-sm hover:bg-accent">取消</button>
          {!preview ? (
            <button type="button" onClick={onPreview} disabled={loading || !archive} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}校验</button>
          ) : (
            <button type="button" onClick={onImport} disabled={loading || preview.conflict?.blocking} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}导入</button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, description, onClose, busy, children }: { title: string; description: string; onClose: () => void; busy: boolean; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div><h2 className="text-base font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent" aria-label="关闭"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, helper }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; helper?: string }) {
  return <label className="block text-sm font-medium">{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" />{helper ? <span className="mt-1 block font-mono text-xs font-normal text-muted-foreground">{helper}</span> : null}</label>;
}

function SkillBadges({ skill, source }: { skill: MarketSkill | WorkspaceSkill | SkillDetail; source: DetailSource }) {
  const origin = 'origin' in skill ? skill.origin : undefined;
  const updateAvailable = 'updateAvailable' in skill && skill.updateAvailable === true;
  const remoteDeleted = 'remoteDeleted' in skill && skill.remoteDeleted === true;
  const conflict = 'conflict' in skill && skill.conflict === true;
  const imported = 'imported' in skill && skill.imported === true;
  const invalid = 'status' in skill && skill.status === 'invalid';
  return (
    <>
      {source === 'mine' && origin ? <Badge tone={origin === 'market' ? 'slate' : 'blue'}>{origin === 'market' ? '市场安装' : '本地创建'}</Badge> : null}
      {source === 'market' && imported ? <Badge tone="green">已导入</Badge> : null}
      {source === 'market' && !imported && !conflict ? <Badge tone="slate">可导入</Badge> : null}
      {updateAvailable ? <Badge tone="amber">待更新</Badge> : null}
      {remoteDeleted ? <Badge tone="red">市场已下架</Badge> : null}
      {conflict ? <Badge tone="red">冲突</Badge> : null}
      {invalid ? <Badge tone="red">解析失败</Badge> : null}
    </>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: 'slate' | 'blue' | 'green' | 'amber' | 'red' }) {
  const classes = { slate: 'border-border bg-muted text-muted-foreground', blue: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300', green: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300', amber: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300', red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300' };
  return <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${classes[tone]}`}>{children}</span>;
}

function SubTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`h-8 rounded px-3 text-sm font-medium transition ${active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{children}</button>;
}

function SmallToggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className={`rounded px-2 py-1 text-xs ${active ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>{children}</button>;
}

function ActionButton({ icon: Icon, label, onClick, disabled = false, primary = false, danger = false }: { icon: typeof Plus; label: string; onClick: () => void; disabled?: boolean; primary?: boolean; danger?: boolean }) {
  return <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${primary ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90' : danger ? 'border-destructive/30 text-destructive hover:bg-destructive/10' : 'border-border bg-background hover:bg-accent'}`}><Icon className="h-4 w-4" />{label}</button>;
}

function SummaryStrip({ items }: { items: Array<[string, number]> }) {
  return <div className="grid grid-cols-3 gap-px border-b border-border bg-border">{items.map(([label, value]) => <div key={label} className="bg-background px-5 py-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold text-foreground">{value}</div></div>)}</div>;
}

function CenteredState({ icon, title, action, onAction }: { icon: ReactNode; title: string; action?: string; onAction?: () => void }) {
  return <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground"><div className="text-muted-foreground">{icon}</div><p>{title}</p>{action ? <button type="button" onClick={onAction} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent">{action}</button> : null}</div>;
}

function InlineMessage({ message, onClose }: { message: { kind: 'success' | 'error'; text: string }; onClose: () => void }) {
  return <div className={`flex items-center gap-2 border-b px-4 py-2 text-sm ${message.kind === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300' : 'border-destructive/30 bg-destructive/5 text-destructive'}`}>{message.kind === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}<span className="flex-1">{message.text}</span><button type="button" onClick={onClose} aria-label="关闭提示"><X className="h-4 w-4" /></button></div>;
}

function normalizeDetail(detail: SkillDetail, source: DetailSource): SkillDetail {
  return {
    ...detail,
    origin: detail.origin ?? (source === 'market' ? 'market' : 'local'),
    files: (detail.files ?? []).map((entry) => ({
      path: entry.path,
      type: entry.type === 'directory' || entry.type === 'symlink' ? entry.type : 'file',
      size: entry.size,
      mimeType: entry.mimeType,
    })),
  };
}

function findDefaultFile(files: WorkspaceSkillEntry[], preferred?: string | null) {
  const fileEntries = files.filter((entry) => entry.type === 'file');
  return fileEntries.find((entry) => entry.path === preferred) ?? fileEntries.find((entry) => entry.path === 'SKILL.md') ?? fileEntries[0];
}

function matchesSkillQuery(skill: WorkspaceSkill, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [skill.name, skill.displayName, skill.description, skill.createUserId].filter(Boolean).join(' ').toLowerCase().includes(normalized);
}

function mergeMarketSkills(current: MarketSkill[], next: MarketSkill[]) {
  const merged = new Map(current.map((skill) => [skill.name, skill]));
  next.forEach((skill) => merged.set(skill.name, skill));
  return Array.from(merged.values());
}

function isMarkdownFile(filePath: string) {
  return /\.md(?:own)?$/i.test(filePath);
}

function downloadBase64File(file: SkillFile) {
  if (!file.contentBase64) return;
  const link = document.createElement('a');
  link.href = `data:${file.mimeType || 'application/octet-stream'};base64,${file.contentBase64}`;
  link.download = file.path.split('/').pop() || 'download';
  link.click();
}

async function readPayload(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || fallback);
  return payload;
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
