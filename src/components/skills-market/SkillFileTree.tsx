import {
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  Trash2,
} from 'lucide-react';
import { type DragEvent, useEffect, useId, useMemo, useRef, useState } from 'react';

import type { WorkspaceSkillEntry } from './utils/skillFormatting';
import {
  buildChildPath,
  buildMovedPath,
  buildRenamedPath,
  createSkillTreeNodes,
  getNewEntryParentPath,
  getSkillDirectoryPaths,
  getVisibleSkillTreeNodes,
  validateSkillEntryName,
  validateSkillEntryMove,
  type SkillTreeNode,
} from './utils/skillFileTree';

const SKILL_TREE_DRAG_TYPE = 'application/x-cloudcli-skill-tree';

type InlineDraft = {
  error?: string;
  mode: 'create';
  parentPath: string;
  type: 'directory' | 'file';
  value: string;
} | {
  error?: string;
  mode: 'rename';
  parentPath: string;
  path: string;
  type: 'directory' | 'file';
  value: string;
};

type SkillFileTreeProps = {
  busy: boolean;
  editable: boolean;
  entries: WorkspaceSkillEntry[];
  onCreateEntry: (path: string, type: 'directory' | 'file') => Promise<boolean>;
  onMoveEntry: (path: string, nextPath: string) => Promise<boolean>;
  onRenameEntry: (path: string, nextPath: string) => Promise<boolean>;
  onRequestRemove: (path: string) => void;
  onSelectEntry: (path: string) => void;
  onSelectFile: (path: string) => void;
  selectedEntryPath: string | null;
  targetPath: string;
  treeKey: string;
};

