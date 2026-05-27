import { Code2, Download, Eye, Maximize2, Minimize2, Save, Settings as SettingsIcon, UploadCloud, X } from 'lucide-react';

import type { CodeEditorFile } from '../../types/types';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  isSidebar: boolean;
  isFullscreen: boolean;
  isMarkdownFile: boolean;
  markdownPreview: boolean;
  saving: boolean;
  saveSuccess: boolean;
  isReadOnly?: boolean;
  skillSubmitting?: boolean;
  skillSubmitSuccess?: boolean;
  skillSubmitDisabled?: boolean;
  onToggleMarkdownPreview: () => void;
  onOpenSettings: () => void;
  onDownload: () => void;
  onSave: () => void;
  onSubmitSkill?: () => void;
  onToggleFullscreen: () => void;
  onClose: () => void;
  labels: {
    showingChanges: string;
    editMarkdown: string;
    previewMarkdown: string;
    settings: string;
    download: string;
    save: string;
    saving: string;
    saved: string;
    submitSkill: string;
    submittingSkill: string;
    skillSubmitted: string;
    fullscreen: string;
    exitFullscreen: string;
    close: string;
  };
};

export default function CodeEditorHeader({
  file,
  isSidebar,
  isFullscreen,
  isMarkdownFile,
  markdownPreview,
  saving,
  saveSuccess,
  isReadOnly = false,
  skillSubmitting = false,
  skillSubmitSuccess = false,
  skillSubmitDisabled = false,
  onToggleMarkdownPreview,
  onOpenSettings,
  onDownload,
  onSave,
  onSubmitSkill,
  onToggleFullscreen,
  onClose,
  labels,
}: CodeEditorHeaderProps) {
  const saveTitle = isReadOnly ? 'Read-only' : saveSuccess ? labels.saved : saving ? labels.saving : labels.save;
  const submitSkillTitle = skillSubmitSuccess
    ? labels.skillSubmitted
    : skillSubmitting
      ? labels.submittingSkill
      : labels.submitSkill;

  const displayedPath = (() => {
    const normalizedPath = String(file.displayPath || file.path || '')
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trim()
      .replace(/\/+$/g, '');

    if (!normalizedPath) {
      return '/';
    }
    if (normalizedPath === '/workspace') {
      return '/workspace';
    }
    if (normalizedPath.startsWith('/workspace/')) {
      return normalizedPath;
    }

    const pathParts = normalizedPath.split('/').filter(Boolean);

    const workspacesIndex = pathParts.lastIndexOf('workspaces');
    if (workspacesIndex !== -1 && pathParts.length > workspacesIndex + 3) {
      const suffix = pathParts.slice(workspacesIndex + 4).join('/');
      return suffix ? `/workspace/${suffix}` : '/workspace';
    }

    const claudeIndex = pathParts.lastIndexOf('.claude');
    if (claudeIndex !== -1 && pathParts.length > claudeIndex) {
      return `/workspace/${pathParts.slice(claudeIndex).join('/')}`;
    }

    if (file.projectName && pathParts.includes(file.projectName)) {
      const workspaceIndex = pathParts.lastIndexOf(file.projectName);
      if (workspaceIndex !== -1 && pathParts.length > workspaceIndex) {
        const suffix = pathParts.slice(workspaceIndex + 1).join('/');
        return suffix ? `/workspace/${suffix}` : '/workspace';
      }
    }

    if (!normalizedPath.startsWith('/')) {
      return `/workspace/${normalizedPath}`;
    }

    return normalizedPath;
  })();

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
      {/* File info - can shrink */}
      <div className="flex min-w-0 flex-1 shrink items-center gap-2">
        <div className="min-w-0 shrink">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-medium text-gray-900 dark:text-white">{file.name}</h3>
            {file.diffInfo && (
              <span className="shrink-0 whitespace-nowrap rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900 dark:text-blue-300">
                {labels.showingChanges}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-gray-500 dark:text-gray-400">
            {displayedPath}
          </p>
        </div>
      </div>

      {/* Buttons - don't shrink, always visible */}
      <div className="flex shrink-0 items-center gap-0.5">
        {isMarkdownFile && (
          <button
            type="button"
            onClick={onToggleMarkdownPreview}
            className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
              markdownPreview
                ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
            }`}
            title={markdownPreview ? labels.editMarkdown : labels.previewMarkdown}
          >
            {markdownPreview ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          title={labels.settings}
        >
          <SettingsIcon className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onDownload}
          className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          title={labels.download}
        >
          <Download className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={onSave}
          disabled={saving || isReadOnly}
          className={`flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-50 ${
            saveSuccess
              ? 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400'
              : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
          }`}
          title={saveTitle}
        >
          {saveSuccess ? (
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <Save className="h-4 w-4" />
          )}
        </button>

        {onSubmitSkill ? (
          <button
            type="button"
            onClick={onSubmitSkill}
            disabled={skillSubmitting || skillSubmitDisabled || isReadOnly}
            className={`flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:opacity-50 ${
              skillSubmitSuccess
                ? 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
            }`}
            title={submitSkillTitle}
          >
            {skillSubmitSuccess ? (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <UploadCloud className={`h-4 w-4 ${skillSubmitting ? 'animate-pulse' : ''}`} />
            )}
            <span>{submitSkillTitle}</span>
          </button>
        ) : null}

        {!isSidebar && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
            title={isFullscreen ? labels.exitFullscreen : labels.fullscreen}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}

        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
          title={labels.close}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
