import type { ChatMessage } from '../types/types';
import { getIntrinsicMessageKey } from './messageKeys';

// Only walk UI wrappers recreated by normalization. Never deep-compare MCP
// payloads, input/output, or entire 3000-row results during a polling update.
const wrappers = new Set(['hookActivity', 'followups', 'messages', 'subagentState', 'childTools', 'actionResults']);
function share(previous: unknown, next: unknown, walk = true): unknown {
  if (Object.is(previous, next)) return previous;
  if (previous instanceof Date && next instanceof Date && +previous === +next) return previous;
  if (!walk || !previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const items = next.map((value, index) => share(previous[index], value));
    return previous.length === items.length && items.every((value, index) => value === previous[index]) ? previous : items;
  }
  if (Array.isArray(previous) || Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let equal = Object.keys(before).length === keys.length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = share(before[key], after[key], wrappers.has(key));
    if (!Object.prototype.hasOwnProperty.call(before, key) || result[key] !== before[key]) equal = false;
  }
  return equal ? previous : result;
}

export function preserveChatMessageReferences(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const byKey = new Map<string, ChatMessage[]>();
  for (const message of previous) {
    const key = getIntrinsicMessageKey(message);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), message]);
  }
  const result = next.map((message) => {
    const key = getIntrinsicMessageKey(message);
    const before = key ? byKey.get(key)?.shift() : undefined;
    return before ? share(before, message) as ChatMessage : message;
  });
  return previous.length === result.length && result.every((message, index) => message === previous[index]) ? previous : result;
}
