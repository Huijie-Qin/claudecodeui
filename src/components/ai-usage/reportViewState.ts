// View preferences only: never cache report rows, credentials, or identities in storage.
export type ReportViewEntry = { queryKey: string; value: Record<string, unknown> };
export type ReportViewStore = Map<string, ReportViewEntry>;

export function restoreReportView<T extends { page: number }>(store: ReportViewStore | null, key: string, queryKey: string, defaults: T): T {
  const entry = store?.get(key);
  if (!entry) return defaults;
  return { ...defaults, ...entry.value, page: entry.queryKey === queryKey ? Number(entry.value.page || 1) : 1 } as T;
}
