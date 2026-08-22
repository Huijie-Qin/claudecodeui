import { useCallback, useEffect, useState } from 'react';

import { dispatchSlashCommandsChangedForPath } from '../../chat/utils/slashCommandEvents';
import { api } from '../../../utils/api';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
  isReadOnly?: boolean;
  showLoadError?: boolean;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({
  file,
  projectPath,
  isReadOnly = false,
  showLoadError = false,
}: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const fileProjectName = file.projectName ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;

  useEffect(() => {
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        setLoadError(null);

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectName) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectName, filePath, file.workspaceId);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setContent(data.content);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        if (showLoadError) {
          setContent('');
          setLoadError(message);
        } else {
          setContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
        }
      } finally {
        setLoading(false);
      }
    };

    loadFileContent();
  }, [file.diffInfo, file.name, file.workspaceId, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectName, reloadToken, showLoadError]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);

    try {
      if (isReadOnly) {
        throw new Error('Workspace is read-only');
      }

      if (!fileProjectName) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectName, filePath, content, file.workspaceId);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      setSaveSuccess(true);
      dispatchSlashCommandsChangedForPath(filePath, {
        workspaceId: file.workspaceId,
      });
      window.dispatchEvent(new CustomEvent('cloudcli:file-saved', {
        detail: {
          workspaceId: file.workspaceId,
          projectName: fileProjectName,
          path: filePath,
        },
      }));
      setTimeout(() => setSaveSuccess(false), 2000);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [content, file.workspaceId, filePath, fileProjectName, isReadOnly]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
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
    reloadFile: () => setReloadToken((current) => current + 1),
  };
};
