import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import { setMaxListeners } from 'node:events';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useUiPreferences } from './useUiPreferences';

const { act, create } = createRequire(import.meta.url)('react-test-renderer') as {
  act: (action: () => void) => void;
  create: (element: ReturnType<typeof createElement>) => { unmount: () => void };
};

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

test('100 preference readers do not broadcast on each mount or echo external changes', (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>();
  const target = new EventTarget();
  setMaxListeners(0, target);
  let writes = 0;
  let broadcasts = 0;
  target.addEventListener('ui-preferences:sync', () => broadcasts++);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; entries.set(key, value); },
  } });
  let controller: ReturnType<typeof useUiPreferences>;
  const values: boolean[] = [];
  function Probe({ index }: { index: number }) {
    const state = useUiPreferences();
    if (index === 0) controller = state;
    values[index] = state.preferences.showHookExecutionDetails;
    return null;
  }
  let tree: ReturnType<typeof create>;
  t.after(() => {
    act(() => tree.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  act(() => { tree = create(createElement('div', {}, Array.from({ length: 100 }, (_, index) => createElement(Probe, { key: index, index })))); });
  assert.equal(writes, 1);
  assert.equal(broadcasts, 1);
  act(() => controller.setPreference('showHookExecutionDetails', true));
  assert.equal(writes, 2);
  assert.equal(broadcasts, 2);
  assert.ok(values.every(Boolean));
});
