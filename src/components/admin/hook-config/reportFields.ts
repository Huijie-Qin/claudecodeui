export type HookReportField = {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  unit?: string;
  aggregation: 'sum' | 'avg' | 'min' | 'max' | 'none';
};

export function isReportFieldKey(key: string): boolean {
  return key.length <= 200 && /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
}

export function readHookReportFields(value: unknown): HookReportField[] {
  if (!Array.isArray(value)) return [];
  return value.filter((field): field is HookReportField => Boolean(field)
    && typeof field === 'object' && typeof field.key === 'string' && typeof field.label === 'string'
    && ['number', 'string', 'boolean'].includes(field.type) && ['sum', 'avg', 'min', 'max', 'none'].includes(field.aggregation));
}

// Renaming or deleting a field never silently opts a different field into reports.
export function retainHookReportFields(value: unknown, fields: Record<string, unknown>): HookReportField[] {
  return readHookReportFields(value).filter((field) => Object.prototype.hasOwnProperty.call(fields, field.key));
}

export function changeHookReportFieldType(field: HookReportField, type: HookReportField['type']): HookReportField {
  return { ...field, type, aggregation: type === 'number' ? field.aggregation : 'none' };
}
