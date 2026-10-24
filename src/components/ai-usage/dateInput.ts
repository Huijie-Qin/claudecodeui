// Parse calendar dates explicitly: browser Date.parse is locale/timezone dependent
// and silently rolls impossible dates into a following month.
export function normalizeUsageDate(value: string): string | null {
  const text = value.trim();
  const separated = text.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/);
  const chinese = text.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  const parts = separated ? [separated[1], separated[3], separated[4]] : chinese?.slice(1) || compact?.slice(1);
  if (!parts) return null;
  const [year, month, day] = parts.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
