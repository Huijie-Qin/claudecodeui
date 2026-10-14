import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { mock, type TestContext } from 'node:test';

import React from 'react';

// Run with node --experimental-test-module-mocks --import tsx --test.
// Exercise the real editor and tenant API adapter; replace only transport and
// unrelated dialog/folder UIs so these tests do not require a browser.
const { act, create } = createRequire(import.meta.url)('react-test-renderer');
type Request = { path: string; method: string; body?: Record<string, unknown> };
let transport: (request: Request) => Response | Promise<Response>;
mock.module(new URL('../../utils/api.js', import.meta.url).href, {
  namedExports: {
    api: { admin: {} },
    authenticatedFetch: async (path: string, options: { method?: string; body?: string }) => transport({
      path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined,
    }),
  },
});
const ui = (tag: string) => React.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<HTMLElement>) => {
  const { children, ...rest } = props;
  return React.createElement(tag, { ...rest, ref }, children as React.ReactNode);
});
mock.module(new URL('../../shared/view/ui/index.ts', import.meta.url).href, {
  namedExports: {
    Button: ui('button'), Input: ui('input'), DialogContent: ui('section'), DialogTitle: ui('h2'),
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null,
  },
});
for (const name of ['AgentTemplateFolders', 'AgentTemplateSqlCheckSettings', 'AgentTemplateMcpSettingsDialog']) {
  mock.module(new URL(`./${name}.tsx`, import.meta.url).href, { defaultExport: () => null });
}
const { default: AgentTemplatesTab } = await import('./AgentTemplatesTab');
const { createTenantManagementApi } = await import('../tenant-management/tenantManagementApi');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const base = '/api/tenant-management/7';
const skill = { id: 'market-skill', name: 'market-skill', displayName: '市场技能', description: '市场提供的技能' };
const preset = { id: 31, tenantId: 7, name: skill.name, displayName: skill.displayName, remoteId: skill.id, status: 'draft' };

type TestNode = { children: Array<TestNode | string>; props: Record<string, unknown> };
const textContent = (node: TestNode | string): string => typeof node === 'string' ? node : node.children.map(textContent).join('');

