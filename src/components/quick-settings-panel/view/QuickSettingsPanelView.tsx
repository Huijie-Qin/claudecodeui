import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useTheme } from '../../../contexts/ThemeContext';
import { useQuickSettingsDrag } from '../hooks/useQuickSettingsDrag';
import type { PreferenceToggleKey, QuickSettingsPreferences } from '../types';

import QuickSettingsContent from './QuickSettingsContent';
import QuickSettingsHandle from './QuickSettingsHandle';
import QuickSettingsPanelHeader from './QuickSettingsPanelHeader';

type QuickSettingsPanelViewProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export default function QuickSettingsPanelView({
  open,
  onOpenChange,
}: QuickSettingsPanelViewProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const handleButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  const { isDarkMode } = useTheme();
  const { preferences, setPreference } = useUiPreferences();
  const {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  } = useQuickSettingsDrag({ isMobile });

  const quickSettingsPreferences = useMemo<QuickSettingsPreferences>(() => ({
    hideToolMessages: preferences.hideToolMessages,
    autoExpandTools: preferences.autoExpandTools,
    showRawParameters: preferences.showRawParameters,
    showThinking: preferences.showThinking,
    autoScrollToBottom: preferences.autoScrollToBottom,
    sendByCtrlEnter: preferences.sendByCtrlEnter,
  }), [
    preferences.hideToolMessages,
    preferences.autoExpandTools,
    preferences.autoScrollToBottom,
    preferences.sendByCtrlEnter,
    preferences.showRawParameters,
    preferences.showThinking,
  ]);

  const handlePreferenceChange = useCallback(
    (key: PreferenceToggleKey, value: boolean) => {
      setPreference(key, value);
    },
    [setPreference],
  );

  const setOpen = useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  const handleToggleFromHandle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // A drag releases a click event as well; this guard prevents accidental toggles.
      if (consumeSuppressedClick()) {
        event.preventDefault();
        return;
      }

      setOpen(!isOpen);
    },
    [consumeSuppressedClick, isOpen, setOpen],
  );

  useEffect(() => {
    if (isOpen) return;
    const activeElement = document.activeElement;
    if (activeElement && panelRef.current?.contains(activeElement)) {
      handleButtonRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <>
      <QuickSettingsHandle
        buttonRef={handleButtonRef}
        isOpen={isOpen}
        isDragging={isDragging}
        style={handleStyle}
        onClick={handleToggleFromHandle}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
      />

      <div
        ref={panelRef}
        aria-hidden={!isOpen}
        className={`fixed right-0 top-0 z-40 h-full w-64 transform border-l border-border bg-background shadow-xl transition-transform duration-150 ease-out ${isOpen ? 'visible translate-x-0' : 'pointer-events-none invisible translate-x-full'} ${isMobile ? 'h-screen' : ''}`}
      >
        <div className="flex h-full flex-col">
          <QuickSettingsPanelHeader />
          <QuickSettingsContent
            isDarkMode={isDarkMode}
            preferences={quickSettingsPreferences}
            onPreferenceChange={handlePreferenceChange}
          />
        </div>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setOpen(false)}
        />
      )}
    </>
  );
}
