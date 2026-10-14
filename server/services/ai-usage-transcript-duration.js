import { createHash } from 'node:crypto';

import { localParts, normalizeUsageTimestamp, splitTurnByDate } from './ai-usage-config.js';
import { AiUsageDurationRecordError, durationInterval } from './ai-usage-duration.js';
import { isInheritedUsageMessage } from './ai-usage-inheritance.js';
import { logicalSessionKey } from './ai-usage-parser.js';

const MAX_ID_LENGTH = 1000;
const MAX_PENDING_TOOLS = 128;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const calendarError = error => (error instanceof RangeError && error.message === 'Invalid time value')
  || ['Invalid statistics timestamp', 'Invalid statistics local date', 'Invalid statistics date boundary'].includes(error.message)
  || /^No valid local time for \d{4}-\d{2}-\d{2}T\d{2}:\d{2} in /.test(error.message);
const timestamp = (value, timeZone) => typeof value === 'string' ? normalizeUsageTimestamp(value, timeZone) : null;
function* durationSlices(start, end, timeZone) {
  try { yield* splitTurnByDate(start, end, timeZone); }
  catch (error) {
    if (calendarError(error)) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_CALENDAR');
    throw error;
  }
}
const contentText = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('\n') : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidenceKinds = new Set(['end_turn', 'turn_duration', 'result', 'completed_reply']);
const subagent = entry => [entry, entry?.message].some(value => value && (value.isSidechain || value.is_sidechain
  || value.parent_tool_use_id || value.parentToolUseId || value.agent_id || value.agentId || value.subagent_id || value.subagentId));
const meta = entry => [entry, entry?.message].some(value => value?.isMeta || value?.is_meta);

