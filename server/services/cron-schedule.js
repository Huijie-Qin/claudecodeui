const FIELD_CONFIGS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) },
];

const DEFAULT_MAX_SEARCH_MINUTES = 366 * 24 * 60 * 2;

function requireInteger(value, fieldName) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${fieldName} must contain only integers, ranges, lists, wildcards, or steps`);
  }
  return Number(value);
}

function normalizeFieldValue(value, config) {
  if (value < config.min || value > config.max) {
    throw new Error(`${config.name} must be between ${config.min} and ${config.max}`);
  }
  return config.normalize ? config.normalize(value) : value;
}

function parseCronField(field, config) {
  const raw = String(field || '').trim();
  if (!raw) {
    throw new Error(`${config.name} is required`);
  }

  const values = new Set();
  const parts = raw.split(',');
  let isWildcard = false;

  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    if (part.split('/').length > 2) {
      throw new Error(`${config.name} has an invalid step`);
    }

    const step = stepPart === undefined ? 1 : requireInteger(stepPart, config.name);
    if (step <= 0) {
      throw new Error(`${config.name} step must be greater than 0`);
    }

    let start;
    let end;
    if (rangePart === '*') {
      isWildcard = parts.length === 1;
      start = config.min;
      end = config.max;
    } else if (rangePart.includes('-')) {
      const [startPart, endPart] = rangePart.split('-');
      if (!startPart || !endPart || rangePart.split('-').length > 2) {
        throw new Error(`${config.name} has an invalid range`);
      }
      start = requireInteger(startPart, config.name);
      end = requireInteger(endPart, config.name);
    } else {
      start = requireInteger(rangePart, config.name);
      end = start;
    }

    if (start > end) {
      throw new Error(`${config.name} range start must be before range end`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(normalizeFieldValue(value, config));
    }
  }

  return { values, isWildcard };
}

export function parseCronExpression(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) =>
    parseCronField(field, FIELD_CONFIGS[index]));

  return {
    expression: fields.join(' '),
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
  };
}

export function normalizeCronExpression(expression) {
  return parseCronExpression(expression).expression;
}

function cronMatchesDate(parsed, date) {
  const minuteMatches = parsed.minute.values.has(date.getMinutes());
  const hourMatches = parsed.hour.values.has(date.getHours());
  const monthMatches = parsed.month.values.has(date.getMonth() + 1);
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(date.getDay());

  const dayMatches =
    parsed.dayOfMonth.isWildcard || parsed.dayOfWeek.isWildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}

export function getNextCronRunAt(expression, fromDate = new Date(), { inclusive = false } = {}) {
  const parsed = parseCronExpression(expression);
  const startDate = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(startDate.getTime())) {
    throw new Error('fromDate must be a valid date');
  }

  const candidate = new Date(startDate);
  const startsOnMinute = candidate.getSeconds() === 0 && candidate.getMilliseconds() === 0;
  candidate.setSeconds(0, 0);
  if (!inclusive || !startsOnMinute) {
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  for (let index = 0; index < DEFAULT_MAX_SEARCH_MINUTES; index += 1) {
    if (cronMatchesDate(parsed, candidate)) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error('Cron expression has no matching run time within the next 2 years');
}

export function getNextCronRunAtWithStart(expression, startAfterDate = new Date(), { notBeforeDate = null } = {}) {
  const scheduleStartDate = startAfterDate instanceof Date ? startAfterDate : new Date(startAfterDate);
  if (Number.isNaN(scheduleStartDate.getTime())) {
    throw new Error('startAfterDate must be a valid date');
  }

  if (notBeforeDate != null) {
    const minimumDate = notBeforeDate instanceof Date ? notBeforeDate : new Date(notBeforeDate);
    if (Number.isNaN(minimumDate.getTime())) {
      throw new Error('notBeforeDate must be a valid date');
    }

    if (scheduleStartDate.getTime() <= minimumDate.getTime()) {
      return getNextCronRunAt(expression, minimumDate, { inclusive: false });
    }
  }

  return getNextCronRunAt(expression, scheduleStartDate, { inclusive: true });
}
