type RealtimeErrorLike = {
  kind?: unknown;
  content?: unknown;
  error?: unknown;
  reason?: unknown;
  message?: unknown;
  data?: unknown;
};

type PendingTerminalArgs = {
  kind?: unknown;
  explicitSessionId: string | null;
  activeViewSessionId: string | null;
  hasPendingViewSession: boolean;
  selectedSessionId: string | null;
};

function getNestedValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  return (value as Record<string, unknown>)[key];
}

function toDisplayString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (value instanceof Error) {
    return value.message || String(value);
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return null;
}

export function getRealtimeErrorContent(message: RealtimeErrorLike): string {
  const candidates = [
    message.content,
    message.error,
    message.reason,
    getNestedValue(message.message, 'message'),
    getNestedValue(message.message, 'content'),
    message.message,
    getNestedValue(message.data, 'message'),
    getNestedValue(message.data, 'error'),
  ];

  for (const candidate of candidates) {
    const display = toDisplayString(candidate);
    if (display) {
      return display;
    }
  }

  return 'Unknown error';
}

export function isPendingViewTerminalMessage({
  kind,
  explicitSessionId,
  activeViewSessionId,
  hasPendingViewSession,
  selectedSessionId,
}: PendingTerminalArgs): boolean {
  return Boolean(
    (kind === 'error' || kind === 'complete') &&
    !explicitSessionId &&
    !activeViewSessionId &&
    hasPendingViewSession &&
    !selectedSessionId,
  );
}
