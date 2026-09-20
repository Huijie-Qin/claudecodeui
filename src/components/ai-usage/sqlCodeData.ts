import type { usageRequest } from './client';
import type { DemoCodeFact } from './demoCodeData';
import type { UsageList, UsageRow } from './types';
import { assertPublishedBatch, dateInZone, reportUserName, reportWorkspaceName } from './usageUtils';

// The isolated demo's SQL-recording Hook. No guessed repository/file attribution.
export const previewSqlHookId = 'hook-sql';
export const sqlLineField = 'sqlLineCount';

export function sqlCodeFacts(records: UsageRow[], timeZone: string): DemoCodeFact[] {
  return records.flatMap(row => {
    if (row.fieldsUnavailable) throw new Error('hookNumbersUnavailable');
    if (row.hookId !== previewSqlHookId || !Array.isArray(row.fields)) return [];
    const field = row.fields.find(value => value.key === sqlLineField);
    if (!field || !('type' in field) || field.type !== 'number' || typeof field.value !== 'number' || !Number.isFinite(field.value)) return [];
    return [{ id: `sql:${row.id}`, date: dateInZone(String(row.occurredAt), timeZone),
      userId: row.userId ?? '__unknown__', workspaceId: String(row.workspaceId ?? '__unknown__'),
      userName: reportUserName(row), workspaceName: reportWorkspaceName(row), repository: '',
      generatedLines: field.value, submittedLines: 0, commitCount: 0, commitSha: '' }];
  });
}

// A pinned, complete report snapshot; never aggregate just the visible table page.
export async function loadSqlCodeFacts(params: Record<string, unknown>, signal: AbortSignal, request: typeof usageRequest, timeZone: string) {
  if (!params.batchId) throw new Error('batchMismatch');
  const records: UsageRow[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    const result = await request<UsageList>(`hooks/${previewSqlHookId}/records`, { ...params, page, pageSize: 100, sortBy: 'occurredAt', sortDir: 'asc' }, signal);
    signal.throwIfAborted();
    assertPublishedBatch(result, String(params.batchId));
    if (!Number.isSafeInteger(result.total) || result.total < 0 || result.total > 50_000
      || (total !== undefined && result.total !== total) || !Array.isArray(result.items)
      || result.items.length !== Math.min(100, result.total - records.length)) throw new Error('requestFailed');
    total = result.total;
    for (const record of result.items) {
      if (record.id == null || seen.has(String(record.id))) throw new Error('requestFailed');
      seen.add(String(record.id)); records.push(record);
    }
    if (records.length === total) return sqlCodeFacts(records, timeZone);
  }
}
