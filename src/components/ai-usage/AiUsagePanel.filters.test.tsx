import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import test, { mock, type TestContext } from 'node:test';

import React from 'react';

// Run with node --experimental-test-module-mocks --import tsx --test.
// Render the real panel and every tab. Only transport, translation and the
// button/dialog shells are replaced; filter state and requests remain real.
const { act, create } = createRequire(import.meta.url)('react-test-renderer');
type Request = { endpoint: string; params: Record<string, unknown> };
let transport: (request: Request) => unknown;
mock.module(new URL('./client.ts', import.meta.url).href, {
  namedExports: {
    usageRequest: async (endpoint: string, params: Record<string, unknown>) => transport({ endpoint, params: { ...params } }),
    UsageApiError: class extends Error {},
  },
});
mock.module(new URL('../../shared/view/ui/index.ts', import.meta.url).href, {
  namedExports: { Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('button', props, children) },
});
mock.module(new URL('./ReportOverlay.tsx', import.meta.url).href, {
  defaultExport: ({ children, onClose }: React.PropsWithChildren<{ onClose: () => void }>) => React.createElement('section', {},
    React.createElement('button', { 'aria-label': 'close-overlay', onClick: onClose }), children),
});
mock.module('react-i18next', { namedExports: { useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) } });
// Node needs an explicit style stub; runtime component modules stay intact.
register(`data:text/javascript,${encodeURIComponent("export async function load(url,context,next) { return url.endsWith('/reportTheme.css') ? {format:'module',source:'export default {};',shortCircuit:true} : next(url,context); }")}`, import.meta.url);
const { default: AiUsagePanel } = await import('./AiUsagePanel');

type TestNode = { children: Array<TestNode | string>; props: Record<string, unknown> };
const textContent = (node: TestNode | string): string => typeof node === 'string' ? node : node.children.map(textContent).join('');
const through = '2026-10-20';
const shared = { from: '2026-09-01', to: '2026-10-10', userSearch: 'alice', workspaceSearch: 'analytics' };
const tabs = [
  ['usage', 'session-details'], ['code', 'code'], ['skills', 'skills'], ['hooks', 'analysis'], ['templates', 'analysis'],
] as const;

