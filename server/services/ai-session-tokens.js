import { normalizeTimestamp } from './ai-usage-config.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const add = values => values.some(value => value === null) ? null : count(values.reduce((a, b) => a + b, 0));

// Provider formats, not a sum of every field named "tokens". Nested cache
// breakdowns and reasoning tokens are subsets of their parent totals.
export function tokenTotal(provider, usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (provider === 'claude') return add([
    count(usage.input_tokens), count(usage.output_tokens),
    count(usage.cache_read_input_tokens ?? 0), count(usage.cache_creation_input_tokens ?? 0),
  ]);
  if (provider === 'codex') {
    // cached_input_tokens is already in input_tokens; reasoning_output_tokens
    // is already in output_tokens. Prefer the provider's complete total.
    return count(usage.total_tokens) ?? add([count(usage.input_tokens), count(usage.output_tokens)]);
  }
  return null;
}

export function createSessionTokenAccumulator(provider, through) {
  const responses = new Map();
  let cumulative = null;
  let unknown = false;
  let end = null;
  const before = value => {
    const time = normalizeTimestamp(value);
    return time && time < through ? time : null;
  };
  return {
    invalidate() { unknown = true; },
    observe(raw, { fallbackTime, isMain = true } = {}) {
      if (isInheritedUsageMessage(raw)) return;
      const time = before(raw?.timestamp || fallbackTime);
      if (!time) return;
      if (provider === 'codex' && raw.type === 'event_msg' && raw.payload?.type === 'token_count') {
        const total = tokenTotal(provider, raw.payload.info?.total_token_usage);
        if (total !== null && (!cumulative || time >= cumulative.time)) cumulative = { time, total };
        else if (total === null) unknown = true;
        return;
      }
      if (provider !== 'claude') return;
      const envelope = raw.type === 'claude-response' ? raw.data : raw;
      const message = envelope?.message;
      if (!message || (envelope.type !== 'assistant' && message.role !== 'assistant')) return;
      // UUIDs identify log fragments. message.id identifies the actual model
      // response and survives fragment duplication and transcript copying.
      if (!message.id) { unknown = true; return; }
      const total = tokenTotal(provider, message.usage);
      const previous = responses.get(message.id);
      // Usage can mature over streaming fragments. Keep the newest complete
      // observation; missing early fragments must not poison a later final one.
      if (!previous || (total !== null && (previous.total === null || time >= previous.time))) {
        responses.set(message.id, { time, total });
      }
      if (isMain && !envelope.parent_tool_use_id && !envelope.agent_id
        && ['end_turn', 'stop_sequence'].includes(message.stop_reason)) {
        if (!end || time > end) end = time;
      }
    },
    result() {
      const totals = [...responses.values()].map(value => value.total);
      return { total: unknown ? null : provider === 'codex' ? cumulative?.total ?? null
        : totals.length ? add(totals) : null, end };
    },
  };
}
