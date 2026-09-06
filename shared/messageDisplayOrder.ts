export interface DisplayOrderedMessage {
  sessionId?: string | null;
  provider?: string;
  kind?: string;
  role?: string;
  parentToolUseId?: string;
  assistantMessageId?: string;
  displayAfterAssistantId?: string;
  supplementSequence?: number;
}

/** Display-only relationships. Never use these to schedule provider input. */
export function orderSupplementMessages<T extends DisplayOrderedMessage>(messages: T[]): T[] {
  const key = (message: T, id: string) => JSON.stringify([message.provider, message.sessionId, id]);
  const lastPart = new Map<string, T>();
  for (const message of messages) {
    if (message.assistantMessageId && !message.parentToolUseId &&
        (message.role === 'assistant' || ['stream_delta', 'thinking', 'tool_use'].includes(message.kind || ''))) {
      lastPart.set(key(message, message.assistantMessageId), message);
    }
  }
  const supplements = new Map<T, T[]>();
  const moved = new Set<T>();
  for (const message of messages) {
    if (message.kind !== 'text' || message.role !== 'user' || !message.displayAfterAssistantId) continue;
    const anchor = lastPart.get(key(message, message.displayAfterAssistantId));
    // An unloaded or missing anchor must not hide or arbitrarily move a message.
    if (!anchor) continue;
    const group = supplements.get(anchor) || [];
    group.push(message);
    supplements.set(anchor, group);
    moved.add(message);
  }
  if (moved.size === 0) return messages;
  for (const group of supplements.values()) {
    group.sort((a, b) => (a.supplementSequence ?? 0) - (b.supplementSequence ?? 0));
  }
  return messages.flatMap(message => moved.has(message) ? [] : [message, ...(supplements.get(message) || [])]);
}
