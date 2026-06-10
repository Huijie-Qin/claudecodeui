import assert from 'node:assert/strict';
import test from 'node:test';

import { getNextCronRunAt, normalizeCronExpression } from './cron-schedule.js';

test('returns the next matching daily run', () => {
  const next = getNextCronRunAt('30 9 * * *', new Date(2026, 5, 9, 9, 29, 30));

  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 5);
  assert.equal(next.getDate(), 9);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test('can include the current minute when requested', () => {
  const next = getNextCronRunAt('30 9 * * *', new Date(2026, 5, 9, 9, 30, 0), { inclusive: true });

  assert.equal(next.getDate(), 9);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test('supports Sunday as day-of-week 7', () => {
  const next = getNextCronRunAt('0 0 * * 7', new Date(2026, 5, 6, 23, 59, 0));

  assert.equal(next.getDay(), 0);
  assert.equal(next.getDate(), 7);
  assert.equal(normalizeCronExpression('0 0 * * 7'), '0 0 * * 7');
});

test('rejects invalid cron field counts', () => {
  assert.throws(
    () => normalizeCronExpression('0 0 * *'),
    /Cron expression must have 5 fields/,
  );
});
