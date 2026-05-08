export type AdminMcpPresetStatus = 'draft' | 'published' | 'disabled';

export type McpPresetFormValues = {
  tenantId: number;
  name: string;
  displayName: string;
  description: string;
  url: string;
  headersText: string;
  status: AdminMcpPresetStatus;
};

export function normalizeMcpPresetName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
}

export function parseHeadersText(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, entry]) => key.trim() && entry !== null && entry !== undefined && String(entry).trim())
        .map(([key, entry]) => [key.trim(), String(entry).trim()]),
    );
  }

  return Object.fromEntries(
    trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.includes(':') ? line.indexOf(':') : line.indexOf('=');
        if (separatorIndex <= 0) {
          throw new Error('Headers must be JSON or one key/value pair per line');
        }
        return [
          line.slice(0, separatorIndex).trim(),
          line.slice(separatorIndex + 1).trim(),
        ];
      })
      .filter(([key, entry]) => key && entry),
  );
}

export function buildMcpPresetPayload(values: McpPresetFormValues) {
  return {
    tenantId: values.tenantId,
    name: normalizeMcpPresetName(values.name),
    displayName: values.displayName.trim(),
    description: values.description.trim(),
    status: values.status,
    type: 'http' as const,
    url: values.url.trim(),
    headers: parseHeadersText(values.headersText),
  };
}
