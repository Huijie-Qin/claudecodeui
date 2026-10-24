import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { mock, type TestContext } from 'node:test';

import React from 'react';

const { act, create } = createRequire(import.meta.url)('react-test-renderer');
type Request = { endpoint: string; params: Record<string, unknown> };
let transport: (request: Request) => unknown;
mock.module(new URL('./client.ts', import.meta.url).href, {
  namedExports: { usageRequest: async (endpoint: string, params: Record<string, unknown>) => transport({ endpoint, params: { ...params } }) },
});
mock.module(new URL('../../shared/view/ui/index.ts', import.meta.url).href, {
  namedExports: { Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('button', props, children) },
});
mock.module('react-i18next', { namedExports: { useTranslation: () => ({ t: (key: string) => key }) } });
const { default: SessionDetails } = await import('./SessionDetails');
type TestNode = { children: Array<TestNode | string>; props: Record<string, unknown> };
const text = (node: TestNode | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
const params = { tenantId: 'all', scope: 'tenant', batchId: 'snapshot', from: '2026-09-01', to: '2026-09-12' };
const response = () => ({ sessionDetailVersion: 1, batchId: 'snapshot', total: 25, items: [
  { id: '1:5', userName: 'alice', workspaceName: 'work', sessionId: 's1', totalTokens: 0,
    skillList: ['SQL', 'SQL'], startTime: '2026-09-12 09:02:03', endTime: null, activeDurationSeconds: 90061 },
] });
async function setup(t: TestContext) {
  const requests: Request[] = [];
  let next: () => unknown = response;
  transport = request => { requests.push(request); return next(); };
  let denied = 0;
  const onAccessError = () => { denied++; };
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(React.createElement(SessionDetails, { params, onAccessError })); });
  t.after(() => act(() => tree.unmount()));
  const button = (label: string) => tree.root.findAllByType('button').find((node: TestNode) => text(node) === label);
  const refresh = async (index: number, result: () => unknown) => {
    next = result;
    await act(async () => tree.update(React.createElement(SessionDetails, { params: { ...params, userSearch: String(index) }, onAccessError })));
  };
  return { tree, requests, button, refresh, denied: () => denied };
}

test('session table has eight columns, requests all-tenant pagination and sorts with page reset', async t => {
  const ui = await setup(t);
  assert.equal(ui.tree.root.findAllByType('th').length, 8);
  assert.deepEqual(ui.tree.root.findAllByType('td').map(text), ['alice', 'work', 's1', '0', 'SQL', '2026-09-12 09:02:03', '—', '25:01:01']);
  assert.deepEqual(ui.requests[0], { endpoint: 'session-details', params: { ...params, sortBy: 'startTime', sortDir: 'desc', page: 1, pageSize: 20 } });
  await act(async () => ui.button('next').props.onClick());
  assert.equal(ui.requests.at(-1)!.params.page, 2);
  await act(async () => ui.button('sessionDetails.totalTokens').props.onClick());
  assert.equal(ui.requests.at(-1)!.params.sortBy, 'totalTokens');
  assert.equal(ui.requests.at(-1)!.params.sortDir, 'desc');
  assert.equal(ui.requests.at(-1)!.params.page, 1);
  await act(async () => ui.button('sessionDetails.totalTokens').props.onClick());
  assert.equal(ui.requests.at(-1)!.params.sortDir, 'asc');
  await act(async () => ui.tree.root.findByType('select').props.onChange({ target: { value: '50' } }));
  assert.equal(ui.requests.at(-1)!.params.pageSize, 50);
  assert.equal(ui.requests.at(-1)!.params.tenantId, 'all');
});

test('incompatible versions and batches clear old rows, and permission failures reach the panel', async t => {
  const ui = await setup(t);
  await ui.refresh(1, () => ({ ...response(), sessionDetailVersion: undefined }));
  assert.equal(ui.tree.root.findAllByType('td').length, 0);
  assert.equal(text(ui.tree.root.findByProps({ role: 'alert' })), 'sessionDetailsNotReady');
  await ui.refresh(2, () => ({ ...response(), batchId: 'old' }));
  assert.equal(text(ui.tree.root.findByProps({ role: 'alert' })), 'batchMismatch');
  await ui.refresh(3, () => { throw Object.assign(new Error('upgrade'), { status: 409, code: 'sessionDetailsNotReady' }); });
  assert.equal(text(ui.tree.root.findByProps({ role: 'alert' })), 'sessionDetailsNotReady');
  await ui.refresh(4, () => { throw Object.assign(new Error('denied'), { status: 403 }); });
  assert.equal(ui.denied(), 1);
  assert.equal(ui.tree.root.findAllByType('td').length, 0);
});
