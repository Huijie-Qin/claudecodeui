import { authenticatedFetch } from '../../utils/api';

import { buildUsageUrl } from './usageUtils';

export class UsageApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function usageRequest<T>(path: string, params: Record<string, unknown>, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await authenticatedFetch(buildUsageUrl(path, params), {
    signal,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new UsageApiError(response.status, data.code || 'requestFailed', data.error || data.message || 'requestFailed');
  // An explicit marker from the isolated fixture server, never inferred from a port or tenant ID.
  if (path === 'capabilities') data.simulation = response.headers.get('X-AI-Usage-Preview') === 'fixture-only';
  return data as T;
}

export async function downloadUsageExport(tenantId: number, jobId: string, signal: AbortSignal): Promise<void> {
  const response = await authenticatedFetch(buildUsageUrl(`exports/${encodeURIComponent(jobId)}/download`, { tenantId }), { signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new UsageApiError(response.status, data.code || 'requestFailed', data.error || 'requestFailed');
  }
  const blob = await response.blob();
  if (signal.aborted) return;
  const disposition = response.headers.get('Content-Disposition') || '';
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let filename = disposition.match(/filename="([^"]+)"/i)?.[1] || `ai-report-${jobId}`;
  if (encodedName) { try { filename = decodeURIComponent(encodedName); } catch { /* Use the plain filename. */ } }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename.replace(/[\\/]/g, '_');
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
