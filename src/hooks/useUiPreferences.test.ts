import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useUiPreferences } from './useUiPreferences';

function readPreferences(t: TestContext, entries: Record<string, string> = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => entries[key] ?? null },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  let preferences: ReturnType<typeof useUiPreferences>['preferences'] | undefined;
  function Probe() {
    preferences = useUiPreferences().preferences;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(preferences);
  return preferences;
}

test('Hook execution details are off for new browsers', (t) => {
  assert.equal(readPreferences(t).showHookExecutionDetails, false);
});

test('existing browser preferences default Hook details to off without changing other settings', (t) => {
  const preferences = readPreferences(t, { uiPreferences: JSON.stringify({ showThinking: false, autoExpandTools: true }) });
  assert.equal(preferences.showHookExecutionDetails, false);
  assert.equal(preferences.showThinking, false);
  assert.equal(preferences.autoExpandTools, true);
});

for (const enabled of [true, false]) {
  test(`a saved Hook details preference survives reload when ${enabled}`, (t) => {
    assert.equal(readPreferences(t, {
      uiPreferences: JSON.stringify({ showHookExecutionDetails: enabled }),
    }).showHookExecutionDetails, enabled);
  });
}

test('an invalid Hook details preference fails closed', (t) => {
  assert.equal(readPreferences(t, {
    uiPreferences: JSON.stringify({ showHookExecutionDetails: 'unexpected' }),
  }).showHookExecutionDetails, false);
});
