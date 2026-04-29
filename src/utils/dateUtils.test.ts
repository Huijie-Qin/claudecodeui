import assert from 'node:assert/strict';
import test from 'node:test';

import { formatTimeAgo, parseTimestamp } from './dateUtils';

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
