import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MutableRefObject, PointerEvent } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getFileIconData } from '../../file-tree/constants/fileIcons';
import ImageViewer from '../../file-tree/view/ImageViewer';
import type { MainFileTabsManager } from '../hooks/useMainFileTabs';

import CodeEditor from './CodeEditor';

type Props = {
  manager: MainFileTabsManager;
  isVisible: boolean;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  isResizing: boolean;
  hasManualWidth: boolean;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onToggleEditorExpand: () => void;
  fillSpace: boolean;
  onOpenFile: (path: string) => void;
};

const MIN_LEFT_CONTENT_WIDTH = 200;
const MIN_EDITOR_WIDTH = 280;

export default function MainTabbedEditorSidebar({
  manager,
  isVisible,
  isMobile,
  editorExpanded,
  editorWidth,
  isResizing,
  hasManualWidth,
  resizeHandleRef,
  onResizeStart,
  onToggleEditorExpand,
  fillSpace,
  onOpenFile,
}: Props) {
  const { t } = useTranslation('codeEditor');
  const [poppedOut, setPoppedOut] = useState(false);
  const [effectiveWidth, setEffectiveWidth] = useState(editorWidth);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileDismissed, setMobileDismissed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const shouldFillRemaining = editorExpanded || (fillSpace && !hasManualWidth);
  const activeId = manager.activeTab?.id;

  useEffect(() => setMobileDismissed(false), [manager.activationVersion]);

  useEffect(() => {
    if (!manager.tabs.length || !isVisible || isMobile || poppedOut) return;
    const updateWidth = () => {
      const parent = containerRef.current?.parentElement;
      if (!parent) return;
      const maximum = parent.clientWidth - MIN_LEFT_CONTENT_WIDTH;
      if (maximum < MIN_EDITOR_WIDTH) setPoppedOut(true);
      else setEffectiveWidth(Math.min(editorWidth, maximum));
    };
    updateWidth();
    window.addEventListener('resize', updateWidth);
    const observer = new ResizeObserver(updateWidth);
    if (containerRef.current?.parentElement) observer.observe(containerRef.current.parentElement);
    return () => {
      window.removeEventListener('resize', updateWidth);
      observer.disconnect();
    };
  }, [editorWidth, isMobile, isVisible, manager.tabs.length, poppedOut]);

  useLayoutEffect(() => {
    if (!isVisible || mobileDismissed || !activeId) return;
    const strip = tabStripRef.current;
    const active = Array.from(strip?.querySelectorAll<HTMLElement>('[data-file-tab]') || [])
      .find((element) => element.dataset.fileTab === activeId);
    if (!strip || !active) return;
    const stripBounds = strip.getBoundingClientRect();
    const activeBounds = active.getBoundingClientRect();
    if (activeBounds.left < stripBounds.left) {
      strip.scrollBy({ left: activeBounds.left - stripBounds.left - 8, behavior: 'smooth' });
    } else if (activeBounds.right > stripBounds.right) {
      strip.scrollBy({ left: activeBounds.right - stripBounds.right + 8, behavior: 'smooth' });
    }
  }, [activeId, isVisible, manager.activationVersion, mobileDismissed]);

  useEffect(() => setMenuOpen(false), [manager.activeTab?.id, isVisible]);
  useEffect(() => {
    if (!manager.tabs.length) setPoppedOut(false);
  }, [manager.tabs.length]);

  if (!manager.tabs.length) return null;

  const floating = isMobile || poppedOut;
  const closeActive = () => {
    if (manager.activeTab) void manager.closeTabs([manager.activeTab.id]);
  };
  const tabBar = (
    <div className="relative flex h-9 shrink-0 border-b border-border bg-muted/40">
      <div ref={tabStripRef} className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden" role="tablist" aria-label={t('tabs.list')}>
        {manager.tabs.map((tab) => {
          const active = tab.id === manager.activeTab?.id;
          const { icon: Icon, color } = getFileIconData(tab.file.name);
          return (
            <div key={tab.id} className={`flex min-w-[116px] max-w-[190px] shrink-0 items-center border-r border-border ${active ? 'border-t-2 border-t-blue-500 bg-background' : 'border-t-2 border-t-transparent'}`}>
              <button
                type="button"
                role="tab"
                data-file-tab={tab.id}
                aria-selected={active}
                aria-label={`${tab.file.name}${tab.dirty ? `, ${t('tabs.unsaved')}` : ''}`}
                title={tab.displayPath}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-left text-xs text-foreground"
                onClick={() => manager.activateTab(tab.id)}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    void manager.closeTabs([tab.id]);
                  }
                }}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${color}`} aria-hidden="true" />
                <span className="truncate">{tab.file.name}</span>
                {tab.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label={t('tabs.unsaved')} />}
              </button>
              <button
                type="button"
                aria-label={t('tabs.closeFile', { fileName: tab.file.name })}
                className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => void manager.closeTabs([tab.id])}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="flex w-8 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent"
        aria-label={t('tabs.menu')}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menuOpen && manager.activeTab && (
        <div className="absolute right-1 top-9 z-30 min-w-32 rounded-md border border-border bg-popover p-1 shadow-lg">
          <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => { setMenuOpen(false); closeActive(); }}>{t('tabs.closeCurrent')}</button>
          <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => { setMenuOpen(false); void manager.closeTabs(manager.tabs.filter((tab) => tab.id !== manager.activeTab?.id).map((tab) => tab.id)); }}>{t('tabs.closeOthers')}</button>
          <button type="button" className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent" onClick={() => { setMenuOpen(false); void manager.closeTabs(manager.tabs.map((tab) => tab.id)); }}>{t('tabs.closeAll')}</button>
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={`${isVisible && !(isMobile && mobileDismissed) ? 'flex' : 'hidden'} ${floating ? 'fixed inset-0 z-[9999] bg-background' : `relative h-full min-w-0 shrink-0 ${shouldFillRemaining ? 'flex-1' : ''}`} flex-col`}
      style={!floating && !shouldFillRemaining ? { width: `${effectiveWidth}px`, minWidth: `${MIN_EDITOR_WIDTH}px` } : undefined}
    >
      {isVisible && !floating && !editorExpanded && (
        <div
          ref={resizeHandleRef}
          onPointerDown={onResizeStart}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-border hover:bg-blue-500"
          title="Drag to resize"
        />
      )}
      {isResizing && isVisible && <div className="fixed inset-0 z-[10000] cursor-col-resize" aria-hidden="true" />}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-border">
        {tabBar}
        {floating && (
          <button type="button" onClick={isMobile ? () => setMobileDismissed(true) : () => setPoppedOut(false)} className="absolute right-10 top-1 z-20 rounded p-1 text-muted-foreground hover:bg-accent" aria-label={isMobile ? t('tabs.back') : t('tabs.collapsePreview')}>
            <X className="h-4 w-4" />
          </button>
        )}
        {manager.saveError && <div role="alert" className="border-b border-red-300 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{manager.saveError}</div>}
        <div className="relative min-h-0 flex-1">
          {manager.tabs.map((tab) => {
            const active = tab.id === manager.activeTab?.id;
            return (
              <div key={tab.id} className={`absolute inset-0 ${active ? 'flex' : 'hidden'}`} aria-hidden={!active}>
                {tab.kind === 'image' ? (
                  <ImageViewer
                    variant="inline"
                    file={{ name: tab.file.name, path: tab.file.path, projectName: tab.file.projectName || '', projectPath: tab.projectPath, workspaceId: tab.file.workspaceId }}
                    onClose={() => void manager.closeTabs([tab.id])}
                  />
                ) : (
                  <CodeEditor
                    ref={(handle) => manager.registerEditor(tab.id, handle)}
                    file={tab.file}
                    onClose={() => void manager.closeTabs([tab.id])}
                    projectPath={tab.projectPath}
                    isReadOnly={tab.isReadOnly}
                    isSidebar
                    isExpanded={editorExpanded}
                    onToggleExpand={isMobile ? null : onToggleEditorExpand}
                    onPopOut={isMobile ? null : () => setPoppedOut(true)}
                    isActive={active && isVisible && !mobileDismissed}
                    onDirtyChange={(dirty) => manager.setTabDirty(tab.id, dirty)}
                    headerVariant="tabbed"
                    onOpenFile={onOpenFile}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
