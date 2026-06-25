import { useMemo } from 'react';

type DiffRow = {
  key: string;
  type: 'context' | 'change' | 'hunk' | 'meta';
  oldLine: number | null;
  newLine: number | null;
  oldText: string;
  newText: string;
};

type PendingDelete = {
  oldLine: number;
  text: string;
};

type CodeHubSideBySideDiffProps = {
  diff: string;
};

const PREVIEW_CHARACTER_LIMIT = 200_000;
const PREVIEW_LINE_LIMIT = 2_000;

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return null;
  return {
    oldLine: Number(match[1]),
    newLine: Number(match[2]),
  };
}

function parseUnifiedDiff(diff: string): { rows: DiffRow[]; truncated: boolean } {
  const truncatedByCharacters = diff.length > PREVIEW_CHARACTER_LIMIT;
  const previewText = truncatedByCharacters ? diff.slice(0, PREVIEW_CHARACTER_LIMIT) : diff;
  const rawLines = previewText.split('\n');
  const truncatedByLines = rawLines.length > PREVIEW_LINE_LIMIT;
  const lines = truncatedByLines ? rawLines.slice(0, PREVIEW_LINE_LIMIT) : rawLines;
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let pendingDeletes: PendingDelete[] = [];

  const flushDeletes = () => {
    for (const deletion of pendingDeletes) {
      rows.push({
        key: `delete-${rows.length}`,
        type: 'change',
        oldLine: deletion.oldLine,
        newLine: null,
        oldText: deletion.text,
        newText: '',
      });
    }
    pendingDeletes = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      flushDeletes();
      continue;
    }

    if (line.startsWith('@@')) {
      flushDeletes();
      const parsed = parseHunkHeader(line);
      if (parsed) {
        oldLine = parsed.oldLine;
        newLine = parsed.newLine;
      }
      rows.push({
        key: `hunk-${rows.length}`,
        type: 'hunk',
        oldLine: null,
        newLine: null,
        oldText: line,
        newText: line,
      });
      continue;
    }

    if (line.startsWith('-')) {
      pendingDeletes.push({
        oldLine,
        text: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith('+')) {
      const pairedDelete = pendingDeletes.shift();
      rows.push({
        key: `change-${rows.length}`,
        type: 'change',
        oldLine: pairedDelete?.oldLine ?? null,
        newLine,
        oldText: pairedDelete?.text ?? '',
        newText: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    flushDeletes();
    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({
      key: `context-${rows.length}`,
      type: 'context',
      oldLine,
      newLine,
      oldText: text,
      newText: text,
    });
    oldLine += 1;
    newLine += 1;
  }

  flushDeletes();
  return {
    rows,
    truncated: truncatedByCharacters || truncatedByLines,
  };
}

function lineNumber(value: number | null): string {
  return value == null ? '' : String(value);
}

export default function CodeHubSideBySideDiff({ diff }: CodeHubSideBySideDiffProps) {
  const parsed = useMemo(() => parseUnifiedDiff(diff || ''), [diff]);

  if (!diff) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Select a changed file to view diff.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background">
      {parsed.truncated ? (
        <div className="m-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Large diff preview: rendering is limited to keep the tab responsive.
        </div>
      ) : null}
      <div className="grid min-w-[980px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground">
        <div className="border-r border-border px-3 py-2">Before</div>
        <div className="px-3 py-2">After</div>
      </div>
      <div className="min-w-[980px] font-mono text-xs leading-5">
        {parsed.rows.map((row) => {
          if (row.type === 'hunk' || row.type === 'meta') {
            return (
              <div
                key={row.key}
                className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border/50 ${
                  row.type === 'hunk' ? 'bg-primary/5 text-primary' : 'bg-muted/30 text-muted-foreground'
                }`}
              >
                <div className="truncate border-r border-border px-3 py-1">{row.oldText}</div>
                <div className="truncate px-3 py-1">{row.newText}</div>
              </div>
            );
          }

          const oldChanged = row.type === 'change' && row.oldText !== '';
          const newChanged = row.type === 'change' && row.newText !== '';

          return (
            <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-border/30">
              <div className={`grid grid-cols-[56px_minmax(0,1fr)] border-r border-border ${oldChanged ? 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200' : 'text-muted-foreground'}`}>
                <div className="select-none border-r border-border/50 px-2 py-0.5 text-right text-muted-foreground/70">
                  {lineNumber(row.oldLine)}
                </div>
                <div className="whitespace-pre-wrap break-words px-2 py-0.5">{row.oldText}</div>
              </div>
              <div className={`grid grid-cols-[56px_minmax(0,1fr)] ${newChanged ? 'bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-200' : 'text-muted-foreground'}`}>
                <div className="select-none border-r border-border/50 px-2 py-0.5 text-right text-muted-foreground/70">
                  {lineNumber(row.newLine)}
                </div>
                <div className="whitespace-pre-wrap break-words px-2 py-0.5">{row.newText}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
