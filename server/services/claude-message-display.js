/** Carries Anthropic's message identity across partial and canonical output. */
export function createClaudeMessageDisplayTracker() {
  const messageIds = new Map();
  const streamedIds = new Set();
  const mainIds = new Set();
  let mainStreaming = false;
  return {
    observe(message) {
      const scope = message.parent_tool_use_id || '';
      const event = message.type === 'stream_event' ? message.event : null;
      const id = event?.type === 'message_start' ? event.message?.id
        : message.type === 'assistant' ? message.message?.id : null;
      if (!scope && event?.type === 'message_start') mainStreaming = true;
      if (!scope && (event?.type === 'message_stop' || message.type === 'result')) mainStreaming = false;
      if (typeof id === 'string' && id) {
        if (!scope) mainIds.add(id);
        if (event?.type === 'message_start') {
          streamedIds.add(id);
          messageIds.set(scope, id);
        } else if (!streamedIds.has(id)) {
          messageIds.set(scope, id);
        }
      }
      const assistantMessageId = id || messageIds.get(scope);
      return assistantMessageId && (event || message.type === 'assistant')
        ? { ...message, assistantMessageId }
        : message;
    },
    getMainMessageId() {
      return messageIds.get('') || null;
    },
    getActiveMainMessageId() {
      return mainStreaming ? messageIds.get('') || null : null;
    },
    hasMainMessageId(id) {
      return mainIds.has(id);
    },
  };
}
