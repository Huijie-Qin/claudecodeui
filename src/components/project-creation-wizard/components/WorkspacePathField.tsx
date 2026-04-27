import { useCallback, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../shared/view/ui';
import { browseFilesystemFolders } from '../data/workspaceApi';
import { getSuggestionRootPath, shouldUseFilesystemPicker } from '../utils/pathUtils';
import type { FolderSuggestion, WorkspaceType } from '../types';

import FolderBrowserModal from './FolderBrowserModal';

type WorkspacePathFieldProps = {
  workspaceType: WorkspaceType;
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  onAdvanceToConfirm: () => void;
};

export default function WorkspacePathField({
  workspaceType,
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
}: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  const [pathSuggestions, setPathSuggestions] = useState<FolderSuggestion[]>([]);
  const [showPathDropdown, setShowPathDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const allowFilesystemPicker = shouldUseFilesystemPicker(workspaceType);

  useEffect(() => {
    if (!allowFilesystemPicker) {
      setPathSuggestions([]);
      setShowPathDropdown(false);
      return;
    }

    if (value.trim().length <= 2) {
      setPathSuggestions([]);
      setShowPathDropdown(false);
      return;
    }

    // Debounce path lookup to avoid firing a request for every keystroke.
    const timerId = window.setTimeout(async () => {
      try {
        const directoryPath = getSuggestionRootPath(value);
        const result = await browseFilesystemFolders(directoryPath);
        const normalizedInput = value.toLowerCase();

        const matchingSuggestions = result.suggestions
          .filter((suggestion) => {
            const normalizedSuggestion = suggestion.path.toLowerCase();
            return (
              normalizedSuggestion.startsWith(normalizedInput) &&
              normalizedSuggestion !== normalizedInput
            );
          })
          .slice(0, 5);

        setPathSuggestions(matchingSuggestions);
        setShowPathDropdown(matchingSuggestions.length > 0);
      } catch (error) {
        console.error('Failed to load path suggestions:', error);
      }
    }, 200);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [allowFilesystemPicker, value]);

  const handleSuggestionSelect = useCallback(
    (suggestion: FolderSuggestion) => {
      onChange(suggestion.path);
      setShowPathDropdown(false);
    },
    [onChange],
  );

  const handleFolderSelected = useCallback(
    (selectedPath: string, advanceToConfirm: boolean) => {
      onChange(selectedPath);
      setShowFolderBrowser(false);
      if (advanceToConfirm) {
        onAdvanceToConfirm();
      }
    },
    [onAdvanceToConfirm, onChange],
  );

  return (
    <>
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Input
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={
              workspaceType === 'existing'
                ? t('projectWizard.step2.existingPlaceholder', {
                    defaultValue: '/path/to/existing/workspace',
                  })
                : t('projectWizard.step2.newPlaceholder', { defaultValue: 'my-workspace' })
            }
            className="w-full"
            disabled={disabled}
          />

          {showPathDropdown && pathSuggestions.length > 0 && (
            <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
              {pathSuggestions.map((suggestion) => (
                <button
                  key={suggestion.path}
                  onClick={() => handleSuggestionSelect(suggestion)}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <div className="font-medium text-gray-900 dark:text-white">{suggestion.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{suggestion.path}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {allowFilesystemPicker && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowFolderBrowser(true)}
            className="px-3"
            title="Browse folders"
            disabled={disabled}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        )}
      </div>

      {allowFilesystemPicker && (
        <FolderBrowserModal
          isOpen={showFolderBrowser}
          autoAdvanceOnSelect={workspaceType === 'existing'}
          allowCreateFolder={workspaceType === 'existing'}
          onClose={() => setShowFolderBrowser(false)}
          onFolderSelected={handleFolderSelected}
        />
      )}
    </>
  );
}
