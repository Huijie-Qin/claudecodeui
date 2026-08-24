import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export const DATA_AGENT_FILES_PANE_RATIO_KEY = 'data-agent-files-pane-ratio';
export const MIN_FILE_PANE_WIDTH = 400;
export const MIN_EDITOR_PANE_WIDTH = 320;
export const MAX_FILE_PANE_WIDTH = 960;
export const FILES_RESIZER_WIDTH = 5;

export function parseStoredFilePaneRatio(rawValue: string | null): number | null {
  if (!rawValue) return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0.15 && parsed <= 0.8 ? parsed : null;
}

export function resolveFilePaneWidth(containerWidth: number, viewportWidth: number, ratio: number | null): number {
  if (containerWidth <= 0) return 0;
  const maxWidth = Math.max(0, Math.min(MAX_FILE_PANE_WIDTH, containerWidth - MIN_EDITOR_PANE_WIDTH - FILES_RESIZER_WIDTH));
  const minWidth = Math.min(MIN_FILE_PANE_WIDTH, maxWidth);
  const preferredWidth = ratio == null ? viewportWidth * 0.32 : containerWidth * ratio;
  return Math.round(Math.min(maxWidth, Math.max(minWidth, preferredWidth)));
}

export function useDataAgentFilesSplit() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [ratio, setRatio] = useState<number | null>(() => {
    try {
      return parseStoredFilePaneRatio(localStorage.getItem(DATA_AGENT_FILES_PANE_RATIO_KEY));
    } catch {
      return null;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const activePointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const updateWidth = () => setContainerWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (ratio == null) return;
    try {
      localStorage.setItem(DATA_AGENT_FILES_PANE_RATIO_KEY, String(ratio));
    } catch {
      // Keep the runtime ratio when storage is unavailable.
    }
  }, [ratio]);

  const paneWidth = useMemo(
    () => resolveFilePaneWidth(containerWidth, window.innerWidth, ratio),
    [containerWidth, ratio],
  );

  const onResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    activePointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
    event.preventDefault();
  }, []);

  useEffect(() => {
    if (!isResizing) return undefined;
    const updateRatio = (event: PointerEvent) => {
      if (event.pointerId !== activePointerIdRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const rawWidth = event.clientX - rect.left;
      const nextWidth = resolveFilePaneWidth(rect.width, window.innerWidth, rawWidth / rect.width);
      setRatio(nextWidth / rect.width);
    };
    const stop = (event?: PointerEvent) => {
      if (event && event.pointerId !== activePointerIdRef.current) return;
      activePointerIdRef.current = null;
      setIsResizing(false);
    };
    const stopOnBlur = () => stop();
    document.addEventListener('pointermove', updateRatio);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stopOnBlur);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('pointermove', updateRatio);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stopOnBlur);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return { containerRef, paneWidth, isResizing, onResizeStart };
}
