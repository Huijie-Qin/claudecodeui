import type { TaskNotificationDetails, TaskNotificationUsageValue } from '../types/types';

import { decodeHtmlEntities, unescapeWithMathProtection } from './chatFormatting';

const TASK_NOTIFICATION_PATTERN = /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification\s*>/i;
const XML_FIELD_PATTERN = /<([a-zA-Z][\w:-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g;
const KNOWN_FIELDS = new Set([
  'task-id',
  'tool-use-id',
  'output-file',
  'status',
  'summary',
  'result',
  'usage',
]);

function normalizeFieldValue(value: string): string {
  return unescapeWithMathProtection(decodeHtmlEntities(value.trim()));
}

function parseFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const match of content.matchAll(XML_FIELD_PATTERN)) {
    const fieldName = match[1]?.toLowerCase();
    if (!fieldName) {
      continue;
    }
    fields[fieldName] = normalizeFieldValue(match[2] || '');
  }

  return fields;
}

function parseUsageValue(value: string): TaskNotificationUsageValue {
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && (!Number.isInteger(numericValue) || Number.isSafeInteger(numericValue))) {
      return numericValue;
    }
  }

  return value;
}

/**
 * Parse Claude Code's synthetic task notification user message.
 *
 * Claude has changed this payload over time, so parsing is intentionally
 * order-independent and preserves unknown top-level and usage fields.
 */
export function parseTaskNotification(content: string): TaskNotificationDetails | null {
  const notificationMatch = TASK_NOTIFICATION_PATTERN.exec(content);
  if (!notificationMatch) {
    return null;
  }

  const fields = parseFields(notificationMatch[1] || '');
  const usageFields = fields.usage ? parseFields(fields.usage) : {};
  const usage = Object.fromEntries(
    Object.entries(usageFields).map(([name, value]) => [name, parseUsageValue(value)]),
  );
  const extraFields = Object.fromEntries(
    Object.entries(fields).filter(([name]) => !KNOWN_FIELDS.has(name)),
  );

  return {
    taskId: fields['task-id'],
    toolUseId: fields['tool-use-id'],
    outputFile: fields['output-file'],
    status: fields.status || 'completed',
    summary: fields.summary || '',
    result: fields.result,
    usage,
    rawUsage: fields.usage,
    extraFields,
    raw: notificationMatch[0],
  };
}

export function isTaskNotificationTerminal(status: string): boolean {
  const normalizedStatus = status.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return !['pending', 'running', 'in_progress', 'waiting', 'queued'].includes(normalizedStatus);
}

export function isTaskNotificationError(status: string): boolean {
  const normalizedStatus = status.trim().toLowerCase();
  return [
    'failed',
    'error',
    'cancelled',
    'canceled',
    'timed_out',
    'timeout',
    'stopped',
    'killed',
    'aborted',
    'interrupted',
  ].includes(normalizedStatus);
}

export function formatTaskNotificationUsageLabel(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
