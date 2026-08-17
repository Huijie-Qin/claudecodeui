import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';

const DEFAULT_PANEL_WIDTH = 420;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 640;
const MIN_CHAT_WIDTH = 480;
const MIN_DOCKED_LAYOUT_WIDTH = 960;
const STORAGE_KEY = 'subagent-panel-width';

const clampPanelWidth = (value: number, containerWidth = Number.POSITIVE_INFINITY) => {
  const availableWidth = Number.isFinite(containerWidth)
    ? Math.max(MIN_PANEL_WIDTH, containerWidth - MIN_CHAT_WIDTH)
    : MAX_PANEL_WIDTH;
  return Math.min(Math.max(value, MIN_PANEL_WIDTH), MAX_PANEL_WIDTH, availableWidth);
};

const readStoredPanelWidth = () => {
  if (typeof window === 'undefined') return DEFAULT_PANEL_WIDTH;
  try {
    const rawStoredWidth = window.localStorage.getItem(STORAGE_KEY);
    if (rawStoredWidth === null) return DEFAULT_PANEL_WIDTH;
    const storedWidth = Number(rawStoredWidth);
    return Number.isFinite(storedWidth)
      ? clampPanelWidth(storedWidth)
      : DEFAULT_PANEL_WIDTH;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
};

export interface SubagentPanelLayout {
  containerRef: RefObject<HTMLDivElement>;
  panelWidth: number;
  panelMinWidth: number;
  panelMaxWidth: number;
  isDocked: boolean;
  isResizing: boolean;
  handleResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handleResizeKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function useSubagentPanelLayout(isOpen: boolean): SubagentPanelLayout {
  const containerRef = useRef<HTMLDivElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [containerWidth, setContainerWidth] = useState(() => (
    typeof window === 'undefined' ? 0 : window.innerWidth
  ));
  const [panelWidth, setPanelWidth] = useState(readStoredPanelWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    const updateWidth = () => setContainerWidth(node.getBoundingClientRect().width);
    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const effectivePanelWidth = clampPanelWidth(panelWidth, containerWidth);
  const isDocked = Boolean(
    isOpen &&
    containerWidth >= MIN_DOCKED_LAYOUT_WIDTH &&
    containerWidth - effectivePanelWidth >= MIN_CHAT_WIDTH,
  );

  useEffect(() => {
    if (!isDocked || containerWidth <= 0) return;
    setPanelWidth((current) => clampPanelWidth(current, containerWidth));
  }, [containerWidth, isDocked]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Math.round(panelWidth)));
    } catch {
      // Storage can be disabled; resizing should still work for this session.
    }
  }, [panelWidth]);

  const handleResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isDocked || event.button !== 0) return;
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
    event.preventDefault();
  }, [isDocked]);

  const panelMaxWidth = Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, containerWidth - MIN_CHAT_WIDTH),
  );

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isDocked) return;
    const resizeStep = event.shiftKey ? 48 : 16;
    let nextWidth: number | undefined;

    if (event.key === 'ArrowLeft') {
      nextWidth = panelWidth + resizeStep;
    } else if (event.key === 'ArrowRight') {
      nextWidth = panelWidth - resizeStep;
    } else if (event.key === 'Home') {
      nextWidth = MIN_PANEL_WIDTH;
    } else if (event.key === 'End') {
      nextWidth = panelMaxWidth;
    }

    if (nextWidth === undefined) return;
    event.preventDefault();
    setPanelWidth(clampPanelWidth(nextWidth, containerWidth));
  }, [containerWidth, isDocked, panelMaxWidth, panelWidth]);

  useEffect(() => {
    if (!isResizing) return undefined;

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setPanelWidth(clampPanelWidth(rect.right - event.clientX, rect.width));
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current) return;
      activePointerIdRef.current = null;
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [isResizing]);

  return {
    containerRef,
    panelWidth: isDocked ? effectivePanelWidth : panelWidth,
    panelMinWidth: MIN_PANEL_WIDTH,
    panelMaxWidth,
    isDocked,
    isResizing,
    handleResizeStart,
    handleResizeKeyDown,
  };
}
