import assert from 'node:assert/strict';
import test, { mock, type TestContext } from 'node:test';
import { createRequire } from 'node:module';

import React from 'react';

import type { HookConfig } from './types';

// Keep these interaction tests independent of browser portals and API clients.
const { act, create } = createRequire(import.meta.url)('react-test-renderer');
const ui = (tag: string) => React.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<HTMLElement>) => {
  const { children, ...rest } = props;
  return React.createElement(tag, { ...rest, ref }, children as React.ReactNode);
});
mock.module(new URL('../../../shared/view/ui/index.ts', import.meta.url).href, {
  namedExports: { Badge: ui('span'), Button: ui('button'), DialogContent: ui('section'), DialogTitle: ui('h2'), Input: ui('input'),
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null },
});
mock.module('react-i18next', { namedExports: {
  useTranslation: () => ({ t: (key: string) => key }),
} });
const { default: HookUserBindingsDialog } = await import('./HookUserBindingsDialog');

function setup(t: TestContext) {
  const calls: string[] = [];
  let props: React.ComponentProps<typeof HookUserBindingsDialog> = {
    hook: { id: 'one', name: 'Hook', version: 1 } as HookConfig,
    scope: 'users', defaultEnabled: false, defaultShowInChat: true,
    users: [{ id: 1, username: 'Alice', isActive: true, isSystemAdmin: false, bound: true }], tenants: [],
    selectedUserIds: [1], selectedTenantIds: [], loading: false, saving: false, error: null,
    onClose: () => calls.push('close'), onSave: () => calls.push('save'), onOverwrite: () => calls.push('overwrite'),
    onScopeChange: () => {}, onDefaultEnabledChange: () => {}, onDefaultShowInChatChange: () => {},
    onToggle: () => {}, onToggleTenant: () => {}, onBatchChange: () => {}, onClear: () => calls.push('clear'),
  };
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(React.createElement(HookUserBindingsDialog, props)); });
  t.after(() => act(() => tree.unmount()));
  const button = (key: string) => tree.root.findAllByType('button').find((node: { children: unknown[] }) => node.children.includes(`hooks.bindings.${key}`));
  const click = (key: string) => act(() => { const target = button(key); assert.ok(target, key); assert.equal(Boolean(target.props.disabled), false, key); target.props.onClick(); });
  const overwrite = () => {
    if (!button('advanced').props['aria-expanded']) click('advanced');
    const label = tree.root.findAllByType('label').find((node: { children: unknown[] }) => node.children.includes('hooks.bindings.overwriteUserPreferences'));
    act(() => label.findByType('input').props.onChange({ target: { checked: true } }));
  };
  const update = (next: Partial<typeof props>) => act(() => { props = { ...props, ...next }; tree.update(React.createElement(HookUserBindingsDialog, props)); });
  return { calls, tree, button, click, overwrite, update };
}

test('ordinary save preserves user choices and bulk/advanced controls start collapsed', t => {
  const f = setup(t);
  assert.equal(f.tree.root.findAllByType('textarea').length, 0);
  assert.equal(f.button('batchUsernames').props['aria-expanded'], false);
  assert.equal(f.button('advanced').props['aria-expanded'], false);
  f.click('save');
  assert.deepEqual(f.calls, ['save']);
});

test('overwrite requires a second confirmation; returning does not submit', t => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(0); return 0; };
  t.after(() => { globalThis.requestAnimationFrame = previous; });
  const f = setup(t);
  f.overwrite(); f.click('save');
  assert.deepEqual(f.calls, []);
  assert.ok(f.button('confirmOverwrite'));
  f.click('backToEdit');
  assert.deepEqual(f.calls, []);
  f.click('save'); f.click('confirmOverwrite');
  assert.deepEqual(f.calls, ['overwrite']);
});

test('clearing selection disarms overwrite and preserves normal empty-user save', t => {
  const f = setup(t);
  f.overwrite(); f.click('clear'); f.update({ selectedUserIds: [] }); f.click('save');
  assert.deepEqual(f.calls, ['clear', 'save']);
});

test('saving blocks repeated confirmation and failed save keeps confirmation for retry', t => {
  const f = setup(t);
  f.overwrite(); f.click('save'); f.click('confirmOverwrite');
  f.update({ saving: true });
  assert.equal(f.button('confirmOverwrite').props.disabled, true);
  f.update({ saving: false, error: 'save failed' });
  assert.equal(f.tree.root.findByProps({ role: 'alert' }).children[0], 'save failed');
  f.click('confirmOverwrite');
  assert.deepEqual(f.calls, ['overwrite', 'overwrite']);
});

test('reopening and changing scope never retain a pending overwrite selection', t => {
  const f = setup(t);
  f.overwrite();
  const tenant = f.tree.root.findAllByType('input').find((node: { props: { value: string } }) => node.props.value === 'tenants');
  act(() => tenant.props.onChange());
  f.click('save');
  assert.deepEqual(f.calls, ['save']);
  f.overwrite(); f.update({ hook: null }); f.update({ hook: { id: 'two', name: 'Other', version: 2 } as HookConfig });
  f.click('save');
  assert.deepEqual(f.calls, ['save', 'save']);
});
