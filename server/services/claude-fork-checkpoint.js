// Use provider-native messages rather than the UI's split/merged message ids.
export function isClaudeForkReply(entry) {
  if (!entry || entry.type !== 'assistant' || typeof entry.uuid !== 'string'
    || !entry.uuid || entry.isSidechain || entry.is_sidechain || entry.parent_tool_use_id || entry.parentToolUseId
    || entry.isMeta || entry.is_meta || entry.isApiErrorMessage) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return Boolean(content.trim());
  return Array.isArray(content)
    && content.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
    && !content.some(part => part?.type === 'tool_use');
}

/**
 * Older CLI transcripts may omit stop_reason. For those, a persisted turn
 * boundary or a marker recorded from a successful SDK end_turn is required.
 * The session's current status cannot establish completion of earlier turns.
 * Pending tool uses and interrupted/error replies never form a checkpoint.
 */
export function collectClaudeForkCheckpoints(entries, { completedReplyUuids = new Set() } = {}) {
  const checkpoints = new Set();
  const pendingTools = new Map();
  const mainEntries = entries.filter(entry => entry && !entry.isSidechain && !entry.is_sidechain
    && !entry.parent_tool_use_id && !entry.parentToolUseId);
  const lastAssistantBlock = new Map();
  for (const entry of mainEntries) {
    if (entry.type === 'assistant' && entry.message?.id) lastAssistantBlock.set(entry.message.id, entry.uuid);
  }
  const entryPositions = new Map(mainEntries.map((entry, index) => [entry.uuid, index]));
  let candidate = null;
  let invalidPreservedContext = false;
  const completeCandidate = () => {
    if (candidate && pendingTools.size === 0 && !invalidPreservedContext) checkpoints.add(candidate.uuid);
    candidate = null;
  };
  for (const entry of mainEntries) {
    const parts = Array.isArray(entry.message?.content) ? entry.message.content : [];
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      candidate = null;
      const metadata = entry.compactMetadata || entry.compact_metadata;
      const preserved = metadata?.preservedMessages;
      const segment = metadata?.preservedSegment;
      let preservedIds = new Set();
      invalidPreservedContext = false;
      if (preserved) {
        preservedIds = new Set(Array.isArray(preserved.uuids) ? preserved.uuids : []);
        invalidPreservedContext = [...preservedIds].some(uuid => !entryPositions.has(uuid));
        if (preserved.anchorUuid && !entryPositions.has(preserved.anchorUuid)) invalidPreservedContext = true;
      } else if (segment) {
        const start = entryPositions.get(segment.headUuid);
        const end = entryPositions.get(segment.tailUuid);
        if (start === undefined || end === undefined || start > end) invalidPreservedContext = true;
        else preservedIds = new Set(mainEntries.slice(start, end + 1).map(item => item.uuid));
        if (segment.anchorUuid && !entryPositions.has(segment.anchorUuid)) invalidPreservedContext = true;
      }
      // Compaction discards ordinary old tool calls, but preserved messages
      // may still contain an unfinished call that must not be forgotten.
      for (const [toolId, ownerUuid] of pendingTools) {
        if (!preservedIds.has(ownerUuid)) pendingTools.delete(toolId);
      }
      continue;
    }
    if (entry.type === 'system' && (entry.level === 'error' || /error|interrupt|abort/.test(entry.subtype || ''))) {
      candidate = null;
      continue;
    }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') completeCandidate();
    if (entry.type === 'result') {
      if (entry.subtype === 'success' && !entry.is_error && entry.stop_reason === 'end_turn') completeCandidate();
      else candidate = null;
    }
    for (const part of parts) {
      if (entry.type === 'assistant' && part?.type === 'tool_use') pendingTools.set(part.id, entry.uuid);
      if (entry.type === 'user' && part?.type === 'tool_result') pendingTools.delete(part.tool_use_id);
    }
    if (entry.type === 'user') {
      // A new user prompt alone does not prove that the preceding turn succeeded.
      candidate = null;
    }
    if (entry.type !== 'assistant') continue;
    const stopReason = entry.message?.stop_reason;
    const isLastBlock = !entry.message?.id || lastAssistantBlock.get(entry.message.id) === entry.uuid;
    candidate = isLastBlock && isClaudeForkReply(entry) && (!stopReason || stopReason === 'end_turn') ? entry : null;
    if (candidate && (stopReason === 'end_turn' || completedReplyUuids.has(entry.uuid))) completeCandidate();
  }
  return checkpoints;
}

/** SDK assistant blocks precede message_delta, so their stop_reason can be null. */
export function createClaudeCompletedReplyTracker() {
  let latestAssistant = null;
  return {
    observe(entry) {
      if (!entry || entry.parent_tool_use_id || entry.parentToolUseId || entry.isSidechain || entry.is_sidechain) return null;
      if (entry.type === 'assistant') latestAssistant = entry;
      if (entry.type === 'user') latestAssistant = null;
      if (entry.type !== 'result') return null;
      const candidate = latestAssistant;
      latestAssistant = null;
      return entry.subtype === 'success' && !entry.is_error && entry.stop_reason === 'end_turn'
        && isClaudeForkReply(candidate) && (!candidate.message?.stop_reason || candidate.message.stop_reason === 'end_turn')
        ? candidate.uuid : null;
    },
  };
}
