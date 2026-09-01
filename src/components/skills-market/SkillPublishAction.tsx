import { CheckCircle2, Loader2, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../utils/api';

import { getSkillPublishMode, type SkillPublishMode } from './utils/skillPublish';

type MarketSkillPublishChange = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  isBinary?: boolean;
  oldContent?: string;
  newContent?: string;
};

type MarketSkillPublishPreview = {
  skill?: {
    name?: string;
    displayName?: string;
    version?: number;
  };
  localContentHash: string;
  changes: MarketSkillPublishChange[];
};

type MarketSkillSubmitState = {
  mode: SkillPublishMode | null;
  visible: boolean;
  updateAvailable: boolean;
  importedVersion: number | null;
  remoteVersion: number | null;
  loading: boolean;
  submitting: boolean;
  success: boolean;
  confirmOpen: boolean;
  updateWarningOpen: boolean;
  confirmation: string;
  preview: MarketSkillPublishPreview | null;
};

type SkillPublishActionProps = {
  workspaceId?: number;
  skillName: string;
  disabled?: boolean;
  beforePublish?: () => Promise<boolean>;
  onError?: (message: string) => void;
  onPublished?: (mode: SkillPublishMode, skillName: string) => void | Promise<void>;
};

function createInitialState(loading = false): MarketSkillSubmitState {
  return {
    mode: null,
    visible: false,
    updateAvailable: false,
    importedVersion: null,
    remoteVersion: null,
    loading,
    submitting: false,
    success: false,
    confirmOpen: false,
    updateWarningOpen: false,
    confirmation: '',
    preview: null,
  };
}

