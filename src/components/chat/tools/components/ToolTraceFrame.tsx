import type { ReactNode } from 'react';

export function ToolTraceFrame({ command = false, children }: { command?: boolean; children: ReactNode }) {
  return <div className={command
    ? 'my-2 rounded-r-md border-l-2 border-green-500/50 bg-muted/20 py-1.5 pl-2.5 pr-1 dark:border-green-400/40 dark:bg-muted/10'
    : undefined}>{children}</div>;
}
