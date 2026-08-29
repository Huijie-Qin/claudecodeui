import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useCodeEditorDocument } from '../hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '../hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile } from '../types/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '../utils/editorExtensions';
import { getEditorStyles } from '../utils/editorStyles';
import { createEditorToolbarPanelExtension } from '../utils/editorToolbarPanel';
import { resolveWorkspaceSkillFileLink } from '../../../utils/skillMarkdownLinks';

import CodeEditorFooter from './subcomponents/CodeEditorFooter';
import CodeEditorHeader from './subcomponents/CodeEditorHeader';
import CodeEditorLoadingState from './subcomponents/CodeEditorLoadingState';
import CodeEditorSurface from './subcomponents/CodeEditorSurface';
import CodeEditorBinaryFile from './subcomponents/CodeEditorBinaryFile';

export type CodeEditorHandle = {
  save: () => Promise<boolean>;
};

type CodeEditorProps = {
  file: CodeEditorFile;
  onClose: () => void;
  projectPath?: string;
  isReadOnly?: boolean;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
  isActive?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  headerVariant?: 'default' | 'tabbed';
  onOpenFile?: (filePath: string) => void;
};

const AUTO_SAVE_DELAY_MS = 2000;

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({
  file,
  onClose,
  projectPath,
  isReadOnly = false,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
  isActive = true,
  onDirtyChange,
  headerVariant = 'default',
  onOpenFile,
}: CodeEditorProps, ref) {
  const { t } = useTranslation('codeEditor');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const contentRef = useRef('');
  const hasUnsavedChangesRef = useRef(false);
  const saveLatestRef = useRef<() => Promise<boolean>>(async () => true);
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
    loadError,
    isBinary,
    handleSave,
    handleDownload,
    reloadFile,
  } = useCodeEditorDocument({
    file,
    projectPath,
    isReadOnly,
    showLoadError: headerVariant === 'tabbed',
  });

  contentRef.current = content;
  hasUnsavedChangesRef.current = hasUnsavedChanges;

  const handleContentChange = useCallback((value: string) => {
    setContent(value);
    setHasUnsavedChanges(true);
  }, [setContent]);

  const saveLatestContent = useCallback(async () => {
    if (isReadOnly || !hasUnsavedChangesRef.current) {
      return true;
    }

    const contentBeingSaved = contentRef.current;
    const saved = await handleSave();

    if (saved && contentRef.current === contentBeingSaved) {
      hasUnsavedChangesRef.current = false;
      setHasUnsavedChanges(false);
    }

    return saved;
  }, [handleSave, isReadOnly]);

  saveLatestRef.current = saveLatestContent;

  useImperativeHandle(ref, () => ({ save: saveLatestContent }), [saveLatestContent]);

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);

  useEffect(() => {
    if (isReadOnly || !hasUnsavedChanges) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void saveLatestContent();
    }, AUTO_SAVE_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [content, hasUnsavedChanges, isReadOnly, saveLatestContent]);

  useEffect(() => () => {
    if (hasUnsavedChangesRef.current && !isReadOnly) {
      void saveLatestRef.current();
    }
  }, [isReadOnly]);

  const handleClose = useCallback(async () => {
    if (headerVariant === 'tabbed') {
      onClose();
      return;
    }
    const saved = await saveLatestContent();
    if (saved) {
      onClose();
    }
  }, [headerVariant, onClose, saveLatestContent]);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isHtmlFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  const previewMode = isMarkdownFile ? 'markdown' : isHtmlFile ? 'html' : null;

  const resolveMarkdownLink = useCallback(
    (href: string) => resolveWorkspaceSkillFileLink(href, file.path),
    [file.path],
  );

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
    onSave: saveLatestContent,
    onClose: handleClose,
    disableSave: isReadOnly,
    dependency: content,
    enabled: isActive,
  });

  useEffect(() => {
    setPreviewEnabled(previewMode === 'html');
  }, [file.path, previewMode]);

  if (loading) {
    return (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
  }

  if (loadError) {
    return (
      <div className={isSidebar
        ? 'flex h-full w-full items-center justify-center bg-background p-6'
        : 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4'}>
        <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-border bg-background p-6 text-center shadow-sm">
          <h3 className="text-sm font-semibold text-foreground">{t('loadError.title', 'Unable to open file')}</h3>
          <p className="break-all text-xs text-muted-foreground">{String(file.displayPath || file.path || '')}</p>
          <p className="text-xs text-red-600 dark:text-red-400">{loadError}</p>
          <div className="flex gap-2">
            <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent" onClick={reloadFile}>{t('actions.retry', 'Retry')}</button>
            <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent" onClick={onClose}>{t('actions.close')}</button>
          </div>
        </div>
      </div>
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
        hideHeader={headerVariant === 'tabbed'}
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
            previewMode={previewMode}
            previewEnabled={previewEnabled}
            saving={saving}
            saveSuccess={saveSuccess}
            onTogglePreview={() => setPreviewEnabled((previous) => !previous)}
            onOpenSettings={() => window.openSettings?.('appearance')}
            onDownload={handleDownload}
            onSave={saveLatestContent}
            isReadOnly={isReadOnly}
            onToggleFullscreen={() => setIsFullscreen((previous) => !previous)}
            onClose={() => void handleClose()}
            tabbed={headerVariant === 'tabbed'}
            labels={{
              showingChanges: t('header.showingChanges'),
              editMarkdown: t('actions.editMarkdown'),
              previewMarkdown: t('actions.previewMarkdown'),
              editHtml: t('actions.editHtml', 'Edit HTML'),
              previewHtml: t('actions.previewHtml', 'Preview HTML'),
              settings: t('toolbar.settings'),
              download: t('actions.download'),
              save: t('actions.save'),
              saving: t('actions.saving'),
              saved: t('actions.saved'),
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
          <div className="flex-1 overflow-hidden">
            <CodeEditorSurface
              content={content}
              onChange={handleContentChange}
              readOnly={isReadOnly}
              previewEnabled={previewEnabled}
              previewMode={previewMode}
              htmlPreviewTitle={t('actions.htmlPreviewTitle', 'HTML preview')}
              isDarkMode={isDarkMode}
              fontSize={fontSize}
              showLineNumbers={showLineNumbers}
              extensions={extensions}
              resolveMarkdownLink={resolveMarkdownLink}
              onOpenMarkdownLink={onOpenFile}
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

    </>
  );
});

CodeEditor.displayName = 'CodeEditor';

export default CodeEditor;
