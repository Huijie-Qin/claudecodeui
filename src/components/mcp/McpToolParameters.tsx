type McpToolParametersProps = {
  inputSchema?: Record<string, unknown>;
  label: string;
};

type McpToolParameter = {
  key: string;
  description: string;
};

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDescription(value: unknown): string {
  const record = readObject(value);
  const description = record?.description;
  return typeof description === 'string' ? description.trim() : '';
}

function getParameterEntries(inputSchema: Record<string, unknown>): McpToolParameter[] {
  const properties = readObject(inputSchema.properties);
  if (!properties) {
    return [];
  }

  return Object.entries(properties)
    .map(([key, value]) => ({
      key,
      description: readDescription(value),
    }))
    .filter((entry) => entry.key.trim());
}

export function McpToolParameters({ inputSchema, label }: McpToolParametersProps) {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return null;
  }

  const parameters = getParameterEntries(inputSchema);
  if (parameters.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-background/70 px-2.5 py-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <dl className="mt-1.5 grid gap-1.5">
        {parameters.map((parameter) => (
          <div key={parameter.key} className="grid gap-0.5">
            <dt className="break-words font-mono text-xs font-semibold text-foreground">
              {parameter.key}
            </dt>
            {parameter.description ? (
              <dd className="text-xs leading-5 text-muted-foreground">
                {parameter.description}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </div>
  );
}
