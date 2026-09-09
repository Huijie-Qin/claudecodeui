import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Folder, FolderUp, Loader2, Trash2 } from 'lucide-react';

import {
  MAX_TEMPLATE_FOLDER_BYTES,
  MAX_TEMPLATE_FOLDER_ENTRIES,
  MAX_TEMPLATE_FOLDERS,
} from '../../../shared/agentTemplateFolders.js';
import { cn } from '../../lib/utils';
import { Button } from '../../shared/view/ui';

import {
  formatTemplateFolderBytes,
  readTemplateFolderEntries,
  readTemplateFolderFiles,
  templateFolderBytes,
  type AgentTemplateFolder,
  type FolderUploadEntry,
} from './agentTemplateFolderUpload';

export default function AgentTemplateFolders({
  folders,
  disabled,
  onChange,
  onReadingChange,
}: {
  folders: AgentTemplateFolder[];
  disabled: boolean;
  onChange: (folders: AgentTemplateFolder[]) => void;
  onReadingChange: (reading: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(folders.length > 0);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const readingRef = useRef(false);
  const dragDepthRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busy = disabled || reading;
  const totalBytes = useMemo(() => folders.reduce((sum, folder) => sum + templateFolderBytes(folder), 0), [folders]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const upload = async (read: (signal: AbortSignal) => Promise<AgentTemplateFolder[]>) => {
    if (disabled || readingRef.current) return;
    readingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setReading(true);
    setError(null);
    onReadingChange(true);
    try {
      const added = await read(controller.signal);
      if (!controller.signal.aborted) onChange([...folders, ...added]);
    } catch (readError) {
      if (!controller.signal.aborted) {
        setError(readError instanceof Error ? readError.message : '文件夹读取失败，请重新上传。');
      }
    } finally {
      if (!controller.signal.aborted) {
        readingRef.current = false;
        setReading(false);
        onReadingChange(false);
      }
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
        aria-expanded={expanded}
        aria-controls="agent-template-folder-options"
        onClick={() => setExpanded((previous) => !previous)}
      >
        <span>
          <span className="block font-semibold text-foreground">高级配置</span>
          <span className="mt-1 block text-sm text-muted-foreground">上传文件夹，随模板创建到工作空间的 .claude 目录下。</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
          {folders.length > 0 ? <span className="text-xs">{folders.length} 个文件夹</span> : null}
          {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </span>
      </button>
      <div id="agent-template-folder-options" hidden={!expanded} className="space-y-3 px-5 pb-5">
        <p className="text-sm text-muted-foreground">选择此模板创建项目时，将保留文件夹名称、目录层级和文件内容，例如 .claude/commands/。</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          {...{ webkitdirectory: '', directory: '' }}
          disabled={busy}
          className="hidden"
          aria-label="上传模板文件夹"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            if (files.length) void upload((signal) => readTemplateFolderFiles(files, folders, signal));
          }}
        />
        <div
          className={cn('rounded-lg border border-dashed px-4 py-6 text-center transition-colors', dragging && !busy ? 'border-primary bg-primary/5' : 'border-border bg-background', busy && 'opacity-70')}
          aria-busy={reading}
          onDragEnter={(event) => {
            event.preventDefault();
            dragDepthRef.current += 1;
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (!dragDepthRef.current) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepthRef.current = 0;
            setDragging(false);
            if (busy || readingRef.current) return;
            // Capture entries before the drop event returns and its data store closes.
            const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file');
            const entries = items.map((item) => item.webkitGetAsEntry?.() as FolderUploadEntry | null);
            if (!entries.length || entries.some((entry) => !entry)) {
              setError('此浏览器无法读取拖入的文件夹，请点击“选择文件夹”上传。');
              return;
            }
            void upload((signal) => readTemplateFolderEntries(entries as FolderUploadEntry[], folders, signal));
          }}
        >
          {reading ? <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-primary" /> : <FolderUp className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />}
          <p className="text-sm text-foreground" role="status">{reading ? '正在读取文件夹，请稍候…' : '将一个或多个文件夹拖到这里'}</p>
          <Button type="button" variant="outline" size="sm" disabled={busy} className="mt-3" onClick={() => inputRef.current?.click()}>
            <FolderUp className="h-4 w-4" />{folders.length ? '继续添加文件夹' : '选择文件夹'}
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">支持批量拖入或分批追加；空文件夹及空子目录请通过拖拽上传。</p>
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>最多 {MAX_TEMPLATE_FOLDERS} 个文件夹，文件和子目录合计 {MAX_TEMPLATE_FOLDER_ENTRIES} 项，总大小 {formatTemplateFolderBytes(MAX_TEMPLATE_FOLDER_BYTES)}。</span>
          <span>已添加 {folders.length} 个 · {formatTemplateFolderBytes(totalBytes)}</span>
        </div>
        {error ? <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div> : null}
        {folders.length ? (
          <ul className="max-h-72 space-y-2 overflow-y-auto">
            {folders.map((folder) => (
              <li key={folder.name} className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
                <Folder className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground" title={folder.name}>{folder.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{folder.files.length} 个文件 · {folder.directories.length} 个子目录 · {formatTemplateFolderBytes(templateFolderBytes(folder))}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="shrink-0 text-destructive hover:text-destructive"
                  aria-label={`移除文件夹 ${folder.name}`}
                  onClick={() => { setError(null); onChange(folders.filter((item) => item.name !== folder.name)); }}
                >
                  <Trash2 className="h-4 w-4" />移除
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
