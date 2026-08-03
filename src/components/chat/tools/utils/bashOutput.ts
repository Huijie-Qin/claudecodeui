import type { ToolResult } from '../../types/types';

export interface NormalizedBashOutput {
  stdout: string;
  stderr: string;
  hasOutput: boolean;
}

// Terminal output can contain ANSI SGR/control sequences. The message list is
// plain text, so remove those sequences instead of exposing escape characters.
const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function normalizeOutputText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(ANSI_ESCAPE_PATTERN, '').trimEnd()
    : '';
}

export function normalizeBashOutput(
  toolResult: ToolResult | null | undefined,
): NormalizedBashOutput {
  if (!toolResult) {
    return { stdout: '', stderr: '', hasOutput: false };
  }

  const structured = toolResult.toolUseResult &&
    typeof toolResult.toolUseResult === 'object' &&
    !Array.isArray(toolResult.toolUseResult)
    ? toolResult.toolUseResult as Record<string, unknown>
    : null;

  const structuredStdout = normalizeOutputText(structured?.stdout);
  const structuredStderr = normalizeOutputText(structured?.stderr);
  const fallbackContent = normalizeOutputText(toolResult.content);

  // Claude commonly duplicates stdout in content. Only use content when no
  // structured stream is available, otherwise the UI would show it twice.
  const stdout = structuredStdout || (!structuredStderr ? fallbackContent : '');

  return {
    stdout,
    stderr: structuredStderr,
    hasOutput: Boolean(stdout || structuredStderr),
  };
}
