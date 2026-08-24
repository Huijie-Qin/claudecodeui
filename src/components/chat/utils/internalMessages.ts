const CLAUDE_INTERNAL_CONTENT_MARKERS = [
  'Base directory for this skill:',
] as const;

const CLAUDE_INTERNAL_CONTENT_PATTERNS = [
  /^\s*<ccui-hook-recovery\b[^>]*>/i,
  /^\s*<[^>\n]*skill[^>\n]*>/i,
  /^\s*skill\s+(?:body|content|detail|details|instructions|parameters|params|arguments|args)\s*:/i,
] as const;

export function isClaudeInternalUserContent(content: unknown): boolean {
  if (typeof content !== 'string') {
    return false;
  }

  const normalizedContent = content.trimStart();
  if (!normalizedContent) {
    return false;
  }

  return (
    CLAUDE_INTERNAL_CONTENT_MARKERS.some((marker) => normalizedContent.includes(marker)) ||
    CLAUDE_INTERNAL_CONTENT_PATTERNS.some((pattern) => pattern.test(normalizedContent))
  );
}
