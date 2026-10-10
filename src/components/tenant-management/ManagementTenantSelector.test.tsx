import assert from 'node:assert/strict';
import test from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Tenant } from '../../types/app';

import ManagementTenantSelector from './ManagementTenantSelector';

const first: Tenant = { id: 10, name: '示例租户', code: 'example', permission: 'edit', role: 'tenant_admin' };
const second: Tenant = { ...first, id: 20, name: '第二租户', code: 'second' };
const render = (currentTenant: Tenant | null, tenants: Tenant[]) => renderToStaticMarkup(
  <ManagementTenantSelector currentTenant={currentTenant} tenants={tenants} onSelect={() => {}} />,
);

test('one manageable tenant is a quiet identity badge, not a redundant selector', () => {
  const html = render(first, [first]);
  assert.match(html, /当前租户/);
  assert.match(html, /title="示例租户"/);
  assert.doesNotMatch(html, /<select|chevron-down/);
});

test('multiple manageable tenants retain an accessible native selector and the current value', () => {
  const html = render(first, [first, second]);
  assert.match(html, /aria-label="切换管理租户"/);
  assert.match(html, /<option value="10" selected="">示例租户/);
  assert.match(html, /<option value="20">第二租户/);
  assert.match(html, /focus-within:ring-2/);
});

test('an inaccessible current tenant can switch to the only manageable tenant without selecting the fallback', () => {
  const html = render(first, [second]);
  assert.match(html, /<select/);
  assert.match(html, /<option value="10" disabled="" selected="">示例租户/);
  assert.match(html, /<option value="20">第二租户/);
});

test('missing tenant state is honest and only offers supplied manageable choices', () => {
  assert.doesNotMatch(render(null, []), /<select/);
  const html = render(null, [second]);
  assert.match(html, /尚未选择租户/);
  assert.match(html, /<option value="" disabled="" selected="">尚未选择租户/);
  assert.doesNotMatch(html, /value="10"/);
});

test('long and untrusted names remain bounded, escaped and available in the title', () => {
  const html = render({ ...first, name: '<script>较长的租户名称</script>' }, [first]);
  assert.match(html, /truncate/);
  assert.match(html, /title="&lt;script&gt;较长的租户名称&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>/);
});