async function setup(t: TestContext, initialStorage: Record<string, string> = {}, withHook = false) {
  const values = new Map(Object.entries(initialStorage));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
  let tree: ReturnType<typeof create>;
  t.after(() => {
    if (tree) act(() => tree.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const requests: Request[] = [];
  transport = request => {
    requests.push(request);
    const { endpoint, params } = request;
    if (endpoint === 'capabilities') return { userId: 9, canViewTenant: true, canExport: false, codeReportAvailable: true };
    const batchId = `published-${params.tenantId}`;
    if (endpoint === 'status') return { batchId, dataThroughDate: through, timeZone: 'Asia/Shanghai', coverage: 'complete' };
    if (endpoint === 'summary') return { batchId, summaryVersion: 1, scope: 'tenant', from: '2026-09-21', to: through, activityDate: through, mauFrom: '2026-09-21' };
    assert.ok(['session-details', 'code', 'skills', 'analysis', 'hooks/hook-a/field-statistics', 'hooks/hook-a/records'].includes(endpoint), `unexpected endpoint: ${endpoint}`);
    const items = withHook && endpoint === 'analysis' && params.dataset === 'hooks'
      ? [{ groupKey: 'hook-a', groupLabel: 'Hook A', recordCount: 1 }] : [];
    return { batchId, items, total: items.length, page: 1, pageSize: 20, groupBy: params.groupBy, hookReportVersion: 1,
      sessionDetailVersion: 1, codeReportVersion: 1, skillGroupingVersion: 1, summary: {}, trend: [] };
  };
  await act(async () => { tree = create(React.createElement(AiUsagePanel, { tenantId: 10 })); });
  const form = () => tree.root.findByProps({ 'aria-label': 'sharedFilters' });
  const textInputs = () => form().findAllByType('input').filter((node: TestNode) => node.props.type !== 'date');
  const change = async (key: 'from' | 'to' | 'userName' | 'workspaceName', value: string) => {
    const index = ['from', 'to', 'userName', 'workspaceName'].indexOf(key);
    assert.equal(textInputs().length, 4, 'two typed dates and two identity filters');
    await act(async () => textInputs()[index].props.onChange({ target: { value } }));
  };
  const submit = async () => { await act(async () => form().props.onSubmit({ preventDefault() {} })); };
  const select = async (tab: string) => { await act(async () => tree.root.findByProps({ id: `ai-report-tab-${tab}` }).props.onClick()); };
  const latest = (endpoint: string) => [...requests].reverse().find(request => request.endpoint === endpoint)!.params;
  const reset = async () => {
    const button = form().findAllByType('button').find((node: TestNode) => textContent(node) === 'resetFilters');
    assert.ok(button);
    await act(async () => button.props.onClick());
  };
  const applyShared = async () => {
    await change('from', shared.from); await change('to', shared.to);
    await change('userName', shared.userSearch); await change('workspaceName', shared.workspaceSearch);
    await submit();
  };
  const tenant = async (tenantId: number | 'all') => { await act(async () => tree.update(React.createElement(AiUsagePanel, { tenantId }))); };
  return { tree, requests, values, change, submit, select, latest, reset, applyShared, tenant, textInputs };
}

function assertShared(params: Record<string, unknown>, expected = shared) {
  for (const key of ['from', 'to', 'userSearch', 'workspaceSearch'] as const) assert.equal(params[key], expected[key], key);
  assert.equal(params.scope, 'tenant');
  assert.equal(params.tenantId, 10);
  assert.equal(params.batchId, 'published-10');
}

test('applying filters in any tab scopes every real tab request and overrides legacy per-tab preferences', async t => {
  const oldSkills = JSON.stringify([['filters:skills', { filters: { from: '2020-01-01', to: '2020-01-02', userName: 'old publisher', workspaceName: '' } }]]);
  const ui = await setup(t, { 'ai-report-views:v1:9:10': oldSkills });
  await ui.applyShared();
  for (const [tab, endpoint] of tabs) {
    await ui.select(tab);
    assertShared(ui.latest(endpoint));
    assert.deepEqual(ui.textInputs().map((node: TestNode) => node.props.value), [shared.from, shared.to, shared.userSearch, shared.workspaceSearch]);
  }
  await ui.select('skills');
  await ui.change('userName', 'bob'); await ui.submit();
  for (const [tab, endpoint] of tabs) {
    await ui.select(tab);
    assertShared(ui.latest(endpoint), { ...shared, userSearch: 'bob' });
  }
});

test('unapplied drafts survive tab switches without changing queries, and reset applies to all tabs', async t => {
  const ui = await setup(t);
  await ui.applyShared();
  await ui.change('userName', 'unapplied');
  await ui.change('from', '2026/9/2');
  await ui.select('skills');
  assertShared(ui.latest('skills'));
  assert.deepEqual(ui.textInputs().map((node: TestNode) => node.props.value), ['2026/9/2', shared.to, 'unapplied', shared.workspaceSearch]);
  await ui.reset();
  for (const [tab, endpoint] of tabs) {
    await ui.select(tab);
    assertShared(ui.latest(endpoint), { from: '2026-09-21', to: through, userSearch: '', workspaceSearch: '' });
  }
});

test('direct form submission normalizes typed dates and rejects invalid or unpublished dates without a request', async t => {
  const ui = await setup(t);
  await ui.change('from', '2026/9/1');
  await ui.change('to', '20261010');
  await ui.submit();
  assert.equal(ui.latest('session-details').from, '2026-09-01');
  assert.equal(ui.latest('session-details').to, '2026-10-10');
  assert.deepEqual(ui.textInputs().slice(0, 2).map((node: TestNode) => node.props.value), ['2026-09-01', '2026-10-10']);
  const appliedRequests = ui.requests.length;
  await ui.change('from', '2026-02-30'); await ui.submit();
  assert.equal(ui.requests.length, appliedRequests);
  assert.ok(ui.tree.root.findAllByProps({ role: 'alert' }).some((node: TestNode) => textContent(node) === 'range.invalid'));
  await ui.change('from', '2026-09-01'); await ui.change('to', '2026-10-21'); await ui.submit();
  assert.equal(ui.requests.length, appliedRequests);
  assert.ok(ui.tree.root.findAllByProps({ role: 'alert' }).some((node: TestNode) => textContent(node) === 'range.unpublished'));
});

test('applied shared filters persist across tenant switches without leaking into another tenant', async t => {
  const ui = await setup(t);
  await ui.applyShared();
  await ui.tenant(20);
  const other = ui.latest('session-details');
  assert.equal(other.tenantId, 20);
  assert.equal(other.batchId, 'published-20');
  assert.equal(other.userSearch, '');
  assert.equal(other.workspaceSearch, '');
  await ui.tenant(10);
  assertShared(ui.latest('session-details'));
});


test('Hook details inherit shared filters instead of stale cached local filters after the outer scope changes', async t => {
  const cached = JSON.stringify([['hook:hook-a', { filters: { from: '2020-01-01', to: '2020-01-02', userName: 'stale', workspaceName: 'old' },
    groupBy: 'user', metric: 'sum', fieldKey: '' }]]);
  const ui = await setup(t, { 'ai-report-views:v1:9:10': cached }, true);
  const openHook = async () => {
    const button = ui.tree.root.findAllByType('button').find((node: TestNode) => textContent(node) === 'enterHookReport');
    assert.ok(button);
    await act(async () => button.props.onClick());
  };
  const closeHook = async () => { await act(async () => ui.tree.root.findByProps({ 'aria-label': 'close-overlay' }).props.onClick()); };
  await ui.applyShared();
  await ui.select('hooks');
  await openHook();
  assertShared(ui.latest('hooks/hook-a/field-statistics'));
  assertShared(ui.latest('hooks/hook-a/records'));
  const hookForm = () => ui.tree.root.findByProps({ 'aria-label': 'hookReportFilters' });
  const localInputs = () => hookForm().findAllByType('input').filter((node: TestNode) => node.props.type !== 'date');
  await act(async () => localInputs()[2].props.onChange({ target: { value: 'local-only' } }));
  await act(async () => hookForm().props.onSubmit({ preventDefault() {} }));
  assert.equal(ui.latest('hooks/hook-a/records').userSearch, 'local-only');
  await closeHook();
  await ui.change('userName', 'bob'); await ui.submit();
  await openHook();
  assertShared(ui.latest('hooks/hook-a/field-statistics'), { ...shared, userSearch: 'bob' });
  assertShared(ui.latest('hooks/hook-a/records'), { ...shared, userSearch: 'bob' });
});


test('all-tenant scope and the same applied filters reach every tab', async t => {
  const ui = await setup(t);
  await ui.tenant('all');
  await ui.applyShared();
  for (const [tab, endpoint] of tabs) {
    await ui.select(tab);
    const params = ui.latest(endpoint);
    assert.equal(params.tenantId, 'all');
    assert.equal(params.batchId, 'published-all');
    assert.equal(params.scope, 'tenant');
    for (const key of ['from', 'to', 'userSearch', 'workspaceSearch'] as const) assert.equal(params[key], shared[key]);
  }
  await ui.tenant(10);
  assert.notEqual(ui.textInputs()[2].props.value, shared.userSearch, 'all scope preferences do not leak into a single tenant');
});