/** Stream original main-thread entries. Persist snapshot together with the file offset. */
export function createTranscriptDurationTracker(scope, {
  timeZone = 'Asia/Shanghai', state = {}, completedReplyUuids = new Set(), onTurn = () => {}, onAnomaly = () => {},
} = {}) {
  const sessionKey = logicalSessionKey(scope);
  const sessionId = scope.provider_session_id || scope.session_key || scope.runtime_id;
  let current = null;
  if (state?.version === 1 && state.sessionKey === sessionKey && state.current) {
    const saved = state.current;
    if (identifier(saved.userUuid) && timestamp(saved.requestStartedAt, timeZone)
      && Array.isArray(saved.pendingToolIds) && saved.pendingToolIds.length <= MAX_PENDING_TOOLS
      && saved.pendingToolIds.every(identifier)) {
      current = {
        userUuid: saved.userUuid, requestStartedAt: timestamp(saved.requestStartedAt, timeZone),
        lastAssistantUuid: identifier(saved.lastAssistantUuid), lastAssistantAt: timestamp(saved.lastAssistantAt, timeZone),
        assistantEligible: saved.assistantEligible === true, awaitingAssistant: saved.awaitingAssistant === true,
        pendingToolIds: [...new Set(saved.pendingToolIds)],
        completionEvidence: evidenceKinds.has(saved.completionEvidence) ? saved.completionEvidence : null,
        emitted: typeof saved.emitted === 'string' && /^[a-f0-9]{64}$/.test(saved.emitted) ? saved.emitted : null,
      };
    } else onAnomaly({ reason: 'invalid_transcript_state', sessionKey });
  }
  const turnKey = () => current ? `history:${hash([sessionKey, current.userUuid])}` : null;
  function report(reason, key = turnKey()) {
    onAnomaly({ reason, turnKey: key, rowKey: key, sessionKey });
  }
  function canComplete() {
    return current && current.lastAssistantAt && current.assistantEligible
      && !current.awaitingAssistant && current.pendingToolIds.length === 0;
  }
  function markComplete(evidence) {
    if (canComplete()) current.completionEvidence = evidence;
  }
  function emit(statusOverride = null) {
    if (!current) return;
    if (current.lastAssistantUuid && completedReplyUuids.has(current.lastAssistantUuid)) markComplete('completed_reply');
    const completed = !statusOverride && canComplete() && current.completionEvidence;
    const turn = { turnKey: turnKey(), status: statusOverride || (completed ? 'completed' : 'incomplete'),
      requestStartedAt: current.requestStartedAt, responseCompletedAt: completed ? current.lastAssistantAt : null,
      provider: scope.provider, providerSessionId: sessionId, source: 'native_transcript',
      completionEvidence: completed ? current.completionEvidence : null };
    if (current.emitted === hash(turn)) return;
    if (completed) {
      try {
        durationInterval(turn.requestStartedAt, turn.responseCompletedAt);
        // Validate all local boundaries, including timezone date skips, before
        // callers receive a completed turn. Do not truncate long valid turns.
        for (const slice of durationSlices(turn.requestStartedAt, turn.responseCompletedAt, timeZone)) {
          if (!dateKey.test(slice.date)) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_CALENDAR');
        }
      } catch (error) {
        if (!(error instanceof AiUsageDurationRecordError)) throw error;
        current.assistantEligible = false;
        current.completionEvidence = null;
        turn.status = 'incomplete';
        turn.responseCompletedAt = null;
        turn.completionEvidence = null;
        report(error.code);
      }
    }
    const fingerprint = hash(turn);
    if (current.emitted !== fingerprint) {
      onTurn(turn);
      current.emitted = fingerprint;
    }
  }
  function terminate(reason, status = 'incomplete') {
    if (!current) { report(reason); return; }
    const key = turnKey();
    // Emit a replacement so a bad append can retract a previously flushed completion.
    emit(status);
    current = null;
    report(reason, key);
  }
  function closeCurrent() {
    emit();
    current = null;
  }
  function observe(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { terminate('invalid_transcript_record'); return; }
    const entry = raw.type === 'claude-response' ? raw.data : raw;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { terminate('invalid_transcript_record'); return; }
    if (isInheritedUsageMessage(raw) || subagent(raw) || subagent(entry)) return;
    if (entry.sessionId && entry.sessionId !== sessionId) return;
    const role = ['user', 'assistant'].includes(entry.type) ? entry.type
      : !entry.type || entry.type === 'message' ? entry.role || entry.message?.role : null;
    const content = entry.message?.content ?? entry.content;
    const text = contentText(content).trim();
    const parts = Array.isArray(content) ? content : [];
    if (role === 'user' && /^<ccui-hook-recovery(?:\s|>)/.test(text)) { closeCurrent(); return; }
    if (role === 'user' && /^\[Request interrupted\b/i.test(text)) { terminate('transcript_cancelled', 'cancelled'); return; }
    if (role === 'user' && /^<ccui-mcp-loop-results?(?:\s|>)/.test(text)) {
      if (current) {
        current.awaitingAssistant = true;
        current.completionEvidence = null;
      }
      return;
    }
    if (meta(entry)) return;
    if (entry.isApiErrorMessage || entry.type === 'error'
      || (entry.type === 'system' && (entry.level === 'error' || /error|interrupt|abort|cancel/i.test(entry.subtype || '')))) {
      const cancelled = /interrupt|abort|cancel/i.test(entry.subtype || '');
      terminate(cancelled ? 'transcript_cancelled' : 'transcript_error', cancelled ? 'cancelled' : 'failed');
      return;
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') { closeCurrent(); return; }
    if (entry.type === 'system' && entry.subtype === 'turn_duration') { markComplete('turn_duration'); return; }
    if (entry.type === 'result') {
      if (entry.subtype === 'success' && !entry.is_error && (!entry.stop_reason || entry.stop_reason === 'end_turn')) {
        markComplete('result');
      } else terminate('transcript_error', 'failed');
      return;
    }
    if (role === 'user') {
      const results = parts.filter(part => part?.type === 'tool_result');
      if (results.length || entry.kind === 'tool_result') {
        if (current) {
          const resolved = new Set(results.map(part => part.tool_use_id));
          if (entry.toolId) resolved.add(entry.toolId);
          current.pendingToolIds = current.pendingToolIds.filter(id => !resolved.has(id));
          current.awaitingAssistant = true;
          current.completionEvidence = null;
        }
        return;
      }
      if (/^(?:Base directory for this skill:|<system-reminder(?:\s|>)|<local-command-(?:stdout|caveat)(?:\s|>)|Previous session summary:|This session is being continued from a previous|<!-- ECC:SUMMARY:START -->)/.test(text)) return;
      const hasInput = text || entry.kind === 'message' || parts.some(part => ['image', 'document'].includes(part?.type));
      if (!hasInput) return;
      const id = identifier(entry.uuid || entry.id);
      const start = timestamp(entry.timestamp || raw.timestamp, timeZone);
      if (current && id === current.userUuid) {
        if (start !== current.requestStartedAt) terminate('conflicting_request_timestamp');
        return;
      }
      closeCurrent();
      if (!id || !start) { report(!id ? 'missing_request_identity' : 'invalid_request_timestamp'); return; }
      current = { userUuid: id, requestStartedAt: start, lastAssistantUuid: null, lastAssistantAt: null,
        assistantEligible: false, awaitingAssistant: false, pendingToolIds: [], completionEvidence: null, emitted: null };
      return;
    }
    if (role !== 'assistant' || !current) return;
    if (/(?:[._]delta$|^stream_|^(?:message|content_block)_(?:start|stop)$)/.test(entry.kind || entry.type || '')) return;
    const end = timestamp(entry.timestamp || raw.timestamp, timeZone);
    if (!end || !Number.isSafeInteger(Date.parse(end) - Date.parse(current.requestStartedAt))
      || Date.parse(end) < Date.parse(current.requestStartedAt)
      || (current.lastAssistantAt && Date.parse(end) < Date.parse(current.lastAssistantAt))) {
      terminate('invalid_assistant_timestamp'); return;
    }
    const toolIds = parts.filter(part => part?.type === 'tool_use').map(part => identifier(part.id));
    if (entry.kind === 'tool_use') toolIds.push(identifier(entry.toolId || entry.id));
    if (toolIds.some(id => !id)) { terminate('missing_tool_identity'); return; }
    const pending = new Set([...current.pendingToolIds, ...toolIds]);
    if (pending.size > MAX_PENDING_TOOLS) { terminate('too_many_pending_tools'); return; }
    current.pendingToolIds = [...pending];
    current.lastAssistantUuid = identifier(entry.uuid || entry.id);
    current.lastAssistantAt = end;
    current.awaitingAssistant = false;
    const stop = entry.message?.stop_reason ?? entry.stop_reason;
    current.assistantEligible = toolIds.length === 0 && (!stop || stop === 'end_turn');
    current.completionEvidence = null;
    if (stop === 'end_turn') markComplete('end_turn');
    if (current.lastAssistantUuid && completedReplyUuids.has(current.lastAssistantUuid)) markComplete('completed_reply');
  }
  return {
    observe,
    invalidate: reason => terminate(reason || 'invalid_transcript_record'),
    flush: () => emit(),
    snapshot: () => ({ version: 1, sessionKey, current: current ? { ...current, pendingToolIds: [...current.pendingToolIds] } : null }),
  };
}

/** Use the existing local-day duration units and retain the complete source interval on every slice. */
export function transcriptTurnRows(scope, turn, timeZone = 'Asia/Shanghai') {
  const start = timestamp(turn.requestStartedAt, timeZone);
  if (!start || !identifier(turn.turnKey)) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_INTERVAL');
  const base = { dataset: 'turns', user_id: scope.user_id, workspace_id: scope.workspace_id,
    session_key: logicalSessionKey(scope), occurred_at: start };
  if (turn.status !== 'completed') return [{ ...base, row_key: `${turn.turnKey}:pending`,
    stat_date: localParts(start, timeZone).date, value: { ...turn, responseCompletedAt: null, durationMs: null } }];
  const end = timestamp(turn.responseCompletedAt, timeZone);
  if (!end) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_INTERVAL');
  const interval = durationInterval(start, end);
  const parts = interval.milliseconds === 0 ? [{ date: localParts(start, timeZone).date, durationMs: 0 }]
    : [...durationSlices(interval.start, interval.end, timeZone)];
  return parts.map(part => ({ ...base, row_key: `${turn.turnKey}:${part.date}`, stat_date: part.date,
    value: { ...turn, requestStartedAt: interval.start, responseCompletedAt: interval.end, durationMs: part.durationMs } }));
}
