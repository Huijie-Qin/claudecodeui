import { useEffect, useRef, useState } from 'react';
import { Download, Maximize, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { api } from '../../../utils/api';
import { readPreviewBlob } from '../../file-preview/filePreview';
import { downloadOriginalFile } from '../../file-preview/filePreviewDownload';
import { useFilePreviewRefresh } from '../../file-preview/useFilePreviewRefresh';
import type { FileTreeImageSelection } from '../types/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
  variant?: 'modal' | 'inline';
};

const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024;
const MIN_SCALE = 0.01;
const MAX_SCALE = 8;

export default function ImageViewer({ file, onClose, variant = 'modal' }: ImageViewerProps) {
  const fileRevision = useFilePreviewRefresh(file);
  const viewportRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const activeUrlRef = useRef<string | null>(null);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const updateSize = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();
    requestRef.current = controller;
    const timeoutId = setTimeout(() => {
      controller.abort();
      activeUrlRef.current = null;
      setLoading(false);
      setError('图片加载超时，请重试或下载原图查看。');
    }, 30_000);
    loadTimeoutRef.current = timeoutId;

    const loadImage = async () => {
      setLoading(true);
      setError(null);
      setDownloadError(null);
      setDownloading(false);
      setImageUrl(null);
      setDimensions(null);
      setZoom(null);
      viewportRef.current?.scrollTo({ top: 0, left: 0 });
      try {
        const response = await api.readFileBlob(file.projectName, file.path, file.workspaceId, {
          signal: controller.signal,
        });
        const blob = await readPreviewBlob(response, IMAGE_PREVIEW_LIMIT, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        activeUrlRef.current = objectUrl;
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (controller.signal.aborted) return;
        clearTimeout(timeoutId);
        setError(loadError instanceof Error ? loadError.message : '无法加载图片');
        setLoading(false);
      }
    };

    void loadImage();
    return () => {
      controller.abort();
      clearTimeout(timeoutId);
      activeUrlRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.projectName, file.path, file.workspaceId, retry, fileRevision]);

  const fitScale = dimensions
    ? Math.min(1, Math.max(1, viewport.width - 32) / dimensions.width, Math.max(1, viewport.height - 32) / dimensions.height)
    : 1;
  const scale = zoom ?? fitScale;
  const imageWidth = dimensions ? Math.max(1, dimensions.width * scale) : 0;
  const imageHeight = dimensions ? Math.max(1, dimensions.height * scale) : 0;
  const canZoom = !!dimensions && !loading && !error;

  const downloadImage = async () => {
    const request = requestRef.current;
    setDownloading(true);
    setDownloadError(null);
    try {
      if (imageUrl) {
        const anchor = document.createElement('a');
        anchor.href = imageUrl;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } else {
        await downloadOriginalFile(file, file.projectPath);
      }
    } catch (downloadFailure: unknown) {
      if (!request?.signal.aborted) {
        setDownloadError(downloadFailure instanceof Error ? downloadFailure.message : '下载失败，请重试');
      }
    } finally {
      if (!request?.signal.aborted) setDownloading(false);
    }
  };

  const viewer = (
    <div className={variant === 'inline'
      ? 'flex h-full w-full flex-col overflow-hidden bg-background'
      : 'mx-4 flex h-[85vh] max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800'}>
      {variant === 'modal' && (
        <div className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3">
          <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">{file.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 shrink-0 p-0" aria-label="关闭图片预览"><X className="h-4 w-4" /></Button>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => setZoom(Math.max(MIN_SCALE, scale / 1.25))} disabled={!canZoom || scale <= MIN_SCALE} className="h-8 w-8 p-0" aria-label="缩小" title="缩小"><ZoomOut className="h-4 w-4" /></Button>
        <span className="min-w-12 text-center text-xs tabular-nums text-gray-600 dark:text-gray-400">{canZoom ? `${Math.round(scale * 100)}%` : '—'}</span>
        <Button variant="ghost" size="sm" onClick={() => setZoom(Math.min(MAX_SCALE, scale * 1.25))} disabled={!canZoom || scale >= MAX_SCALE} className="h-8 w-8 p-0" aria-label="放大" title="放大"><ZoomIn className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(null)} disabled={!canZoom} className="h-8 gap-1 px-2 text-xs" aria-pressed={zoom === null}><Maximize className="h-3.5 w-3.5" />适应窗口</Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(1)} disabled={!canZoom} className="h-8 px-2 text-xs" aria-pressed={zoom === 1}>100%</Button>
        <Button variant="ghost" size="sm" onClick={() => void downloadImage()} disabled={downloading} className="ml-auto h-8 gap-1 px-2 text-xs"><Download className="h-3.5 w-3.5" />{downloading ? '下载中…' : '下载原图'}</Button>
      </div>
      {downloadError && <p role="alert" className="shrink-0 border-b px-4 py-2 text-xs text-red-600 dark:text-red-400">{downloadError}</p>}

      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-auto bg-gray-50 dark:bg-gray-900" aria-busy={loading}>
        {loading && <div className="flex h-full min-h-32 items-center justify-center text-sm text-gray-500 dark:text-gray-400" role="status">正在加载图片…</div>}
        {imageUrl && !error && (
          <div
            className="grid min-h-full min-w-full place-items-center p-4"
            style={dimensions ? { width: imageWidth + 32, height: imageHeight + 32 } : { position: 'absolute', inset: 0 }}
          >
            <img
              key={imageUrl}
              src={imageUrl}
              alt={file.name}
              draggable={false}
              className="block max-w-none rounded shadow-sm"
              style={{ width: imageWidth || undefined, height: imageHeight || undefined, visibility: dimensions ? 'visible' : 'hidden' }}
              onLoad={(event) => {
                if (activeUrlRef.current !== imageUrl) return;
                clearTimeout(loadTimeoutRef.current);
                const image = event.currentTarget;
                if (!image.naturalWidth || !image.naturalHeight) {
                  setError('无法显示此图片，文件可能已损坏或格式不受浏览器支持。');
                } else {
                  setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
                }
                setLoading(false);
              }}
              onError={() => {
                if (activeUrlRef.current !== imageUrl) return;
                clearTimeout(loadTimeoutRef.current);
                setError('无法显示此图片，文件可能已损坏或格式不受浏览器支持。');
                setLoading(false);
              }}
            />
          </div>
        )}
        {error && (
          <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center text-sm text-gray-500 dark:text-gray-400" role="alert">
            <p>{error}</p>
            <p className="text-xs">图片预览最大支持 20 MB。</p>
            <Button variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)} className="gap-1"><RotateCw className="h-3.5 w-3.5" />重试</Button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t bg-gray-50 px-4 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
        <p className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</p>
        {dimensions && <span className="shrink-0 tabular-nums">{dimensions.width} × {dimensions.height} px</span>}
      </div>
    </div>
  );

  if (variant === 'inline') return viewer;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" role="dialog" aria-modal="true" aria-label={`图片预览：${file.name}`}>
      {viewer}
    </div>
  );
}
