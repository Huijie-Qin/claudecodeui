import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { mock } from 'node:test';

import React from 'react';

const { act, create } = createRequire(import.meta.url)('react-test-renderer');
mock.module(new URL('./AiUsagePanel.tsx', import.meta.url).href, {
  defaultExport: ({ tenantId }: { tenantId: number | 'all' }) => React.createElement('output', { 'data-tenant-id': tenantId }),
});
mock.module('react-i18next', { namedExports: { useTranslation: () => ({ t: (key: string) => key }) } });
const { default: AdminAiUsagePanel } = await import('./AdminAiUsagePanel');

test('admin all-tenant selection passes a scope token and switching back restores a numeric tenant', async t => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(React.createElement(AdminAiUsagePanel, {
    tenants: [{ id: 10, name: 'Tenant A' }, { id: 20, name: 'Tenant B' }], currentTenantId: 10, userId: 1,
  })); });
  t.after(() => act(() => tree.unmount()));
  assert.equal(tree.root.findByType('output').props['data-tenant-id'], 10);
  assert.equal(tree.root.findAllByType('option').find((node: { props: { value: unknown } }) => node.props.value === 'all')?.children.join(''), 'allTenants');
  await act(async () => tree.root.findByType('select').props.onChange({ target: { value: 'all' } }));
  assert.equal(tree.root.findByType('output').props['data-tenant-id'], 'all');
  await act(async () => tree.root.findByType('select').props.onChange({ target: { value: '20' } }));
  assert.equal(tree.root.findByType('output').props['data-tenant-id'], 20);
});

test('system admin without a current tenant can still select all tenants', async t => {
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(React.createElement(AdminAiUsagePanel, { tenants: [], userId: 1 })); });
  t.after(() => act(() => tree.unmount()));
  assert.equal(tree.root.findAllByType('output').length, 0);
  await act(async () => tree.root.findByType('select').props.onChange({ target: { value: 'all' } }));
  assert.equal(tree.root.findByType('output').props['data-tenant-id'], 'all');
});
