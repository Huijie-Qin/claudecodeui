import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Edit3, Loader2, Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { dispatchProjectFilesChanged } from '../../../file-tree/utils/fileTreeEvents';

type ProjectEditDialogProps = {
  project: Project | null;
  open: boolean;
  isStarred: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (project: Project, favorited: boolean) => Promise<void> | void;
};

type ProjectSettingsPayload = {
  displayName?: string;
  claudeMarkdown?: string;
  agentMarkdown?: string;
  revision?: string;
  canEdit?: boolean;
  customInstructions?: {
    customInstructionFiles?: string[];
    hasCustomInstructions?: boolean;
    legacyRootMirror?: boolean;
  };
  error?: string;
  message?: string;
};

async function readResponseError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({} as ProjectSettingsPayload));
  return payload.error || payload.message || fallback;
}

export default function ProjectEditDialog({
  project,
  open,
  isStarred,
  onOpenChange,
  onSaved,
}: ProjectEditDialogProps) {
  const { t } = useTranslation('sidebar');
  const [displayName, setDisplayName] = useState('');
  const [claudeMarkdown, setClaudeMarkdown] = useState('');
  const [favorited, setFavorited] = useState(false);
  const [revision, setRevision] = useState('');
  const [canEdit, setCanEdit] = useState(true);
  const [customInstructionFiles, setCustomInstructionFiles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSequenceRef = useRef(0);

  const loadSettings = useCallback(async () => {
    if (!project?.workspaceId) {
      setError(t('projectEdit.workspaceUnavailable', { defaultValue: '缺少项目空间信息，无法加载项目配置。' }));
      setCanEdit(false);
      return;
    }

    const sequence = ++loadSequenceRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.projectSettings(project.name, project.workspaceId);
      if (!response.ok) {
        throw new Error(await readResponseError(
          response,
          t('projectEdit.loadFailed', { defaultValue: '加载项目配置失败。' }),
        ));
      }

      const payload = await response.json() as ProjectSettingsPayload;
      if (sequence !== loadSequenceRef.current) {
        return;
      }
      setDisplayName(payload.displayName || project.displayName || project.name);
      setClaudeMarkdown(payload.claudeMarkdown ?? payload.agentMarkdown ?? '');
      setRevision(payload.revision || '');
      setCanEdit(payload.canEdit !== false && project.accessRole !== 'view');
      setCustomInstructionFiles(payload.customInstructions?.customInstructionFiles || []);
    } catch (caughtError) {
      if (sequence !== loadSequenceRef.current) {
        return;
      }
      setError(caughtError instanceof Error
        ? caughtError.message
        : t('projectEdit.loadFailed', { defaultValue: '加载项目配置失败。' }));
    } finally {
      if (sequence === loadSequenceRef.current) {
        setIsLoading(false);
      }
    }
  }, [project, t]);

  useEffect(() => {
    if (!open || !project) {
      loadSequenceRef.current += 1;
      setIsLoading(false);
      setIsSaving(false);
      setError(null);
      return;
    }

    setDisplayName(project.displayName || project.name);
    setClaudeMarkdown('');
    setRevision('');
    setCustomInstructionFiles([]);
    setFavorited(isStarred);
    setCanEdit(project.accessRole !== 'view');
    void loadSettings();
  }, [isStarred, loadSettings, open, project]);

  const close = () => {
    if (!isSaving) {
      onOpenChange(false);
    }
  };

  const save = async () => {
    if (!project || isLoading || isSaving) {
      return;
    }
    if (canEdit && !displayName.trim()) {
      setError(t('projectEdit.nameRequired', { defaultValue: '请输入项目名称。' }));
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      if (canEdit) {
        if (!project.workspaceId) {
          throw new Error(t('projectEdit.workspaceUnavailable', { defaultValue: '缺少项目空间信息，无法保存项目配置。' }));
        }
        const response = await api.updateProjectSettings(project.name, {
          displayName: displayName.trim(),
          claudeMarkdown,
          expectedRevision: revision,
          workspaceId: project.workspaceId,
        });
        if (!response.ok) {
          if (response.status === 409) {
            throw new Error(t('projectEdit.conflict', {
              defaultValue: 'CLAUDE.md 已在其他页面发生变化，请关闭后重新打开再编辑。',
            }));
          }
          throw new Error(await readResponseError(
            response,
            t('projectEdit.saveFailed', { defaultValue: '保存项目配置失败。' }),
          ));
        }

        dispatchProjectFilesChanged({
          projectName: project.name,
          workspaceId: project.workspaceId,
          changedPath: 'CLAUDE.md',
          reason: 'project_settings_update',
        });
      }

      await onSaved(project, favorited);
      onOpenChange(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error
        ? caughtError.message
        : t('projectEdit.saveFailed', { defaultValue: '保存项目配置失败。' }));
    } finally {
      setIsSaving(false);
    }
  };

  const title = project?.displayName || project?.name || '';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen || !isSaving) {
        onOpenChange(nextOpen);
      }
    }}>
      <DialogContent className="max-w-2xl overflow-hidden p-0" onPointerDownOutside={close} onEscapeKeyDown={close}>
        <DialogTitle>{t('projectEdit.title', { defaultValue: '编辑项目' })}</DialogTitle>
        <div className="flex max-h-[86vh] flex-col">
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Edit3 className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground">
                {t('projectEdit.title', { defaultValue: '编辑项目' })}
              </h2>
              <p className="truncate text-xs text-muted-foreground">{title}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={close}
              disabled={isSaving}
              aria-label={t('actions.cancel', { defaultValue: '关闭' })}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-5 overflow-y-auto px-5 py-4">
            {isLoading ? (
              <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('projectEdit.loading', { defaultValue: '正在加载项目配置…' })}
              </div>
            ) : (
              <>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-foreground">
                    {t('projectEdit.projectName', { defaultValue: '项目名称' })}
                  </span>
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    disabled={!canEdit || isSaving}
                    maxLength={120}
                    placeholder={t('projectEdit.projectNamePlaceholder', { defaultValue: '请输入项目名称' })}
                  />
                </label>

                <button
                  type="button"
                  role="checkbox"
                  aria-checked={favorited}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors',
                    favorited
                      ? 'border-yellow-400/60 bg-yellow-500/10'
                      : 'border-border bg-background hover:bg-accent/50',
                  )}
                  onClick={() => setFavorited((current) => !current)}
                  disabled={isSaving}
                >
                  <span className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
                    favorited ? 'bg-yellow-500/15 text-yellow-500' : 'bg-muted text-muted-foreground',
                  )}>
                    <Star className={cn('h-4 w-4', favorited && 'fill-current')} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {t('projectEdit.favorite', { defaultValue: '收藏项目' })}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t('projectEdit.favoriteHint', { defaultValue: '收藏后项目会优先显示在项目列表中。' })}
                    </span>
                  </span>
                  <span className={cn(
                    'h-4 w-4 rounded-full border-2',
                    favorited ? 'border-yellow-500 bg-yellow-500 shadow-[inset_0_0_0_3px_hsl(var(--background))]' : 'border-muted-foreground/40',
                  )} />
                </button>

                <label className="block space-y-1.5">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-foreground">CLAUDE.md</span>
                    <span className="text-xs text-muted-foreground">
                      {t('projectEdit.syncTarget', { defaultValue: '项目记忆' })}
                    </span>
                  </span>
                  <textarea
                    value={claudeMarkdown}
                    onChange={(event) => setClaudeMarkdown(event.target.value)}
                    disabled={!canEdit || isSaving}
                    rows={13}
                    spellCheck={false}
                    className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm leading-6 text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    placeholder={t('projectEdit.agentPlaceholder', { defaultValue: '# Project Memory\n\n记录项目背景、约定和 Agent 的工作方式…' })}
                  />
                  <span className="block text-xs leading-5 text-muted-foreground">
                    {canEdit
                      ? t('projectEdit.agentHint', { defaultValue: 'CLAUDE.md 是项目记忆文件；在这里或文件页面修改后，内容会在新会话中由 Claude Code SDK 加载。' })
                      : t('projectEdit.readOnlyHint', { defaultValue: '当前项目为只读权限，仅可修改收藏状态。' })}
                  </span>
                </label>

                {customInstructionFiles.length > 0 ? (
                  <div className="flex gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t('projectEdit.customInstructionsWarning', {
                        defaultValue: '检测到其他指令文件：{{files}}。它们也可能被 Claude Code 加载，请避免与项目 CLAUDE.md 内容冲突。',
                        files: customInstructionFiles.join('、'),
                      })}
                    </span>
                  </div>
                ) : null}
              </>
            )}

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button type="button" variant="outline" onClick={close} disabled={isSaving}>
              {t('actions.cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={isLoading || isSaving || (canEdit && !displayName.trim())}
            >
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('projectEdit.save', { defaultValue: '保存' })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
