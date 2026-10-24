import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeUsageDate } from './dateInput';

test('typed and pasted calendar formats normalize without timezone conversion', () => {
  for (const value of ['2026-10-04', '2026-10-4', '2026/10/4', '2026.10.4', '2026年10月4日', '2026 年 10 月 4 日', '20261004', ' 2026/10/4 ']) {
    assert.equal(normalizeUsageDate(value), '2026-10-04', value);
  }
  assert.equal(normalizeUsageDate('2026/1/1'), '2026-01-01');
  assert.equal(normalizeUsageDate('2026/12/31'), '2026-12-31');
});

test('only real calendar dates pass, including Gregorian century leap rules', () => {
  for (const value of ['2024-02-29', '2000/2/29', '0004年2月29日', '0001-01-01', '99991231']) {
    assert.ok(normalizeUsageDate(value), value);
  }
  for (const value of ['2026-02-29', '1900/2/29', '21000229', '2026-04-31', '2026-00-10', '2026-13-01', '2026-10-00', '2026-10-32', '0000-01-01']) {
    assert.equal(normalizeUsageDate(value), null, value);
  }
});

test('incomplete, ambiguous, relative and timestamp strings are not guessed', () => {
  for (const value of ['', ' ', '2026', '2026-10', '2026104', '26-10-04', '10/04/2026', '2026-10/04', '2026-10-4 extra', '2026-10-04T00:00:00Z', 'today', '昨天', '2026年10月']) {
    assert.equal(normalizeUsageDate(value), null, value);
  }
});
