type McpToolParametersProps = {
  inputSchema?: Record<string, unknown>;
  label: string;
};

export function McpToolParameters({ inputSchema, label }: McpToolParametersProps) {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return null;
  }

  return (
    <details className="mt-2 rounded-md border border-border bg-background/70">
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <pre className="max-h-56 overflow-auto border-t border-border px-2.5 py-2 font-mono text-xs leading-5 text-foreground">
        {JSON.stringify(inputSchema, null, 2)}
      </pre>
    </details>
  );
}
