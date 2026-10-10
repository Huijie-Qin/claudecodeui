/** Redact common credentials before exposing task payloads in the conversation UI. */
export function redactVisibleSecretText(value: unknown): string {
  return String(value ?? '')
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|auth[_-]?token|private[_-]?token|user[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*\s*[:=]\s*)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/((?:["']?(?:[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|PRIVATE)[A-Z0-9_]*|api[_-]?key|auth[_-]?token|private[_-]?token|user[_-]?key|access[_-]?token|refresh[_-]?token)["']?)\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/(["']Authorization["']\s*:\s*["']Bearer\s+)[^"']+/gi, '$1[REDACTED]');
}

export function formatExecutionValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return redactVisibleSecretText(value);
  try {
    return redactVisibleSecretText(JSON.stringify(value, (_key, item) => (
      typeof item === 'bigint' ? item.toString() : item
    ), 2) ?? String(value));
  } catch {
    return redactVisibleSecretText(String(value));
  }
}

/** UI affordance only; the file API still enforces workspace and symlink boundaries. */
export function isWorkspaceExecutionOutput(path: string | undefined, workspace: string | undefined): boolean {
  if (!path || !workspace) return false;
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedRoot = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedPath.split('/').includes('..')) return false;
  if (!normalizedPath.startsWith('/') && !/^[A-Za-z]:\//.test(normalizedPath)) return true;
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}
