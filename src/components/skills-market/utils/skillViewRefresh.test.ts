import assert from 'node:assert/strict';
import test from 'node:test';

import { getSkillTabClickDecision } from './skillViewRefresh';

test('clicking the active market tab refreshes without switching views', () => {
  assert.deepEqual(getSkillTabClickDecision({
    currentView: 'market',
    nextView: 'market',
    marketLoading: false,
    mineLoading: false,
  }), {
    shouldSwitch: false,
    refreshView: 'market',
  });
});

test('clicking the active mine tab refreshes without switching views', () => {
  assert.deepEqual(getSkillTabClickDecision({
    currentView: 'mine',
    nextView: 'mine',
    marketLoading: false,
    mineLoading: false,
  }), {
    shouldSwitch: false,
    refreshView: 'mine',
  });
});

test('clicking another tab switches and refreshes the target view', () => {
  assert.deepEqual(getSkillTabClickDecision({
    currentView: 'mine',
    nextView: 'market',
    marketLoading: false,
    mineLoading: false,
  }), {
    shouldSwitch: true,
    refreshView: 'market',
  });
});

test('an already loading target view is not refreshed again', () => {
  assert.deepEqual(getSkillTabClickDecision({
    currentView: 'mine',
    nextView: 'market',
    marketLoading: true,
    mineLoading: false,
  }), {
    shouldSwitch: true,
    refreshView: null,
  });
  assert.deepEqual(getSkillTabClickDecision({
    currentView: 'market',
    nextView: 'mine',
    marketLoading: false,
    mineLoading: true,
  }), {
    shouldSwitch: true,
    refreshView: null,
  });
});