async function setup(t: TestContext, {
  market = json({ skills: [skill] }),
  presets = json({ presets: [] }),
  catalog = json({ skills: [], mcps: [] }),
  validation = json({ preset: { ...preset, lastValidationStatus: 'healthy' }, validation: { status: 'healthy' } }),
  initialRefs,
  createResponse,
}: {
  market?: Response; presets?: Response; catalog?: Response; validation?: Response;
  initialRefs?: Array<{ tenantId: number; presetId: number }>;
  createResponse?: Promise<Response>;
} = {}) {
  const existingTemplate = {
    id: 91, name: '已有模板', category: '通用', tenantIds: [7], skillPresetRefs: initialRefs || [],
    mcpPresetRefs: [], hookRefs: [], status: 'draft', globalVisible: false,
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 1, clearTimeout: () => {} } });
  let tree: ReturnType<typeof create>;
  t.after(() => {
    if (tree) act(() => tree.unmount());
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const requests: Request[] = [];
  transport = (request) => {
    requests.push(request);
    const { path, method, body } = request;
    assert.ok(path.startsWith(`${base}/`), 'all editor requests stay in the current tenant');
    if (path === `${base}/agent-templates` && method === 'GET') return json({ templates: initialRefs ? [existingTemplate] : [] });
    if (path === `${base}/agent-templates/91` && method === 'GET') return json({ template: existingTemplate });
    if (path === `${base}/agent-template-categories`) return json({ categories: [{ id: 1, name: '通用', templateCount: 0 }] });
    if (path === `${base}/agent-templates/preset-catalog`) return catalog.clone();
    if (path === `${base}/agent-templates/hook-catalog`) return json({ hooks: [] });
    if (path.startsWith(`${base}/skill-presets/market?`)) return market.clone();
    if (path === `${base}/skill-presets` && method === 'GET') return presets.clone();
    if (path === `${base}/skill-presets` && method === 'POST') return createResponse || json({ preset });
    if (path === `${base}/skill-presets/31/validate`) return validation.clone();
    if (path === `${base}/skill-presets/31/publish`) return json({ preset: { ...preset, status: 'published', lastValidationStatus: 'healthy' } });
    if (path === `${base}/agent-templates` && method === 'POST') return json({ template: { ...body, id: 91 } });
    if (path === `${base}/agent-templates/91` && method === 'PUT') return json({ template: { ...body, id: 91 } });
    assert.fail(`Unexpected request: ${method} ${path}`);
  };
  await act(async () => {
    tree = create(React.createElement(AgentTemplatesTab, {
      tenants: [{ id: 7, code: 'demo', name: '测试租户', status: 'active' }], currentTenantId: 7,
      managementApi: createTenantManagementApi(7), tenantManaged: true,
    }));
  });
  const click = async (label: string) => {
    const button = tree.root.findAllByType('button').find((node: TestNode) => textContent(node) === label);
    assert.ok(button, `button: ${label}`);
    assert.equal(Boolean(button.props.disabled), false);
    await act(async () => { button.props.onClick(); });
  };
  if (initialRefs) {
    const button = tree.root.findAllByType('button').find((node: TestNode) => textContent(node).includes('已有模板'));
    assert.ok(button, 'existing template');
    await act(async () => { button.props.onClick(); });
  } else {
    await click('新建模板');
  }
  const selectSkill = async (label = skill.displayName) => {
    const button = tree.root.findAllByType('button').find((node: TestNode) => textContent(node).startsWith(label));
    assert.ok(button, `skill: ${label}`);
    await act(async () => { button.props.onClick(); });
  };
  const save = async () => {
    await act(async () => tree.root.findByProps({ id: 'agent-template-category' }).props.onChange({ target: { value: '通用' } }));
    await click('保存草稿');
    return [...requests].reverse().find((request) => (
      request.path === `${base}/agent-templates` && request.method === 'POST'
      || request.path === `${base}/agent-templates/91` && request.method === 'PUT'
    ))?.body;
  };
  const removeSkill = async (label: string) => {
    await act(async () => tree.root.findByProps({ 'aria-label': `移除 ${label}` }).props.onClick());
  };
  const buttonDisabled = (label: string) => Boolean(tree.root.findAllByType('button').find((node: TestNode) => textContent(node) === label)?.props.disabled);
  return { requests, selectSkill, save, removeSkill, click, buttonDisabled, text: () => textContent(tree.root) };
}

test('tenant skill API keeps all requests bound to its tenant and uses market paging options', async () => {
  const requests: Request[] = [];
  transport = (request) => { requests.push(request); return json({}); };
  const api = createTenantManagementApi(7);
  await api.searchSkillPresetMarket(999, { searchContent: '数据 分析', page: 3, pageSize: 50, complete: true });
  await api.skillPresets(999, 'tenant');
  await api.createSkillPreset({ tenantId: 999, sourceRef: skill.id, skill, preinstall: true, status: 'published' });
  await api.validateSkillPreset(31, 999);
  await api.publishSkillPreset(31, 999);
  const url = new URL(requests[0].path, 'https://example.test');
  assert.equal(url.pathname, `${base}/skill-presets/market`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { searchContent: '数据 分析', page: '3', pageSize: '50', complete: 'true' });
  assert.equal(requests[1].path, `${base}/skill-presets`);
  assert.deepEqual(requests[2], { path: `${base}/skill-presets`, method: 'POST', body: { sourceRef: skill.id, skill, preinstall: false, status: 'draft' } });
  assert.deepEqual(requests.slice(3), [
    { path: `${base}/skill-presets/31/validate`, method: 'POST', body: undefined },
    { path: `${base}/skill-presets/31/publish`, method: 'POST', body: undefined },
  ]);
});

test('an unavailable preset shows a resource error without revoking tenant management access', async () => {
  let revoked = false;
  transport = () => json({ error: '已有技能需由原管理员维护' }, 409);
  const api = createTenantManagementApi(7, () => { revoked = true; });
  assert.equal((await api.publishSkillPreset(31)).status, 409);
  assert.equal(revoked, false);
  transport = () => json({ error: 'Tenant access denied' }, 403);
  assert.equal((await api.publishSkillPreset(31)).status, 403);
  assert.equal(revoked, true);
});

test('tenant template loads market skills and imports, validates and publishes a selection before saving its reference', async (t) => {
  const f = await setup(t);
  assert.ok(f.requests.some((request) => request.path.startsWith(`${base}/skill-presets/market?`) && request.path.includes('complete=true')));
  assert.ok(f.requests.some((request) => request.path === `${base}/skill-presets` && request.method === 'GET'));
  await f.selectSkill();
  const writes = f.requests.filter((request) => request.method === 'POST');
  assert.deepEqual(writes.map((request) => request.path), [`${base}/skill-presets`, `${base}/skill-presets/31/validate`, `${base}/skill-presets/31/publish`]);
  assert.deepEqual(writes[0].body, { sourceRef: skill.id, skill, preinstall: false, status: 'draft' });
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
});

test('an existing market preset is reused instead of importing another copy', async (t) => {
  const f = await setup(t, { presets: json({ presets: [preset] }) });
  await f.selectSkill();
  assert.deepEqual(f.requests.filter((request) => request.method === 'POST').map((request) => request.path), [
    `${base}/skill-presets/31/validate`, `${base}/skill-presets/31/publish`,
  ]);
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
});

test('market failure preserves existing selections for saving or removal without exposing local presets as choices', async (t) => {
  const f = await setup(t, {
    market: json({ error: 'market offline' }, 503),
    presets: json({ presets: [{ ...preset, status: 'published' }] }),
    catalog: json({ skills: [preset], mcps: [] }),
    initialRefs: [{ tenantId: 7, presetId: 31 }],
  });
  assert.ok(f.text().includes('部分能力目录加载失败'));
  assert.ok(f.text().includes('技能市场加载失败，请重新加载后选择'));
  assert.ok(f.text().includes('以下已选 Skill 暂时无法确认可用性，配置已保留。'));
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
  await f.removeSkill(skill.displayName);
  assert.deepEqual((await f.save())?.skillPresetRefs, []);
});

test('tenant selections reuse published skills without changing their validation state', async (t) => {
  const f = await setup(t, {
    presets: json({ presets: [{ ...preset, status: 'published', lastValidationStatus: 'failed' }] }),
  });
  await f.selectSkill();
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
});

test('published market skills with missing validation metadata can be selected without writes', async (t) => {
  const f = await setup(t, { presets: json({ presets: [{ ...preset, status: 'published' }] }) });
  await f.selectSkill();
  assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
});

test('a same-name preset with a different market ID cannot substitute for the selected market skill', async (t) => {
  const f = await setup(t, {
    presets: json({ presets: [{ ...preset, id: 99, remoteId: 'other-market-id', status: 'published', lastValidationStatus: 'healthy' }] }),
  });
  await f.selectSkill();
  const writes = f.requests.filter((request) => request.method === 'POST');
  assert.equal(writes[0].path, `${base}/skill-presets`);
  assert.equal(writes[0].body?.sourceRef, skill.id);
  assert.deepEqual((await f.save())?.skillPresetRefs, [{ tenantId: 7, presetId: 31 }]);
});

test('pending tenant skill preparation blocks saving and is cancelled when leaving the editor', async (t) => {
  let resolveCreate!: (response: Response) => void;
  const createResponse = new Promise<Response>((resolve) => { resolveCreate = resolve; });
  const f = await setup(t, { createResponse });
  await f.selectSkill();
  assert.equal(f.buttonDisabled('保存草稿'), true);
  assert.equal(f.buttonDisabled('发布模板'), true);
  await f.click('返回模板列表');
  await f.click('新建模板');
  await act(async () => { resolveCreate(json({ preset })); });
  assert.deepEqual(f.requests.filter((request) => request.method === 'POST').map((request) => request.path), [`${base}/skill-presets`]);
  assert.deepEqual((await f.save())?.skillPresetRefs, []);
});

test('a failed validation cannot publish or select an imported draft skill', async (t) => {
  const f = await setup(t, {
    presets: json({ presets: [{ ...preset, lastValidationStatus: 'failed' }] }),
    validation: json({ validation: { status: 'failed', error: '技能文件校验失败' } }),
  });
  await f.selectSkill();
  assert.ok(f.text().includes('技能文件校验失败'));
  assert.deepEqual(f.requests.filter((request) => request.method === 'POST').map((request) => request.path), [`${base}/skill-presets/31/validate`]);
  assert.deepEqual((await f.save())?.skillPresetRefs, []);
});
