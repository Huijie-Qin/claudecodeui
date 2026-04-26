import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  disableSave?: boolean;
  dependency: string;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  disableSave = false,
  dependency,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!disableSave) {
          onSave();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, disableSave, onClose, onSave]);
};
