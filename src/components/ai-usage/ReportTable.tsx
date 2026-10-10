import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../shared/view/ui';

import type { UsageRow } from './types';
import { displayReportValue } from './usageUtils';

export type ReportSort = { sortBy: string; sortDir: 'asc' | 'desc' };
export type ReportColumn = { key: string; title: string; sortKey?: string; numeric?: boolean; render?: (row: UsageRow) => ReactNode; exportValue?: (row: UsageRow) => unknown };
export function ReportTable({ columns, rows, empty, sort, onSort, disabled = false, compact = false }: {
  columns: ReportColumn[]; rows: UsageRow[]; empty: string; sort?: ReportSort;
  onSort?: (key: string) => void; disabled?: boolean; compact?: boolean;
}) {
  const { t } = useTranslation('aiUsage');
  const numeric = (column: ReportColumn) => column.numeric ?? /(?:Count|Lines|DurationMs|^(?:sum|average|min|max|ratio|dau|mau)$)/.test(column.key);
  return <div className="overflow-x-auto"><table className="ai-report-table w-full text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{columns.map((column) => {
    const sortable = Boolean(column.sortKey && onSort);
    const selected = sortable && sort?.sortBy === column.sortKey;
    const Icon = selected ? sort?.sortDir === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown;
    return <th className={`${numeric(column) ? 'ai-report-numeric' : ''} whitespace-nowrap ${compact ? 'px-3' : 'px-5'} py-3 font-medium`} key={column.key} aria-sort={sortable ? selected ? sort?.sortDir === 'asc' ? 'ascending' : 'descending' : 'none' : undefined}>
      {sortable ? <button type="button" disabled={disabled} className="inline-flex items-center gap-1.5 rounded text-left hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        aria-label={t('sortColumn', { name: column.title })} onClick={() => onSort?.(column.sortKey!)}>{column.title}<Icon className="h-3.5 w-3.5" /></button> : column.title}
    </th>;
  })}</tr></thead><tbody className="divide-y divide-border">{rows.map((row, index) => <tr key={String(row.id ?? `${row.groupKey ?? row.userId ?? row.hookId ?? row.templateId ?? ''}:${row.postActionId ?? ''}:${index}`)} className="hover:bg-muted/25">{columns.map((column) => <td className={`${numeric(column) ? 'ai-report-numeric' : ''} max-w-[320px] break-words ${compact ? 'px-3' : 'px-5'} py-4 align-top`} key={column.key}>{column.render ? column.render(row) : displayReportValue(row[column.key])}</td>)}</tr>)}</tbody></table>{rows.length === 0 && <p className="px-6 py-12 text-center text-sm text-muted-foreground">{empty}</p>}</div>;
}

export function ReportPagination({ page, total, onPage, disabled = false, pageSize = 20, onPageSize }: {
  page: number; total: number; onPage: (page: number) => void; disabled?: boolean;
  pageSize?: number; onPageSize?: (size: number) => void;
}) {
  const { t } = useTranslation('aiUsage');
  return <div className="ai-report-pagination flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-muted-foreground">
    <span>{t('page', { page, total })}</span><div className="flex items-center gap-3">
      {onPageSize && <label className="flex items-center gap-2">{t('pageSize')}<select aria-label={t('pageSize')} className="h-8 rounded border border-input bg-background px-2 text-foreground" value={pageSize} disabled={disabled} onChange={(event) => onPageSize(Number(event.target.value))}>{[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
      <Button size="sm" variant="outline" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}>{t('previous')}</Button><Button size="sm" variant="outline" disabled={disabled || page * pageSize >= total} onClick={() => onPage(page + 1)}>{t('next')}</Button>
    </div></div>;
}