export default function SkillPublishAction({
  workspaceId,
  skillName,
  disabled = false,
  beforePublish,
  onError,
  onPublished,
}: SkillPublishActionProps) {
  const { t } = useTranslation('codeEditor');
  const [state, setState] = useState<MarketSkillSubmitState>(() => createInitialState(Boolean(workspaceId)));

  useEffect(() => {
    let cancelled = false;

    if (!workspaceId || !skillName) {
      setState(createInitialState(false));
      return () => {
        cancelled = true;
      };
    }

    setState(createInitialState(true));
    api.skillMarket.publishState(workspaceId, skillName)
      .then(async (response) => {
        const payload = await readApiPayload(response, t('skillMarket.loadFailed', 'Failed to load skill status.'));
        if (cancelled) return;
        const mode = getSkillPublishMode(payload);
        setState({
          mode,
          visible: mode !== null,
          updateAvailable: payload.skill?.updateAvailable === true,
          importedVersion: typeof payload.skill?.importedVersion === 'number' ? payload.skill.importedVersion : null,
          remoteVersion: typeof payload.skill?.version === 'number' ? payload.skill.version : null,
          loading: false,
          submitting: false,
          success: false,
          confirmOpen: false,
          updateWarningOpen: false,
          confirmation: '',
          preview: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Unable to load skill market publish state:', error);
        setState(createInitialState(false));
      });

    return () => {
      cancelled = true;
    };
  }, [skillName, t, workspaceId]);

  const prepareLocalSkill = useCallback(async () => {
    if (!beforePublish) return true;
    try {
      return await beforePublish();
    } catch (error) {
      onError?.(toErrorMessage(error, '发布前保存失败。'));
      return false;
    }
  }, [beforePublish, onError]);

  const notifyPublished = useCallback(async (mode: SkillPublishMode, publishedSkillName: string) => {
    try {
      await onPublished?.(mode, publishedSkillName);
    } catch (error) {
      onError?.(`技能已发布，但页面刷新失败：${toErrorMessage(error, '请手动刷新后查看最新状态。')}`);
    }
  }, [onError, onPublished]);

  const handlePublish = useCallback(async () => {
    if (!workspaceId || !skillName || !state.mode || disabled) return;

    if (state.mode === 'update' && state.updateAvailable) {
      setState((current) => ({
        ...current,
        success: false,
        updateWarningOpen: true,
        confirmation: '',
        preview: null,
      }));
      return;
    }

    setState((current) => ({
      ...current,
      submitting: true,
      success: false,
      confirmation: '',
      preview: null,
    }));

    if (!await prepareLocalSkill()) {
      setState((current) => ({ ...current, submitting: false }));
      return;
    }

    try {
      if (state.mode === 'upload') {
        await readApiPayload(
          await api.skillMarket.uploadAndPublishSkill(workspaceId, skillName),
          t('skillMarket.uploadPublishFailed', 'Failed to upload and publish skill.'),
        );
        setState((current) => ({
          ...current,
          mode: 'update',
          submitting: false,
          success: true,
          confirmOpen: false,
          confirmation: '',
          preview: null,
        }));
        await notifyPublished('upload', skillName);
        window.setTimeout(() => setState((current) => ({ ...current, success: false })), 2000);
        return;
      }

      const payload = await readApiPayload(
        await api.skillMarket.publishPreview(workspaceId, skillName),
        t('skillMarket.previewFailed', 'Failed to load skill update diff.'),
      );
      setState((current) => ({
        ...current,
        submitting: false,
        success: false,
        confirmOpen: true,
        confirmation: '',
        preview: payload as MarketSkillPublishPreview,
      }));
    } catch (error) {
      const message = toErrorMessage(error, '发布失败。');
      setState((current) => ({ ...current, submitting: false, success: false }));
      onError?.(message);
    }
  }, [disabled, notifyPublished, onError, prepareLocalSkill, skillName, state.mode, state.updateAvailable, t, workspaceId]);

  const handleConfirmPublish = useCallback(async () => {
    if (!workspaceId || !skillName || state.confirmation !== 'yes') return;

    setState((current) => ({ ...current, submitting: true }));
    try {
      const publishName = state.preview?.skill?.name || skillName;
      await readApiPayload(
        await api.skillMarket.publishSkill(workspaceId, publishName, state.preview?.localContentHash),
        t('skillMarket.publishFailed', 'Failed to publish skill update.'),
      );
      setState((current) => ({
        ...current,
        submitting: false,
        success: true,
        confirmOpen: false,
        confirmation: '',
        preview: null,
      }));
      await notifyPublished('update', publishName);
      window.setTimeout(() => setState((current) => ({ ...current, success: false })), 2000);
    } catch (error) {
      const previewStale = error instanceof SkillMarketApiError && error.code === 'SKILL_PUBLISH_PREVIEW_STALE';
      const message = previewStale
        ? '技能文件在预览后发生了变化，请重新点击“发布更新”并确认最新差异。'
        : toErrorMessage(error, '发布更新失败。');
      setState((current) => ({
        ...current,
        submitting: false,
        success: false,
        ...(previewStale ? { confirmOpen: false, confirmation: '', preview: null } : {}),
      }));
      onError?.(message);
    }
  }, [notifyPublished, onError, skillName, state.confirmation, state.preview?.localContentHash, state.preview?.skill?.name, t, workspaceId]);

  if (!state.visible || !state.mode) return null;

  const buttonLabel = state.success
    ? '已发布'
    : state.submitting
      ? '发布中…'
      : state.mode === 'upload' ? '发布' : '发布更新';

  return (
    <>
      <button
        type="button"
        onClick={() => void handlePublish()}
        disabled={disabled || state.loading || state.submitting}
        className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-600 dark:hover:bg-emerald-500"
      >
        {state.success ? (
          <CheckCircle2 className="h-4 w-4" />
        ) : state.submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <UploadCloud className="h-4 w-4" />
        )}
        {buttonLabel}
      </button>

      {state.confirmOpen && state.preview ? (
        <PublishSkillDialog
          preview={state.preview}
          confirmation={state.confirmation}
          publishing={state.submitting}
          onConfirmationChange={(confirmation) => setState((current) => ({ ...current, confirmation }))}
          onCancel={() => setState((current) => ({ ...current, confirmOpen: false, confirmation: '', preview: null }))}
          onConfirm={() => void handleConfirmPublish()}
        />
      ) : null}

      {state.updateWarningOpen ? (
        <SkillUpdateRequiredDialog
          importedVersion={state.importedVersion}
          remoteVersion={state.remoteVersion}
          onClose={() => setState((current) => ({ ...current, updateWarningOpen: false }))}
        />
      ) : null}

    </>
  );
}

async function readApiPayload(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SkillMarketApiError(payload?.error || fallbackMessage, payload?.code, payload?.details);
  }
  return payload;
}

class SkillMarketApiError extends Error {
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SkillMarketApiError';
    this.code = code;
    this.details = details;
  }
}

function toErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function PublishSkillDialog({
  preview,
  confirmation,
  publishing,
  onConfirmationChange,
  onCancel,
  onConfirm,
}: {
  preview: MarketSkillPublishPreview;
  confirmation: string;
  publishing: boolean;
  onConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('codeEditor');
  const changes = preview.changes ?? [];
  const hasChanges = changes.length > 0;

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-7xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold text-foreground">{t('skillMarket.publishDialog.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('skillMarket.publishDialog.description')}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!hasChanges ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              {t('skillMarket.publishDialog.noChanges')}
            </div>
          ) : (
            <div className="grid gap-3">
              {changes.map((change) => <SideBySideFileDiff key={change.path} change={change} />)}
            </div>
          )}
        </div>

        <div className="border-t border-border p-4">
          <label className="block text-sm font-medium text-foreground" htmlFor="skill-publish-confirmation">
            {t('skillMarket.publishDialog.confirmLabel')}
          </label>
          <input
            id="skill-publish-confirmation"
            value={confirmation}
            onChange={(event) => onConfirmationChange(event.target.value)}
            disabled={publishing || !hasChanges}
            className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:opacity-50"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onCancel} disabled={publishing} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50">
              {t('skillMarket.publishDialog.cancel')}
            </button>
            <button type="button" onClick={onConfirm} disabled={publishing || !hasChanges || confirmation !== 'yes'} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50">
              {publishing ? t('actions.publishingSkill') : t('actions.publishSkill')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillUpdateRequiredDialog({
  importedVersion,
  remoteVersion,
  onClose,
}: {
  importedVersion: number | null;
  remoteVersion: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('codeEditor');

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold text-foreground">{t('skillMarket.updateRequiredDialog.title')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('skillMarket.updateRequiredDialog.description')}</p>
        </div>
        <div className="grid gap-2 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
            <span className="text-muted-foreground">{t('skillMarket.updateRequiredDialog.localVersion')}</span>
            <span className="font-mono text-foreground">{importedVersion ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
            <span className="text-muted-foreground">{t('skillMarket.updateRequiredDialog.remoteVersion')}</span>
            <span className="font-mono text-foreground">{remoteVersion ?? '-'}</span>
          </div>
        </div>
        <div className="flex justify-end border-t border-border p-4">
          <button type="button" onClick={onClose} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90">
            {t('skillMarket.updateRequiredDialog.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

type DiffTone = 'plain' | 'added' | 'removed' | 'modified' | 'blank';

type SideBySideDiffRow = {
  key: string;
  oldLineNumber: number | null;
  oldLine: string;
  oldTone: DiffTone;
  newLineNumber: number | null;
  newLine: string;
  newTone: DiffTone;
};

function SideBySideFileDiff({ change }: { change: MarketSkillPublishChange }) {
  const { t } = useTranslation('codeEditor');
  const rows = change.isBinary ? [] : createSideBySideDiffRows(change);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
        <span className="truncate font-mono text-xs text-foreground">{change.path}</span>
        <span className={getDiffStatusClassName(change.status)}>{t(`skillMarket.diff.status.${change.status}`)}</span>
      </div>
      {change.isBinary ? (
        <div className="bg-background px-3 py-4 text-sm text-muted-foreground">
          {t('skillMarket.diff.binaryFile', 'Binary file changed; text comparison is unavailable.')}
        </div>
      ) : (
        <div className="overflow-auto bg-background">
          <div className="min-w-[920px]">
            <div className="grid grid-cols-2 border-b border-border bg-muted/70 text-xs font-medium text-muted-foreground">
              <div className="border-r border-border px-3 py-2">{t('skillMarket.diff.currentRemote')}</div>
              <div className="px-3 py-2">{t('skillMarket.diff.localWorkspace')}</div>
            </div>
            <div className="font-mono text-xs leading-5">
              {rows.map((row) => (
                <div key={row.key} className="grid grid-cols-2">
                  <DiffCell border lineNumber={row.oldLineNumber} content={row.oldLine} tone={row.oldTone} />
                  <DiffCell lineNumber={row.newLineNumber} content={row.newLine} tone={row.newTone} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DiffCell({ lineNumber, content, tone, border = false }: { lineNumber: number | null; content: string; tone: DiffTone; border?: boolean }) {
  return (
    <div className={`grid grid-cols-[3.5rem_minmax(0,1fr)] ${border ? 'border-r border-border' : ''} ${getDiffToneClassName(tone)}`}>
      <div className="select-none border-r border-border/60 px-2 text-right text-muted-foreground">{lineNumber ?? ''}</div>
      <pre className="min-h-5 overflow-visible whitespace-pre px-3">{content || ' '}</pre>
    </div>
  );
}

function createSideBySideDiffRows(change: MarketSkillPublishChange): SideBySideDiffRow[] {
  const oldLines = splitLines(change.oldContent ?? '');
  const newLines = splitLines(change.newContent ?? '');

  if (change.status === 'added') {
    return newLines.map((line, index) => ({
      key: `added-${index}`,
      oldLineNumber: null,
      oldLine: '',
      oldTone: 'blank',
      newLineNumber: index + 1,
      newLine: line,
      newTone: 'added',
    }));
  }
  if (change.status === 'deleted') {
    return oldLines.map((line, index) => ({
      key: `deleted-${index}`,
      oldLineNumber: index + 1,
      oldLine: line,
      oldTone: 'removed',
      newLineNumber: null,
      newLine: '',
      newTone: 'blank',
    }));
  }

  return createModifiedSideBySideRows(oldLines, newLines);
}

function createModifiedSideBySideRows(oldLines: string[], newLines: string[]): SideBySideDiffRow[] {
  const chunks = createDiffChunks(oldLines, newLines);
  const rows: SideBySideDiffRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;
  let rowIndex = 0;

  chunks.forEach((chunk) => {
    if (chunk.type === 'equal') {
      chunk.oldLines.forEach((line) => {
        rows.push({
          key: `equal-${rowIndex}`,
          oldLineNumber,
          oldLine: line,
          oldTone: 'plain',
          newLineNumber,
          newLine: line,
          newTone: 'plain',
        });
        oldLineNumber += 1;
        newLineNumber += 1;
        rowIndex += 1;
      });
      return;
    }

    const count = Math.max(chunk.oldLines.length, chunk.newLines.length);
    for (let index = 0; index < count; index += 1) {
      const oldLine = chunk.oldLines[index];
      const newLine = chunk.newLines[index];
      const hasOldLine = oldLine !== undefined;
      const hasNewLine = newLine !== undefined;
      rows.push({
        key: `changed-${rowIndex}`,
        oldLineNumber: hasOldLine ? oldLineNumber : null,
        oldLine: oldLine ?? '',
        oldTone: hasOldLine ? 'modified' : 'blank',
        newLineNumber: hasNewLine ? newLineNumber : null,
        newLine: newLine ?? '',
        newTone: hasNewLine ? (hasOldLine ? 'modified' : 'added') : 'blank',
      });
      if (hasOldLine) oldLineNumber += 1;
      if (hasNewLine) newLineNumber += 1;
      rowIndex += 1;
    }
  });

  return rows;
}

function createDiffChunks(oldLines: string[], newLines: string[]) {
  const lcs = Array.from(
    { length: oldLines.length + 1 },
    () => Array.from({ length: newLines.length + 1 }, () => 0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lcs[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? lcs[oldIndex + 1][newIndex + 1] + 1
        : Math.max(lcs[oldIndex + 1][newIndex], lcs[oldIndex][newIndex + 1]);
    }
  }

  const chunks: Array<{ type: 'equal' | 'changed'; oldLines: string[]; newLines: string[] }> = [];
  let oldIndex = 0;
  let newIndex = 0;

  const pushChunk = (type: 'equal' | 'changed', oldLine: string | null, newLine: string | null) => {
    const lastChunk = chunks[chunks.length - 1];
    const chunk = lastChunk?.type === type ? lastChunk : { type, oldLines: [], newLines: [] };
    if (lastChunk !== chunk) chunks.push(chunk);
    if (oldLine !== null) chunk.oldLines.push(oldLine);
    if (newLine !== null) chunk.newLines.push(newLine);
  };

  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      pushChunk('equal', oldLines[oldIndex], newLines[newIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || lcs[oldIndex][newIndex + 1] >= lcs[oldIndex + 1][newIndex])) {
      pushChunk('changed', null, newLines[newIndex]);
      newIndex += 1;
    } else if (oldIndex < oldLines.length) {
      pushChunk('changed', oldLines[oldIndex], null);
      oldIndex += 1;
    }
  }

  return chunks;
}

function splitLines(content: string) {
  if (!content) return [];
  return content.replace(/\r\n/g, '\n').split('\n');
}

function getDiffStatusClassName(status: MarketSkillPublishChange['status']) {
  const baseClassName = 'rounded border px-2 py-0.5 text-xs uppercase';
  if (status === 'added') return `${baseClassName} border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300`;
  if (status === 'deleted') return `${baseClassName} border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300`;
  return `${baseClassName} border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300`;
}

function getDiffToneClassName(tone: DiffTone) {
  if (tone === 'added') return 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100';
  if (tone === 'removed' || tone === 'modified') return 'bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100';
  if (tone === 'blank') return 'bg-muted/30 text-muted-foreground';
  return 'bg-background';
}
