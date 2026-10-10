import type { usageRequest } from './client';
import type { ReportColumn } from './ReportTable';
import type { UsageCapabilities, UsageList, UsageRow } from './types';
import { assertPublishedBatch } from './usageUtils';

export const maxExportRows = 50_000;
const maxExportBytes = 10 * 1024 * 1024;

export async function collectExportRows({ endpoint, params, total, signal, request, onProgress }: {
  endpoint: string; params: Record<string, unknown>; total: number; signal: AbortSignal;
  request: typeof usageRequest; onProgress?: (count: number) => void;
}): Promise<UsageRow[]> {
  if (!params.batchId) throw new Error('batchMismatch');
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('exportChanged');
  if (total > maxExportRows) throw new Error('exportTooLarge');
  const authorize = async () => {
    signal.throwIfAborted();
    const access = await request<UsageCapabilities>('capabilities', { tenantId: params.tenantId, scope: params.scope }, signal);
    signal.throwIfAborted();
    if (!access.canExport || (params.scope === 'tenant' && !access.canViewTenant)) throw new Error('exportDenied');
  };
  await authorize();
  const rows: UsageRow[] = [];
  const pageSize = 100;
  for (let page = 1; page <= Math.max(1, Math.ceil(total / pageSize)); page++) {
    signal.throwIfAborted();
    const result = await request<UsageList>(endpoint, { ...params, page, pageSize }, signal);
    signal.throwIfAborted();
    assertPublishedBatch(result, String(params.batchId));
    if (result.total !== total || !Array.isArray(result.items)
      || result.items.length !== Math.min(pageSize, total - rows.length)
      || (params.groupBy && result.groupBy !== params.groupBy)) throw new Error('exportChanged');
    rows.push(...result.items);
    onProgress?.(rows.length);
  }
  // Check current authorization again before any downloaded file is created.
  await authorize();
  return rows;
}

export function csvCell(value: unknown): string {
  let text = value == null || value === '' || (typeof value === 'number' && !Number.isFinite(value)) ? '—'
    : ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '—';
  // Export text as literal text, never spreadsheet formulas supplied by names/fields.
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function reportCsv(columns: ReportColumn[], rows: UsageRow[]): string {
  const visible = columns.filter((column) => column.title.trim());
  const lines = [visible.map((column) => csvCell(column.title)).join(',')];
  let bytes = 3; // UTF-8 BOM for Excel's Chinese text detection.
  const append = (line: string) => {
    bytes += new TextEncoder().encode(line + '\r\n').byteLength;
    if (bytes > maxExportBytes) throw new Error('exportTooLarge');
  };
  append(lines[0]);
  for (const row of rows) {
    const line = visible.map((column) => csvCell(column.exportValue ? column.exportValue(row) : row[column.key])).join(',');
    append(line); lines.push(line);
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function reportExportFilename(title: string, params: Record<string, unknown>): string {
  const parts = [title, params.from, params.to, params.groupBy].filter(Boolean).map(String);
  return parts.join('_').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 160) + '.csv';
}

export function downloadReportCsv(csv: string, filename: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
