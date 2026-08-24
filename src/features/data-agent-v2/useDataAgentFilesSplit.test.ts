import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseStoredFilePaneRatio,
  resolveFilePaneWidth,
} from './useDataAgentFilesSplit';

test('stored pane ratios reject corrupt and out-of-range values', () => {
  assert.equal(parseStoredFilePaneRatio(null), null);
  assert.equal(parseStoredFilePaneRatio('oops'), null);
  assert.equal(parseStoredFilePaneRatio('0.1'), null);
  assert.equal(parseStoredFilePaneRatio('0.5'), 0.5);
});

test('file pane width uses the high-density default and respects pane bounds', () => {
  assert.equal(resolveFilePaneWidth(2300, 2560, null), 819);
  assert.equal(resolveFilePaneWidth(1180, 1440, null), 461);
  assert.equal(resolveFilePaneWidth(700, 960, null), 375);
  assert.equal(resolveFilePaneWidth(2500, 3840, 0.75), 960);
  assert.equal(resolveFilePaneWidth(1180, 1440, 0.2), 400);
});
