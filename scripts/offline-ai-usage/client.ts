import { createOfflineDatabase } from './database.mjs';
import { createOfflineService, UsageApiError } from './service.mjs';
export { UsageApiError };

let userId = 2;
export function selectOfflineUser(id: number) { userId = id; }
let ready: Promise<ReturnType<typeof createOfflineService>> | undefined;
function initialize() {
  ready ??= (async () => {
    const SQL = await (globalThis as unknown as { initSqlJs: () => Promise<unknown> }).initSqlJs();
    const snapshot = JSON.parse(document.getElementById('offline-snapshot')!.textContent!);
    return createOfflineService(createOfflineDatabase(SQL, snapshot));
  })();
  return ready;
}
export async function usageRequest<T>(path: string, params: Record<string, unknown>, signal?: AbortSignal, body?: unknown): Promise<T> {
  const requestUser = userId;
  signal?.throwIfAborted();
  const request = await initialize();
  signal?.throwIfAborted();
  const result = request(path, params, requestUser, body);
  signal?.throwIfAborted();
  return JSON.parse(JSON.stringify(result)) as T;
}
export async function downloadUsageExport(): Promise<void> {
  throw new UsageApiError(503, 'exportUnconfigured', '离线演示不运行异步导出服务');
}
