import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, MoreHorizontal, X } from 'lucide-react';

import CodeEditor, { type CodeEditorHandle } from '../../components/code-editor/view/CodeEditor';
import { getFileIconData } from '../../components/file-tree/constants/fileIcons';
import ImageViewer from '../../components/file-tree/view/ImageViewer';
import type { Project } from '../../types/app';

import type { FileEditorTab } from './fileEditorTabs';
import type { UseFileEditorTabsResult } from './useFileEditorTabs';

type DataAgentFileTabsProps = {
  manager: UseFileEditorTabsResult;
  project: Project;
  isReadOnly: boolean;
  isMobile: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
};

type ContextMenuState = {
  tabId: string;
  x: number;
  y: number;
} | null;

export default function DataAgentFileTabs({
  manager,
  project,
  isReadOnly,
  isMobile,
  expanded,
  onToggleExpand,
}: DataAgentFileTabsProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);

  const closeTab = useCallback((id: string) => {
    void manager.requestCloseTabs([id]);
  }, [manager]);

  const openContextMenu = useCallback((tabId: string, x: number, y: number) => {
    setContextMenu({
      tabId,
      x: Math.max(8, Math.min(x, window.innerWidth - 170)),
      y: Math.max(8, Math.min(y, window.innerHeight - 178)),
    });
  }, []);

  useEffect(() => {
    const handlePointerDown = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        if (!manager.activeTab) return;
        event.preventDefault();
        closeTab(manager.activeTab.id);
        return;
      }

      if (event.ctrlKey && event.key === 'Tab' && manager.tabs.length > 1) {
        event.preventDefault();
        const currentIndex = manager.tabs.findIndex((tab) => tab.id === manager.activeTab?.id);
        const direction = event.shiftKey ? -1 : 1;
        const nextIndex = (currentIndex + direction + manager.tabs.length) % manager.tabs.length;
        manager.activateTab(manager.tabs[nextIndex].id);
      }

      if (event.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeTab, manager]);

  useEffect(() => {
    const activeElement = tabStripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [manager.activeTab?.id]);

  const renderTab = (tab: FileEditorTab) => {
    const { icon: Icon, color } = getFileIconData(tab.file.name);
    const active = tab.id === manager.activeTab?.id;

    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        draggable
        className={`da-file-tab ${active ? 'is-active' : ''} ${draggedId === tab.id ? 'is-dragging' : ''}`}
        title={tab.displayPath}
        onClick={() => manager.activateTab(tab.id)}
        onMouseDown={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            closeTab(tab.id);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          manager.activateTab(tab.id);
          openContextMenu(tab.id, event.clientX, event.clientY);
        }}
        onDragStart={(event) => {
          setDraggedId(tab.id);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', tab.id);
        }}
        onDragOver={(event) => {
          if (draggedId && draggedId !== tab.id) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceId = event.dataTransfer.getData('text/plain') || draggedId;
          if (sourceId) manager.reorderTabs(sourceId, tab.id);
          setDraggedId(null);
        }}
        onDragEnd={() => setDraggedId(null)}
      >
        <Icon className={`h-3.5 w-3.5 flex-none ${color}`} aria-hidden="true" />
        <span className="da-file-tab-name">{tab.file.name}</span>
        {tab.dirty && <span className="da-file-tab-dirty" aria-label="未保存" />}
        <button
          type="button"
          className="da-file-tab-close"
          aria-label={`关闭 ${tab.file.name}`}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }}
        >
          <X size={12} />
        </button>
      </div>
    );
  };

  const contextTabIndex = contextMenu
    ? manager.tabs.findIndex((tab) => tab.id === contextMenu.tabId)
    : -1;

  return (
    <section className={`da-file-editor-pane ${isMobile && manager.tabs.length ? 'is-mobile-open' : ''}`}>
      {manager.tabs.length > 0 && (
        <div className="da-file-tabs-shell">
          <div ref={tabStripRef} className="da-file-tabs" role="tablist" aria-label="打开的文件">
            {manager.tabs.map(renderTab)}
          </div>
          <button
            type="button"
            className="da-file-tabs-menu-button"
            aria-label="文件 Tab 菜单"
            onClick={(event) => {
              event.stopPropagation();
              const tabId = manager.activeTab?.id;
              if (tabId) openContextMenu(tabId, event.clientX - 150, event.clientY + 10);
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      )}

      <div className="da-file-editors">
        {!manager.tabs.length && (
          <div className="da-file-preview-empty">
            <FileText size={24} />
            <strong>选择文件查看内容</strong>
            <span>文件会在右侧以 Tab 方式打开，支持同时编辑多个文件。</span>
          </div>
        )}

        {manager.tabs.map((tab) => {
          if (!manager.visitedIds.has(tab.id)) return null;
          const active = tab.id === manager.activeTab?.id;
          return (
            <div key={tab.id} className={`da-file-editor-instance ${active ? 'is-active' : ''}`} aria-hidden={!active}>
              {tab.kind === 'image' ? (
                <ImageViewer
                  variant="inline"
                  file={{
                    name: tab.file.name,
                    path: tab.file.path,
                    projectName: tab.file.projectName || project.name,
                    projectPath: project.path,
                  }}
                  onClose={() => closeTab(tab.id)}
                />
              ) : (
                <CodeEditor
                  ref={(handle: CodeEditorHandle | null) => manager.registerEditor(tab.id, handle)}
                  file={tab.file}
                  onClose={() => closeTab(tab.id)}
                  projectPath={project.path}
                  isReadOnly={isReadOnly}
                  isSidebar
                  isExpanded={isMobile ? false : expanded}
                  onToggleExpand={isMobile ? null : onToggleExpand}
                  isActive={active}
                  onDirtyChange={(dirty) => manager.setTabDirty(tab.id, dirty)}
                  headerVariant="tabbed"
                />
              )}
            </div>
          );
        })}
      </div>

      {contextMenu && contextTabIndex >= 0 && (
        <div
          className="da-file-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}>关闭</button>
          <button type="button" role="menuitem" disabled={manager.tabs.length <= 1} onClick={() => { void manager.closeOtherTabs(contextMenu.tabId); setContextMenu(null); }}>关闭其他</button>
          <button type="button" role="menuitem" disabled={contextTabIndex === manager.tabs.length - 1} onClick={() => { void manager.closeTabsToRight(contextMenu.tabId); setContextMenu(null); }}>关闭右侧</button>
          <span className="da-file-tab-menu-divider" />
          <button type="button" role="menuitem" onClick={() => { void manager.closeAllTabs(); setContextMenu(null); }}>关闭全部</button>
        </div>
      )}
    </section>
  );
}