export default function SkillFileTree({
  busy,
  editable,
  entries,
  onCreateEntry,
  onMoveEntry,
  onRenameEntry,
  onRequestRemove,
  onSelectEntry,
  onSelectFile,
  selectedEntryPath,
  targetPath,
  treeKey,
}: SkillFileTreeProps) {
  const nodes = useMemo(() => createSkillTreeNodes(entries), [entries]);
  const directoryPaths = useMemo(() => getSkillDirectoryPaths(nodes), [nodes]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(directoryPaths));
  const [draft, setDraft] = useState<InlineDraft | null>(null);
  const [pathTooltipVisible, setPathTooltipVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropParentPath, setDropParentPath] = useState<string | null>(null);
  const pathTooltipId = useId();
  const initializedTreeKeyRef = useRef(treeKey);
  const knownDirectoryPathsRef = useRef(new Set(directoryPaths));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const cancellingDraftRef = useRef(false);
  const draftFocusKey = draft?.mode === 'rename'
    ? `rename:${draft.path}`
    : draft ? `create:${draft.parentPath}:${draft.type}` : null;

  useEffect(() => {
    const available = new Set(directoryPaths);
    const treeChanged = initializedTreeKeyRef.current !== treeKey;
    const receivedFirstDirectories = knownDirectoryPathsRef.current.size === 0 && available.size > 0;
    setExpandedPaths((current) => {
      if (treeChanged || receivedFirstDirectories) return available;
      return new Set(Array.from(current).filter((path) => available.has(path)));
    });
    if (treeChanged) {
      setDraft(null);
      setDraggedPath(null);
      setDropParentPath(null);
    }
    initializedTreeKeyRef.current = treeKey;
    knownDirectoryPathsRef.current = available;
  }, [directoryPaths, treeKey]);

  useEffect(() => {
    if (draftFocusKey) inputRef.current?.focus();
  }, [draftFocusKey]);

  const visibleNodes = useMemo(
    () => getVisibleSkillTreeNodes(nodes, expandedPaths),
    [expandedPaths, nodes],
  );
  const selectedNode = nodes.find((node) => node.path === selectedEntryPath);
  const draggedNode = nodes.find((node) => node.path === draggedPath);
  const canChangeSelected = editable && selectedNode && selectedNode.path !== 'SKILL.md';

  const beginCreate = (type: 'directory' | 'file') => {
    if (!editable || busy) return;
    cancellingDraftRef.current = false;
    const parentPath = getNewEntryParentPath(nodes, selectedEntryPath);
    if (parentPath) {
      setExpandedPaths((current) => new Set(current).add(parentPath));
    }
    setDraft({ mode: 'create', parentPath, type, value: '' });
  };

  const beginRename = () => {
    if (!canChangeSelected || busy) return;
    cancellingDraftRef.current = false;
    setDraft({
      mode: 'rename',
      parentPath: selectedNode.parentPath,
      path: selectedNode.path,
      type: selectedNode.type,
      value: selectedNode.label,
    });
  };

  const submitDraft = async () => {
    if (!draft || submittingRef.current) return;
    const currentDraft = draft;
    const error = validateSkillEntryName(currentDraft.value);
    if (error) {
      setDraft({ ...currentDraft, error });
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }

    const normalizedName = currentDraft.value.trim();
    const nextPath = currentDraft.mode === 'create'
      ? buildChildPath(currentDraft.parentPath, normalizedName)
      : buildRenamedPath(currentDraft.path, normalizedName);
    if (currentDraft.mode === 'rename' && nextPath === currentDraft.path) {
      setDraft(null);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    let succeeded = false;
    try {
      succeeded = currentDraft.mode === 'create'
        ? await onCreateEntry(nextPath, currentDraft.type)
        : await onRenameEntry(currentDraft.path, nextPath);
      if (succeeded) {
        setExpandedPaths((current) => {
          const next = new Set(current);
          if (currentDraft.parentPath) next.add(currentDraft.parentPath);
          if (currentDraft.mode === 'create' && currentDraft.type === 'directory') next.add(nextPath);
          return next;
        });
        setDraft(null);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (!succeeded) window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const clearDragState = () => {
    setDraggedPath(null);
    setDropParentPath(null);
  };

  const canDropInto = (parentPath: string) => Boolean(
    draggedNode && !validateSkillEntryMove(draggedNode.path, draggedNode.type, parentPath),
  );

  const moveDraggedEntry = async (parentPath: string) => {
    if (!draggedNode || !canDropInto(parentPath)) {
      clearDragState();
      return;
    }
    const sourcePath = draggedNode.path;
    const nextPath = buildMovedPath(sourcePath, parentPath);
    clearDragState();
    const succeeded = await onMoveEntry(sourcePath, nextPath);
    if (succeeded && parentPath) {
      setExpandedPaths((current) => new Set(current).add(parentPath));
    }
  };

  const isSkillTreeDrag = (event: DragEvent<HTMLElement>) => (
    Array.from(event.dataTransfer.types).includes(SKILL_TREE_DRAG_TYPE)
  );

  const renderDraft = (depth: number) => draft ? (
    <form
      className="py-0.5"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      onSubmit={(event) => {
        event.preventDefault();
        void submitDraft();
      }}
    >
      <div className={`flex min-h-8 items-center gap-2 rounded-md border bg-background px-2 ${draft.error ? 'border-destructive' : 'border-primary/50'}`}>
        {submitting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : draft.type === 'directory' ? <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <input
          ref={inputRef}
          value={draft.value}
          disabled={submitting}
          aria-label={draft.mode === 'create' ? draft.type === 'file' ? '新文件名称' : '新文件夹名称' : '新名称'}
          onBlur={() => {
            if (submittingRef.current) return;
            if (cancellingDraftRef.current) {
              cancellingDraftRef.current = false;
              return;
            }
            if (draft.mode === 'rename') void submitDraft();
            else setDraft(null);
          }}
          onChange={(event) => setDraft({ ...draft, value: event.target.value, error: undefined })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancellingDraftRef.current = true;
              setDraft(null);
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </div>
      {draft.error ? <p className="px-2 pt-1 text-xs text-destructive">{draft.error}</p> : null}
    </form>
  ) : null;

  return (
    <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase text-muted-foreground">文件</div>
          <div
            className="relative mt-0.5 min-w-0"
            onMouseEnter={() => setPathTooltipVisible(true)}
            onMouseLeave={() => setPathTooltipVisible(false)}
          >
            <div
              aria-describedby={pathTooltipVisible ? pathTooltipId : undefined}
              className="truncate font-mono text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              onBlur={() => setPathTooltipVisible(false)}
              onFocus={() => setPathTooltipVisible(true)}
              tabIndex={0}
            >
              {targetPath}
            </div>
            {pathTooltipVisible ? (
              <div
                id={pathTooltipId}
                role="tooltip"
                className="pointer-events-none absolute left-0 top-full z-50 mt-1 w-max max-w-[min(32rem,calc(100vw-2rem))] break-all rounded-md border border-border bg-popover px-2.5 py-1.5 font-mono text-[11px] leading-4 text-popover-foreground shadow-lg"
              >
                {targetPath}
              </div>
            ) : null}
          </div>
        </div>
        {editable ? (
          <div className="flex items-center">
            <TreeActionButton icon={FilePlus2} label="新建文件" onClick={() => beginCreate('file')} disabled={busy || Boolean(draft)} />
            <TreeActionButton icon={FolderPlus} label="新建文件夹" onClick={() => beginCreate('directory')} disabled={busy || Boolean(draft)} />
            {canChangeSelected ? (
              <>
                <TreeActionButton icon={Pencil} label="重命名" onClick={beginRename} disabled={busy || Boolean(draft)} />
                <TreeActionButton icon={Trash2} label="移除" onClick={() => onRequestRemove(selectedNode.path)} disabled={busy || Boolean(draft)} danger />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <div
        className={`min-h-0 flex-1 overflow-auto p-2 transition ${dropParentPath === '' ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''}`}
        role="tree"
        aria-label="Skill 文件"
        onDragOver={(event) => {
          if (!isSkillTreeDrag(event) || (event.target as HTMLElement).closest('[data-skill-tree-node]') || !canDropInto('')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropParentPath('');
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          if (dropParentPath === '') setDropParentPath(null);
        }}
        onDrop={(event) => {
          if (!isSkillTreeDrag(event) || (event.target as HTMLElement).closest('[data-skill-tree-node]') || !canDropInto('')) return;
          event.preventDefault();
          void moveDraggedEntry('');
        }}
      >
        {draft?.mode === 'create' && !draft.parentPath ? renderDraft(0) : null}
        {visibleNodes.map((node) => (
          <div key={`${node.type}-${node.path}`}>
            {draft?.mode === 'rename' && draft.path === node.path ? renderDraft(node.depth) : (
              <TreeNodeRow
                draggable={editable && !busy && !draft && node.path !== 'SKILL.md'}
                dropTarget={dropParentPath === node.path}
                expanded={expandedPaths.has(node.path)}
                node={node}
                selected={selectedEntryPath === node.path}
                onDragEnd={clearDragState}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  if (dropParentPath === node.path) setDropParentPath(null);
                }}
                onDragOver={(event) => {
                  if (node.type !== 'directory' || !isSkillTreeDrag(event) || !canDropInto(node.path)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  setDropParentPath(node.path);
                }}
                onDragStart={(event) => {
                  setDraggedPath(node.path);
                  setDropParentPath(null);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(SKILL_TREE_DRAG_TYPE, node.path);
                  event.dataTransfer.setData('text/plain', node.label);
                }}
                onDrop={(event) => {
                  if (node.type !== 'directory' || !isSkillTreeDrag(event) || !canDropInto(node.path)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  void moveDraggedEntry(node.path);
                }}
                onClick={() => {
                  onSelectEntry(node.path);
                  if (node.type === 'file') {
                    onSelectFile(node.path);
                    return;
                  }
                  setExpandedPaths((current) => {
                    const next = new Set(current);
                    if (next.has(node.path)) next.delete(node.path);
                    else next.add(node.path);
                    return next;
                  });
                }}
              />
            )}
            {draft?.mode === 'create' && draft.parentPath === node.path ? renderDraft(node.depth + 1) : null}
          </div>
        ))}
      </div>
    </aside>
  );
}

function TreeNodeRow({
  draggable,
  dropTarget,
  expanded,
  node,
  onClick,
  onDragEnd,
  onDragLeave,
  onDragOver,
  onDragStart,
  onDrop,
  selected,
}: {
  draggable: boolean;
  dropTarget: boolean;
  expanded: boolean;
  node: SkillTreeNode;
  onClick: () => void;
  onDragEnd: () => void;
  onDragLeave: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLButtonElement>) => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: DragEvent<HTMLButtonElement>) => void;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      data-skill-tree-node="true"
      draggable={draggable}
      role="treeitem"
      aria-expanded={node.type === 'directory' ? expanded : undefined}
      aria-selected={selected}
      onClick={onClick}
      onDragEnd={onDragEnd}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
      className={`flex h-8 w-full min-w-0 items-center gap-1 rounded-md pr-2 text-left text-sm transition ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${dropTarget ? 'bg-primary/15 ring-1 ring-inset ring-primary/50' : selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'}`}
      style={{ paddingLeft: `${8 + node.depth * 14}px` }}
    >
      {node.type === 'directory' ? <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} /> : <span className="w-3.5 shrink-0" />}
      {node.type === 'directory' ? <Folder className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
      <span className="truncate">{node.label}</span>
    </button>
  );
}

function TreeActionButton({ icon: Icon, label, onClick, danger = false, disabled = false }: { icon: typeof FilePlus2; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'}`}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
