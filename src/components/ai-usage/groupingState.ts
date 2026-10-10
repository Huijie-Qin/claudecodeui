export const timeGroups = ['day', 'week', 'month'] as const;
export function isTimeGroup(value: string) { return (timeGroups as readonly string[]).includes(value); }
export function splitReportGroups(options: readonly string[]) {
  return { objects: options.filter(value => !isTimeGroup(value)), periods: options.filter(isTimeGroup) };
}

/** Display only; stable API group keys, ordering and aggregation remain unchanged. */
export function reportGroupLabel(group: string, raw: unknown, range: { from?: unknown; to?: unknown } = {}): string {
  const value = raw == null ? '—' : String(raw);
  if (!isTimeGroup(group)) return value;
  const start = group === 'month' ? `${value}-01` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) return value;
  const date = new Date(`${start}T00:00:00Z`);
  if (group === 'week') date.setUTCDate(date.getUTCDate() + 6);
  if (group === 'month') date.setUTCMonth(date.getUTCMonth() + 1, 0);
  const end = date.toISOString().slice(0, 10);
  const from = typeof range.from === 'string' && range.from > start ? range.from : start;
  const to = typeof range.to === 'string' && range.to < end ? range.to : end;
  if (from > to) return value;
  const format = (day: string) => day.replace(/-/g, '/');
  if (group === 'day') return format(start);
  if (group === 'week') return `${format(from)} — ${format(to)}`;
  return from === start && to === end ? value.replace('-', '/') : `${value.replace('-', '/')} (${from.slice(5).replace('-', '/')}–${to.slice(5).replace('-', '/')})`;
}
