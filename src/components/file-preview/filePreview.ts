/** Read a preview without buffering an unbounded response (including chunked responses). */
export async function readPreviewBlob(response: Response, limitBytes: number, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `文件加载失败（${response.status}）`);
  }
  const tooLarge = () => new Error(`文件超过 ${Math.round(limitBytes / 1024 / 1024)} MB 预览上限，请下载原文件查看。`);
  if (Number(response.headers.get('content-length')) > limitBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  signal?.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    signal?.throwIfAborted();
    if (blob.size > limitBytes) throw tooLarge();
    return blob;
  }
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

export function savePreviewBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Delay revocation so browsers have time to start the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
