const MINUTE = 60_000;
const DAY = 86_400_000;
const formatters = new Map();
const instants = new Map();

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(timeZone);
}

export function localParts(value, timeZone = 'Asia/Shanghai') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid statistics timestamp');
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function shiftDate(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Resolve wall-clock time without changing the process-wide TZ. The earliest
// occurrence wins at a DST fold; a DST gap advances to the next valid minute.
export function localInstant(dateKey, time, timeZone = 'Asia/Shanghai') {
  const cacheKey = `${timeZone}/${dateKey}/${time}`;
  if (instants.has(cacheKey)) return instants.get(cacheKey);
  const remember = (instant) => {
    const result = new Date(instant).toISOString();
    if (instants.size > 4096) instants.clear();
    instants.set(cacheKey, result);
    return result;
  };
  const nominal = Date.parse(`${dateKey}T${time}:00Z`);
  if (!Number.isFinite(nominal)) throw new Error('Invalid statistics local date');
  let candidate = nominal;
  for (let index = 0; index < 4; index++) {
    const parts = localParts(candidate, timeZone);
    const offset = Date.parse(`${parts.date}T${parts.time}:00Z`) - candidate;
    const next = nominal - offset;
    if (candidate === next) break;
    candidate = next;
  }
  const expected = `${dateKey}T${time}`;
  let after = null;
  for (let instant = candidate - 180 * MINUTE; instant <= candidate + 180 * MINUTE; instant += MINUTE) {
    const parts = localParts(instant, timeZone);
    const wallTime = `${parts.date}T${parts.time}`;
    if (wallTime === expected) return remember(instant);
    if (parts.date === dateKey && wallTime > expected && (!after || wallTime < after.wallTime)) {
      after = { instant, wallTime };
    }
  }
  if (after) return remember(after.instant);
  throw new Error(`No valid local time for ${expected} in ${timeZone}`);
}

export function readAiUsageConfig(env = process.env) {
  const boolean = env.AI_USAGE_ENABLED ?? 'false';
  if (!['true', 'false'].includes(boolean)) throw new Error('AI_USAGE_ENABLED must be true or false');
  const runAt = env.AI_USAGE_RUN_AT ?? '02:00';
  const windowEnd = env.AI_USAGE_WINDOW_END ?? '06:00';
  for (const [name, value] of [['AI_USAGE_RUN_AT', runAt], ['AI_USAGE_WINDOW_END', windowEnd]]) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${name} must be HH:mm`);
  }
  if (runAt === windowEnd) throw new Error('AI usage window must be shorter than 24 hours');
  const timeZone = env.AI_USAGE_TIMEZONE ?? 'Asia/Shanghai';
  formatter(timeZone).format(new Date(0));
  const concurrency = Number(env.AI_USAGE_MAX_CONCURRENCY ?? '1');
  if (concurrency !== 1) throw new Error('AI_USAGE_MAX_CONCURRENCY currently supports only 1');
  return Object.freeze({ enabled: boolean === 'true', runAt, windowEnd, timeZone, concurrency,
    tickMs: 30_000, batchSize: 200, leaseMs: 120_000, calculationVersion: 'request_response_interval_v1_skill_sources_v2_activity_v3_hook_executions_v4_hook_numbers_v5_skill_publishers_v6_merged_mr_v7_integration_v1_session_report_v8_fork_lineage_v9_publish_events_v10' });
}

export function getAiUsageSchedule(config, now = new Date()) {
  const epoch = new Date(now).getTime();
  const today = localParts(epoch, config.timeZone).date;
  const spansMidnight = config.windowEnd < config.runAt;
  const windowFor = (day) => ({
    scheduledFor: localInstant(day, config.runAt, config.timeZone),
    windowEndsAt: localInstant(shiftDate(day, spansMidnight ? 1 : 0), config.windowEnd, config.timeZone),
    targetThrough: localInstant(day, '00:00', config.timeZone),
  });
  let window = windowFor(today);
  if (spansMidnight && epoch < Date.parse(window.scheduledFor)) {
    const yesterday = windowFor(shiftDate(today, -1));
    if (epoch < Date.parse(yesterday.windowEndsAt)) window = yesterday;
  }
  const inWindow = epoch >= Date.parse(window.scheduledFor) && epoch < Date.parse(window.windowEndsAt);
  const todayStart = windowFor(today).scheduledFor;
  return { ...window, inWindow,
    nextRunAt: epoch < Date.parse(todayStart) ? todayStart : windowFor(shiftDate(today, 1)).scheduledFor };
}

export function normalizeTimestamp(value) {
  if (value == null || value === '') return null;
  const input = typeof value === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(input);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function* splitTurnByDate(startedAt, completedAt, timeZone, through = null) {
  const start = normalizeTimestamp(startedAt);
  const end = normalizeTimestamp(completedAt);
  if (!start || !end || end < start) return;
  let cursor = Date.parse(start);
  const finish = Math.min(Date.parse(end), through ? Date.parse(through) : Infinity);
  while (cursor < finish) {
    const day = localParts(cursor, timeZone).date;
    const next = Date.parse(localInstant(shiftDate(day, 1), '00:00', timeZone));
    if (next <= cursor || next - cursor > 2 * DAY) throw new Error('Invalid statistics date boundary');
    const until = Math.min(next, finish);
    yield { date: day, durationMs: until - cursor };
    cursor = until;
  }
}
