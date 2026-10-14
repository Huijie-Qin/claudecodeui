import { normalizeTimestamp } from './ai-usage-config.js';

// Only malformed metric inputs use this error. Database, lease and ownership
// failures must keep their normal batch-level failure behavior.
export class AiUsageDurationRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AiUsageDurationRecordError';
    this.code = code;
  }
}

export function durationInterval(startedAt, completedAt) {
  const start = typeof startedAt === 'string' ? normalizeTimestamp(startedAt) : null;
  const end = typeof completedAt === 'string' ? normalizeTimestamp(completedAt) : null;
  const milliseconds = start && end ? Date.parse(end) - Date.parse(start) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_INTERVAL');
  }
  return { start, end, milliseconds };
}

export function parseDurationFact(row) {
  let value;
  try { value = JSON.parse(row.value_json); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_JSON');
  }
  // Downstream projections require an explicit instant, even for a turn that
  // does not contribute duration. Reject malformed row metadata at this same
  // per-record boundary instead of failing after valid turns were aggregated.
  const occurredAt = typeof row.occurred_at === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(row.occurred_at)
    ? normalizeTimestamp(row.occurred_at) : null;
  if (!occurredAt) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_TIME');
  if (value.status === 'completed') {
    const interval = durationInterval(value.requestStartedAt, value.responseCompletedAt);
    if (occurredAt > interval.end) throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_TIME');
    if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > interval.milliseconds) {
      throw new AiUsageDurationRecordError('AI_USAGE_INVALID_DURATION_VALUE');
    }
  }
  return value;
}

export function addDuration(previous, contribution) {
  // A corrupt accumulator is not evidence that the current input is bad.
  if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('AI_USAGE_INVALID_DURATION_AGGREGATE');
  const total = previous + contribution;
  if (!Number.isSafeInteger(total)) throw new AiUsageDurationRecordError('AI_USAGE_DURATION_OVERFLOW');
  return total;
}

// Aliases are internal SQL identifiers, never request input. Choose a whole
// request source before day slicing: a failed/shorter authoritative copy must
// suppress ALL slices of an older completed copy, including other dates.
export const durationTurnKeySql = alias => `CASE WHEN json_valid(${alias ? `${alias}.` : ''}value_json) THEN json_extract(${alias ? `${alias}.` : ''}value_json,'$.turnKey') END`;
export const durationSourceFilterSql = alias => `(${alias}.dataset<>'turns' OR (${durationTurnKeySql(alias)}) IS NULL OR ${alias}.source_key=(
  SELECT preferred.source_key FROM ai_usage_fact_rows preferred
  WHERE preferred.tenant_id=${alias}.tenant_id AND preferred.dataset='turns'
    AND preferred.session_key IS ${alias}.session_key
    AND (${durationTurnKeySql('preferred')})=(${durationTurnKeySql(alias)})
  ORDER BY preferred.priority DESC,preferred.source_key LIMIT 1
))`;
