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
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import type { WorkspaceSkillEntry } from './utils/skillFormatting';
import {
  buildChildPath,
  buildRenamedPath,
  createSkillTreeNodes,
  getNewEntryParentPath,
  getSkillDirectoryPaths,
  getVisibleSkillTreeNodes,
  validateSkillEntryName,
  type SkillTreeNode,
} from './utils/skillFileTree';

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
  const pathTooltipId = useId();
  const initializedTreeKeyRef = useRef(treeKey);
  const knownDirectoryPathsRef = useRef(new Set(directoryPaths));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
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
    if (treeChanged) setDraft(null);
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
  const canChangeSelected = editable && selectedNode && selectedNode.path !== 'SKILL.md';

  const beginCreate = (type: 'directory' | 'file') => {
    if (!editable || busy) return;
    const parentPath = getNewEntryParentPath(nodes, selectedEntryPath);
    if (parentPath) {
      setExpandedPaths((current) => new Set(current).add(parentPath));
    }
    setDraft({ mode: 'create', parentPath, type, value: '' });
  };

  const beginRename = () => {
    if (!canChangeSelected || busy) return;
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
    const error = validateSkillEntryName(draft.value);
    if (error) {
      setDraft({ ...draft, error });
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    const normalizedName = draft.value.trim();
    const nextPath = draft.mode === 'create'
      ? buildChildPath(draft.parentPath, normalizedName)
      : buildRenamedPath(draft.path, normalizedName);
    const succeeded = draft.mode === 'create'
      ? await onCreateEntry(nextPath, draft.type)
      : await onRenameEntry(draft.path, nextPath);
    if (succeeded) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        if (draft.parentPath) next.add(draft.parentPath);
        if (draft.mode === 'create' && draft.type === 'directory') next.add(nextPath);
        return next;
      });
      setDraft(null);
    }
    submittingRef.current = false;
    setSubmitting(false);
    if (!succeeded) window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const renderDraft = (depth: number) => draft ? (
    <div className="py-0.5" style={{ paddingLeft: `${8 + depth * 14}px` }}>
      <div className={`flex min-h-8 items-center gap-2 rounded-md border bg-background px-2 ${draft.error ? 'border-destructive' : 'border-primary/50'}`}>
        {submitting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : draft.type === 'directory' ? <Folder className="h-4 w-4 shrink-0 text-muted-foreground" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
        <input
          ref={inputRef}
          value={draft.value}
          disabled={submitting}
          aria-label={draft.mode === 'create' ? draft.type === 'file' ? '新文件名称' : '新文件夹名称' : '新名称'}
          onBlur={() => {
            if (!submittingRef.current) setDraft(null);
          }}
          onChange={(event) => setDraft({ ...draft, value: event.target.value, error: undefined })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submitDraft();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(null);
            }
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      {draft.error ? <p className="px-2 pt-1 text-xs text-destructive">{draft.error}</p> : null}
    </div>
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
      <div className="min-h-0 flex-1 overflow-auto p-2" role="tree" aria-label="Skill 文件">
        {draft?.mode === 'create' && !draft.parentPath ? renderDraft(0) : null}
        {visibleNodes.map((node) => (
          <div key={`${node.type}-${node.path}`}>
            {draft?.mode === 'rename' && draft.path === node.path ? renderDraft(node.depth) : (
              <TreeNodeRow
                expanded={expandedPaths.has(node.path)}
                node={node}
                selected={selectedEntryPath === node.path}
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

function TreeNodeRow({ expanded, node, onClick, selected }: { expanded: boolean; node: SkillTreeNode; onClick: () => void; selected: boolean }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-expanded={node.type === 'directory' ? expanded : undefined}
      aria-selected={selected}
      onClick={onClick}
      className={`flex h-8 w-full min-w-0 items-center gap-1 rounded-md pr-2 text-left text-sm transition ${selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'}`}
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
