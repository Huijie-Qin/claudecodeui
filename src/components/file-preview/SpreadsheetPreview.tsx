import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Download, Loader2, RefreshCw, Table2 } from 'lucide-react';

import { api } from '../../utils/api';
import type { CodeEditorFile } from '../code-editor/types/types';

import { readPreviewBlob } from './filePreview';
import { downloadOriginalFile } from './filePreviewDownload';
import { useFilePreviewRefresh } from './useFilePreviewRefresh';
import type { SpreadsheetSheetPreview } from './spreadsheetPreviewModel';

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const buttonClass = 'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40';

type SpreadsheetPreviewProps = {
  file: CodeEditorFile;
  projectPath?: string;
};

type WorkerResponse =
  | { type: 'loaded'; sheetNames: string[]; sheet: SpreadsheetSheetPreview }
  | { type: 'sheet'; sheet: SpreadsheetSheetPreview }
  | { type: 'error'; message: string };

export default function SpreadsheetPreview(props: SpreadsheetPreviewProps) {
  const revision = useFilePreviewRefresh({
    path: props.file.path,
    displayPath: typeof props.file.displayPath === 'string' ? props.file.displayPath : undefined,
    projectPath: props.projectPath,
    projectName: props.file.projectName ?? props.projectPath,
    workspaceId: props.file.workspaceId,
  });
  // Switching files immediately discards the previous file's state and worker.
  const identity = JSON.stringify([props.file.workspaceId, props.file.projectName ?? props.projectPath, props.file.path, revision]);
  return <SpreadsheetPreviewContent key={identity} {...props} />;
}

