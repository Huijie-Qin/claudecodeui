export type RuntimeMonitorFilterValue = string | number | null | undefined;

export type RuntimeMonitorFilters = {
  tenantId?: RuntimeMonitorFilterValue;
  userId?: RuntimeMonitorFilterValue;
  workspaceId?: RuntimeMonitorFilterValue;
  status?: RuntimeMonitorFilterValue;
  dockerState?: RuntimeMonitorFilterValue;
  provider?: RuntimeMonitorFilterValue;
  q?: RuntimeMonitorFilterValue;
  limit?: RuntimeMonitorFilterValue;
  offset?: RuntimeMonitorFilterValue;
  [key: string]: RuntimeMonitorFilterValue;
};

export function buildRuntimeQueryString(filters: RuntimeMonitorFilters = {}): string {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value === null || value === undefined) return;

    const trimmedValue = String(value).trim();
    if (!trimmedValue) return;

    params.append(key, trimmedValue);
  });

  const queryString = params.toString();
  return queryString ? `?${queryString}` : '';
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  if (value === 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.max(
    0,
    Math.min(Math.floor(Math.log(Math.abs(value)) / Math.log(1024)), units.length - 1),
  );
  const scaledValue = value / 1024 ** unitIndex;

  return unitIndex === 0 ? `${Math.round(scaledValue)} B` : `${scaledValue.toFixed(1)} ${units[unitIndex]}`;
}

export function formatRuntimeAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '-';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

  return `${Math.floor(seconds / 3600)}h`;
}

export function runtimeRowContainsHostPath(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;

  return (
    Object.prototype.hasOwnProperty.call(row, 'workspaceHostPath') ||
    Object.prototype.hasOwnProperty.call(row, 'runtimeHomePath') ||
    Object.prototype.hasOwnProperty.call(row, 'workspace_host_path') ||
    Object.prototype.hasOwnProperty.call(row, 'runtime_home_path')
  );
}
