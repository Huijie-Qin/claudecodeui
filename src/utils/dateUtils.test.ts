import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBeijingDateTime, formatTimeAgo, parseTimestamp } from './dateUtils';

test('parseTimestamp treats SQLite CURRENT_TIMESTAMP values as UTC', () => {
  assert.equal(
    parseTimestamp('2026-04-29 03:25:02').toISOString(),
    '2026-04-29T03:25:02.000Z',
  );
});

test('formatTimeAgo does not shift SQLite UTC timestamps by the local timezone', () => {
  assert.equal(
    formatTimeAgo(
      '2026-04-29 03:25:02',
      new Date('2026-04-29T03:26:02.000Z'),
      undefined as never,
    ),
    '1 min ago',
  );
});

test('formatBeijingDateTime converts ISO offsets and SQLite UTC timestamps to Beijing time', () => {
  for (const value of [
    '2026-09-11T01:02:03.456Z',
    '2026-09-11T09:02:03+08:00',
    '2026-09-10T18:02:03-07:00',
    '2026-09-11 01:02:03',
    new Date('2026-09-11T01:02:03Z'),
    Date.parse('2026-09-11T01:02:03Z'),
  ]) {
    assert.equal(formatBeijingDateTime(value), '2026-09-11 09:02:03');
  }
});

test('formatBeijingDateTime handles midnight and date rollover with a 24-hour clock', () => {
  assert.equal(formatBeijingDateTime('2026-12-31T16:00:00Z'), '2027-01-01 00:00:00');
  assert.equal(formatBeijingDateTime('2026-09-11T15:59:59Z'), '2026-09-11 23:59:59');
  assert.equal(formatBeijingDateTime(0), '1970-01-01 08:00:00');
});

test('formatBeijingDateTime uses a placeholder for unavailable timestamps', () => {
  for (const value of [undefined, null, '', 'invalid', new Date(NaN)]) {
    assert.equal(formatBeijingDateTime(value), '-');
  }
});