function SpreadsheetPreviewContent({ file, projectPath }: SpreadsheetPreviewProps) {
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheet, setSheet] = useState<SpreadsheetSheetPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestSheetRef = useRef<((index: number) => void) | null>(null);
  const mountedRef = useRef(false);
  const { path, projectName, workspaceId } = file;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | null = null;
    let active = true;
    let failed = false;
    let pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setLoading(true);
    setError('');
    setSheet(null);
    setSheetNames([]);
    setPage(0);
    requestSheetRef.current = null;

    const fail = (message: string) => {
      if (!active || failed) return;
      failed = true;
      pending = false;
      clearTimeout(timer);
      controller.abort();
      worker?.terminate();
      requestSheetRef.current = null;
      setLoading(false);
      setSheet(null);
      setError(message);
    };

    const armTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fail('预览加载超时，文件可能较大或内容过于复杂。请重试或下载原文件查看。');
      }, REQUEST_TIMEOUT_MS);
    };

    armTimeout();
    void (async () => {
      try {
        const project = projectName ?? projectPath;
        if (!project) throw new Error('缺少文件所属项目信息，无法加载预览。');
        const response = await api.readFileBlob(project, path, workspaceId, { signal: controller.signal });
        if (!response.ok) throw new Error('无法读取文件，请检查文件是否存在以及访问权限。');
        const blob = await readPreviewBlob(response, MAX_PREVIEW_BYTES, controller.signal);
        const buffer = await blob.arrayBuffer();
        if (!active || failed) return;

        worker = new Worker(new URL('./spreadsheet.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          if (!active || failed) return;
          const message = event.data;
          if (message.type === 'error') {
            fail(message.message);
            return;
          }
          if (message.type !== 'loaded' && message.type !== 'sheet') return;
          clearTimeout(timer);
          pending = false;
          if (message.type === 'loaded') setSheetNames(message.sheetNames);
          setSheet(message.sheet);
          setPage(0);
          setLoading(false);
          if (scrollRef.current) {
            scrollRef.current.scrollTop = 0;
            scrollRef.current.scrollLeft = 0;
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail('无法解析此工作簿，请重试或下载原文件查看。');
        };
        worker.onmessageerror = () => fail('无法读取工作簿预览结果，请重试。');
        requestSheetRef.current = (index) => {
          // Guard synchronously as two clicks can arrive before React disables the tabs.
          if (!active || failed || pending || !worker) return;
          pending = true;
          setLoading(true);
          armTimeout();
          try {
            worker.postMessage({ type: 'sheet', index });
          } catch {
            fail('无法切换工作表，请重试。');
          }
        };
        worker.postMessage({ type: 'open', buffer }, [buffer]);
      } catch (caught) {
        if (!active || failed) return;
        fail(caught instanceof Error ? caught.message : '无法加载工作簿，请重试或下载原文件查看。');
      }
    })();

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      worker?.terminate();
      requestSheetRef.current = null;
    };
  }, [path, projectName, projectPath, workspaceId, retry]);

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError('');
    try {
      await downloadOriginalFile(file, projectPath);
    } catch (caught) {
      if (mountedRef.current) {
        setDownloadError(caught instanceof Error ? caught.message : '下载失败，请重试。');
      }
    } finally {
      if (mountedRef.current) setDownloading(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil((sheet?.rows.length ?? 0) / PAGE_SIZE));
  const firstRow = page * PAGE_SIZE;
  const visibleRows = sheet?.rows.slice(firstRow, firstRow + PAGE_SIZE) ?? [];
  const hasCells = Boolean(sheet?.rows.length && sheet.columnLabels.length);
  const changePage = (nextPage: number) => {
    setPage(nextPage);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Table2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>工作簿 · 只读预览</span>
          {loading && sheet && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="正在加载工作表" />}
        </span>
        <button type="button" className={buttonClass} onClick={() => void download()} disabled={downloading}>
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
          {downloading ? '下载中…' : '下载原文件'}
        </button>
      </div>

      {downloadError && <p role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs text-red-600 dark:text-red-400">{downloadError}</p>}

      {sheetNames.length > 0 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2 py-1.5" role="group" aria-label="工作表">
          {sheetNames.map((name, index) => (
            <button
              key={index}
              type="button"
              onClick={() => requestSheetRef.current?.(index)}
              disabled={loading || Boolean(error) || sheet?.index === index}
              aria-pressed={sheet?.index === index}
              title={name}
              className={`max-w-48 shrink-0 truncate rounded-md px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default ${sheet?.index === index ? 'bg-background font-medium text-primary shadow-sm' : 'text-muted-foreground hover:bg-muted disabled:opacity-50'}`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {error ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center" role="alert">
          <AlertCircle className="h-8 w-8 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">无法预览工作簿</p>
          <p className="max-w-md break-words text-xs leading-relaxed text-muted-foreground">{error}</p>
          <button type="button" className={buttonClass} onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />重新加载
          </button>
        </div>
      ) : !sheet ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />正在加载工作簿…
        </div>
      ) : (
        <>
          <div className="shrink-0 space-y-1 border-b border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <p>基础预览仅显示单元格数据；公式显示文件中已保存的结果，不会重新计算。</p>
            {sheet.hasUncachedFormulas && <p>部分公式没有已保存的结果，已显示公式文本。</p>}
            {sheet.truncated && <p className="text-amber-700 dark:text-amber-400">最多预览前 1,000 行、100 列；部分内容已截断，请下载原文件查看完整数据。</p>}
          </div>

          {hasCells ? (
            <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto" aria-busy={loading}>
              <table className="border-separate border-spacing-0 text-xs" style={{ tableLayout: 'fixed', width: 48 + sheet.columnLabels.length * 160, minWidth: '100%' }}>
                <caption className="sr-only">{file.name} — {sheet.name}，第 {firstRow + 1} 至 {firstRow + visibleRows.length} 行</caption>
                <colgroup>
                  <col style={{ width: 48 }} />
                  {sheet.columnLabels.map((label) => <col key={label} style={{ width: 160 }} />)}
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 top-0 z-30 border-b border-r border-border bg-muted px-2 py-2 text-center font-medium text-muted-foreground"><span className="sr-only">行号</span></th>
                    {sheet.columnLabels.map((label) => (
                      <th key={label} scope="col" className="sticky top-0 z-20 border-b border-r border-border bg-muted px-3 py-2 text-center font-medium text-muted-foreground">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, rowIndex) => (
                    <tr key={firstRow + rowIndex} className="group hover:bg-muted/30">
                      <th scope="row" className="sticky left-0 z-10 border-b border-r border-border bg-muted px-2 py-1.5 text-right font-normal tabular-nums text-muted-foreground">{firstRow + rowIndex + 1}</th>
                      {sheet.columnLabels.map((label, columnIndex) => (
                        <td key={label} className="border-b border-r border-border px-3 py-1.5 align-top">
                          <div className="truncate" title={row[columnIndex] ?? ''}>{row[columnIndex] || '\u00a0'}</div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Table2 className="h-8 w-8" aria-hidden="true" />
              此工作表没有单元格数据
            </div>
          )}

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>{hasCells ? `${firstRow + 1}–${firstRow + visibleRows.length} 行 · ${sheet.totalRows.toLocaleString()} 行 × ${sheet.totalColumns.toLocaleString()} 列` : '空工作表'}</span>
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <button type="button" className={buttonClass} disabled={page === 0 || loading} onClick={() => changePage(page - 1)} aria-label="上一页">
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <span className="tabular-nums">{page + 1} / {pageCount}</span>
                <button type="button" className={buttonClass} disabled={page >= pageCount - 1 || loading} onClick={() => changePage(page + 1)} aria-label="下一页">
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
