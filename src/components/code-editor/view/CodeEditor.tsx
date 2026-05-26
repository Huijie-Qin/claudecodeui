import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';
import { api } from '../../../utils/api';

import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isReadOnly?: boolean;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

type MarketSkillPublishChange = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldContent?: string;
  newContent?: string;
};

type MarketSkillPublishPreview = {
  skill?: {
    name?: string;
    displayName?: string;
    version?: number;
  };
  changes: MarketSkillPublishChange[];
};

type MarketSkillSubmitState = {
  skillName: string | null;
  mode: 'update' | 'upload' | null;
  visible: boolean;
  updateAvailable: boolean;
  importedVersion: number | null;
  remoteVersion: number | null;
  loading: boolean;
  submitting: boolean;
  success: boolean;
  error: string | null;
  confirmOpen: boolean;
  updateWarningOpen: boolean;
  confirmation: string;
  preview: MarketSkillPublishPreview | null;
};

export default function CodeEditor({
  file,
  onClose,
  projectPath,
  isReadOnly = false,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const marketSkillName = useMemo(() => getImportedSkillNameFromPath(file.path), [file.path]);
  const [marketSkillSubmit, setMarketSkillSubmit] = useState<MarketSkillSubmitState>({
    skillName: null,
    mode: null,
    visible: false,
    updateAvailable: false,
    importedVersion: null,
    remoteVersion: null,
    loading: false,
    submitting: false,
    success: false,
    error: null,
    confirmOpen: false,
    updateWarningOpen: false,
    confirmation: '',
    preview: null,
  });

  const {
    isDarkMode,
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    handleSave,
    handleDownload,
  } = useCodeEditorDocument({
    file,
    projectPath,
    isReadOnly,
  });

  useEffect(() => {
    let cancelled = false;

    if (!marketSkillName || !file.workspaceId || isReadOnly) {
      setMarketSkillSubmit({
        skillName: marketSkillName,
        mode: null,
        visible: false,
        updateAvailable: false,
        importedVersion: null,
        remoteVersion: null,
        loading: false,
        submitting: false,
        success: false,
        error: null,
        confirmOpen: false,
        updateWarningOpen: false,
        confirmation: '',
        preview: null,
      });
      return () => {
        cancelled = true;
      };
    }

    setMarketSkillSubmit({
      skillName: marketSkillName,
      mode: null,
      visible: false,
      updateAvailable: false,
      importedVersion: null,
      remoteVersion: null,
      loading: true,
      submitting: false,
      success: false,
      error: null,
      confirmOpen: false,
      updateWarningOpen: false,
      confirmation: '',
      preview: null,
    });

    api.skillMarket.publishState(file.workspaceId, marketSkillName)
      .then(async (response) => {
        const payload = await readApiPayload(response, t('skillMarket.loadFailed', 'Failed to load skill status.'));
        if (cancelled) return;
        const canUploadAndPublish = payload.canManage !== false && payload.skill?.canUploadAndPublish === true;
        const canPublishUpdate = payload.canManage !== false && payload.skill?.imported === true && payload.skill?.canPublish === true;
        setMarketSkillSubmit({
          skillName: marketSkillName,
          mode: canUploadAndPublish ? 'upload' : canPublishUpdate ? 'update' : null,
          visible: canUploadAndPublish || canPublishUpdate,
          updateAvailable: payload.skill?.updateAvailable === true,
          importedVersion: typeof payload.skill?.importedVersion === 'number' ? payload.skill.importedVersion : null,
          remoteVersion: typeof payload.skill?.version === 'number' ? payload.skill.version : null,
          loading: false,
          submitting: false,
          success: false,
          error: null,
          confirmOpen: false,
          updateWarningOpen: false,
          confirmation: '',
          preview: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Unable to load skill market status for editor file:', error);
        setMarketSkillSubmit({
          skillName: marketSkillName,
          mode: null,
          visible: false,
          updateAvailable: false,
          importedVersion: null,
          remoteVersion: null,
          loading: false,
          submitting: false,
          success: false,
          error: null,
          confirmOpen: false,
          updateWarningOpen: false,
          confirmation: '',
          preview: null,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [file.workspaceId, isReadOnly, marketSkillName, t]);

  const handleSubmitMarketSkill = useCallback(async () => {
    if (!marketSkillName || !file.workspaceId || isReadOnly) return;

    if (marketSkillSubmit.mode === 'update' && marketSkillSubmit.updateAvailable) {
      setMarketSkillSubmit((current) => ({
        ...current,
        success: false,
        error: null,
        updateWarningOpen: true,
        confirmation: '',
        preview: null,
      }));
      return;
    }

    setMarketSkillSubmit((current) => ({
      ...current,
      submitting: true,
      success: false,
      error: null,
      confirmation: '',
      preview: null,
    }));

    const saved = await handleSave();
    if (!saved) {
      setMarketSkillSubmit((current) => ({
        ...current,
        submitting: false,
        error: t('skillMarket.saveBeforeSubmitFailed', 'Current file save failed. Skill update was not published.'),
      }));
      return;
    }

    try {
      if (marketSkillSubmit.mode === 'upload') {
        await readApiPayload(
          await api.skillMarket.uploadAndPublishSkill(file.workspaceId, marketSkillName),
          t('skillMarket.uploadPublishFailed', 'Failed to upload and publish skill.'),
        );
        setMarketSkillSubmit((current) => ({
          ...current,
          mode: 'update',
          submitting: false,
          success: true,
          error: null,
          confirmOpen: false,
          confirmation: '',
          preview: null,
        }));
        window.setTimeout(() => {
          setMarketSkillSubmit((current) => ({
            ...current,
            success: false,
          }));
        }, 2000);
        return;
      }

      const payload = await readApiPayload(
        await api.skillMarket.publishPreview(file.workspaceId, marketSkillName),
        t('skillMarket.previewFailed', 'Failed to load skill update diff.'),
      );
      setMarketSkillSubmit((current) => ({
        ...current,
        submitting: false,
        success: false,
        error: null,
        confirmOpen: true,
        confirmation: '',
        preview: payload as MarketSkillPublishPreview,
      }));
    } catch (error) {
      setMarketSkillSubmit((current) => ({
        ...current,
        submitting: false,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [file.workspaceId, handleSave, isReadOnly, marketSkillName, marketSkillSubmit.mode, marketSkillSubmit.updateAvailable, t]);

  const handleConfirmPublishMarketSkill = useCallback(async () => {
    if (!marketSkillName || !file.workspaceId || marketSkillSubmit.confirmation !== 'yes') return;

    setMarketSkillSubmit((current) => ({
      ...current,
      submitting: true,
      error: null,
    }));

    try {
      await readApiPayload(
        await api.skillMarket.publishSkill(file.workspaceId, marketSkillName),
        t('skillMarket.publishFailed', 'Failed to publish skill update.'),
      );
      setMarketSkillSubmit((current) => ({
        ...current,
        submitting: false,
        success: true,
        error: null,
        confirmOpen: false,
        confirmation: '',
        preview: null,
      }));
      window.setTimeout(() => {
        setMarketSkillSubmit((current) => ({
          ...current,
          success: false,
        }));
      }, 2000);
    } catch (error) {
      setMarketSkillSubmit((current) => ({
        ...current,
        submitting: false,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [file.workspaceId, marketSkillName, marketSkillSubmit.confirmation, t]);

  const handleClosePublishDialog = useCallback(() => {
    setMarketSkillSubmit((current) => ({
      ...current,
      confirmOpen: false,
      confirmation: '',
      preview: null,
    }));
  }, []);

  const handleCloseUpdateWarningDialog = useCallback(() => {
    setMarketSkillSubmit((current) => ({
      ...current,
      updateWarningOpen: false,
    }));
  }, []);

  const handlePublishConfirmationChange = useCallback((value: string) => {
    setMarketSkillSubmit((current) => ({
      ...current,
      confirmation: value,
    }));
  }, []);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        isSidebar,
        isExpanded,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        onPopOut,
        onToggleExpand,
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
          collapse: t('toolbar.collapse'),
          expand: t('toolbar.expand'),
        },
      })
    ),
    [file, isExpanded, isSidebar, onPopOut, onToggleExpand, showDiff, t],
  );

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...getLanguageExtensions(file.name),
      ...toolbarPanelExtension,
    ];

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    file.diffInfo,
    file.name,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    onClose,
    disableSave: isReadOnly,
    dependency: content,
  });

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  if (isBinary) {
    return (
      <CodeEditorBinaryFile
        file={file}
        isSidebar={isSidebar}
        isFullscreen={isFullscreen}
        onClose={onClose}
        onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
        title={t('binaryFile.title', 'Binary File')}
        message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
      />
    );
  }

  const outerContainerClassName = isSidebar
    ? 'w-full h-full flex flex-col'
    : `fixed inset-0 z-[9999] md:bg-black/50 md:flex md:items-center md:justify-center md:p-4 ${isFullscreen ? 'md:p-0' : ''}`;

  const innerContainerClassName = isSidebar
    ? 'bg-background flex flex-col w-full h-full'
    : `bg-background shadow-2xl flex flex-col w-full h-full md:rounded-lg md:shadow-2xl${
      isFullscreen ? ' md:w-full md:h-full md:rounded-none' : ' md:w-full md:max-w-6xl md:h-[80vh] md:max-h-[80vh]'
    }`;

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <div className={outerContainerClassName}>
        <div className={innerContainerClassName}>
          <CodeEditorHeader
            file={file}
            isSidebar={isSidebar}
            isFullscreen={isFullscreen}
            isMarkdownFile={isMarkdownFile}
            markdownPreview={markdownPreview}
            saving={saving}
            saveSuccess={saveSuccess}
            onToggleMarkdownPreview={() => setMarkdownPreview((previous) => !previous)}
            onOpenSettings={() => window.openSettings?.('appearance')}
            onDownload={handleDownload}
            onSave={handleSave}
            onSubmitSkill={marketSkillSubmit.visible ? handleSubmitMarketSkill : undefined}
            isReadOnly={isReadOnly}
            skillSubmitting={marketSkillSubmit.submitting}
            skillSubmitSuccess={marketSkillSubmit.success}
            skillSubmitDisabled={saving || marketSkillSubmit.loading}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={onClose}
            labels={{
              showingChanges: t('header.showingChanges'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
              submitSkill: marketSkillSubmit.mode === 'upload'
                ? t('actions.uploadAndPublishSkill', 'Upload and Publish')
                : t('actions.publishSkill', 'Publish Update'),
              submittingSkill: marketSkillSubmit.mode === 'upload'
                ? t('actions.uploadingAndPublishingSkill', 'Uploading...')
                : t('actions.publishingSkill', 'Publishing...'),
              skillSubmitted: marketSkillSubmit.mode === 'upload'
                ? t('actions.skillUploadedAndPublished', 'Skill Published')
                : t('actions.skillPublished', 'Skill Published'),
              fullscreen: t('actions.fullscreen'),
              exitFullscreen: t('actions.exitFullscreen'),
              close: t('actions.close'),
            }}
          />

          {saveError && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {saveError}
            </div>
          )}
          {marketSkillSubmit.error && (
            <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
              {marketSkillSubmit.error}
            </div>
          )}

          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={setContent}
              readOnly={isReadOnly}
              markdownPreview={markdownPreview}
              isMarkdownFile={isMarkdownFile}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
            />
          </div>

          <CodeEditorFooter
            content={content}
            linesLabel={t('footer.lines')}
            charactersLabel={t('footer.characters')}
            shortcutsLabel={t('footer.shortcuts')}
          />
        </div>
      </div>

      {marketSkillSubmit.confirmOpen && marketSkillSubmit.preview ? (
        <PublishSkillDialog
          preview={marketSkillSubmit.preview}
          confirmation={marketSkillSubmit.confirmation}
          publishing={marketSkillSubmit.submitting}
          onConfirmationChange={handlePublishConfirmationChange}
          onCancel={handleClosePublishDialog}
          onConfirm={() => void handleConfirmPublishMarketSkill()}
        />
      ) : null}

      {marketSkillSubmit.updateWarningOpen ? (
        <SkillUpdateRequiredDialog
          importedVersion={marketSkillSubmit.importedVersion}
          remoteVersion={marketSkillSubmit.remoteVersion}
          onClose={handleCloseUpdateWarningDialog}
        />
      ) : null}
    </>
  );
}

function getImportedSkillNameFromPath(filePath: string) {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const claudeIndex = parts.findIndex((part, index) => (
    part === '.claude' && parts[index + 1] === 'skills'
  ));

  if (claudeIndex === -1 || !parts[claudeIndex + 2] || parts.length < claudeIndex + 4) {
    return null;
  }

  return parts[claudeIndex + 2];
}

async function readApiPayload(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }
  return payload;
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
          <p className="mt-1 text-sm text-muted-foreground">
            {t('skillMarket.publishDialog.description')}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!hasChanges ? (
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              {t('skillMarket.publishDialog.noChanges')}
            </div>
          ) : (
            <div className="grid gap-3">
              {changes.map((change) => (
                <SideBySideFileDiff key={change.path} change={change} />
              ))}
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
            <button
              type="button"
              onClick={onCancel}
              disabled={publishing}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
            >
              {t('skillMarket.publishDialog.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={publishing || !hasChanges || confirmation !== 'yes'}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
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
          <p className="mt-1 text-sm text-muted-foreground">
            {t('skillMarket.updateRequiredDialog.description')}
          </p>
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          >
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
  const rows = createSideBySideDiffRows(change);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
        <span className="truncate font-mono text-xs text-foreground">{change.path}</span>
        <span className={getDiffStatusClassName(change.status)}>
          {t(`skillMarket.diff.status.${change.status}`)}
        </span>
      </div>
      <div className="overflow-auto bg-background">
        <div className="min-w-[920px]">
          <div className="grid grid-cols-2 border-b border-border bg-muted/70 text-xs font-medium text-muted-foreground">
            <div className="border-r border-border px-3 py-2">{t('skillMarket.diff.currentRemote')}</div>
            <div className="px-3 py-2">{t('skillMarket.diff.localWorkspace')}</div>
          </div>
          <div className="font-mono text-xs leading-5">
            {rows.map((row) => (
              <div key={row.key} className="grid grid-cols-2">
                <DiffCell
                  border
                  lineNumber={row.oldLineNumber}
                  content={row.oldLine}
                  tone={row.oldTone}
                />
                <DiffCell
                  lineNumber={row.newLineNumber}
                  content={row.newLine}
                  tone={row.newTone}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffCell({
  lineNumber,
  content,
  tone,
  border = false,
}: {
  lineNumber: number | null;
  content: string;
  tone: DiffTone;
  border?: boolean;
}) {
  return (
    <div className={`grid grid-cols-[3.5rem_minmax(0,1fr)] ${border ? 'border-r border-border' : ''} ${getDiffToneClassName(tone)}`}>
      <div className="select-none border-r border-border/60 px-2 text-right text-muted-foreground">
        {lineNumber ?? ''}
      </div>
      <pre className="min-h-5 overflow-visible whitespace-pre px-3">
        {content || ' '}
      </pre>
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
    const chunk = lastChunk?.type === type
      ? lastChunk
      : { type, oldLines: [], newLines: [] };
    if (lastChunk !== chunk) {
      chunks.push(chunk);
    }
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
  if (status === 'added') {
    return `${baseClassName} border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300`;
  }
  if (status === 'deleted') {
    return `${baseClassName} border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300`;
  }
  return `${baseClassName} border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300`;
}

function getDiffToneClassName(tone: DiffTone) {
  if (tone === 'added') {
    return 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100';
  }
  if (tone === 'removed' || tone === 'modified') {
    return 'bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100';
  }
  if (tone === 'blank') {
    return 'bg-muted/30 text-muted-foreground';
  }
  return 'bg-background';
}
