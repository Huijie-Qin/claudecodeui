import assert from 'node:assert/strict';
import test from 'node:test';

import { SavedReportViews, savedFilters } from './savedReportViews';

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
const filters = { from: '2026-09-01', to: '2026-09-12', userName: '小王', workspaceName: '研发' };

test('applied per-tab and Hook preferences survive reload without credentials, results, batch or draft edits', () => {
  const disk = storage(); const store = new SavedReportViews(disk); store.bind(10, 2);
  store.set('filters:usage', { queryKey: 'secret-batch', value: { filters } });
  store.set('filters:skills', { queryKey: '', value: { filters: { ...filters, userName: '发布者' } } });
  store.set('skills', { queryKey: 'secret-batch', value: { search: 'SQL', draft: 'not-applied', page: 9, token: 'secret-token', rows: ['secret-result'], groupBy: 'publisher' } });
  store.set('hook:sql', { queryKey: '', value: { filters, metric: 'average', fieldKey: 'sqlLineCount', groupBy: 'workspace', hookName: 'SQL' } });
  const restored = new SavedReportViews(disk); restored.bind(10, 2);
  assert.deepEqual(restored.get('filters:usage')?.value.filters, filters);
  assert.equal((restored.get('filters:skills')?.value.filters as typeof filters).userName, '发布者');
  assert.equal(restored.get('skills')?.value.draft, 'SQL');
  assert.equal(restored.get('skills')?.value.page, 1);
  assert.equal(restored.get('hook:sql')?.value.metric, 'average');
  assert.equal(restored.get('hook:sql')?.value.fieldKey, 'sqlLineCount');
  assert.doesNotMatch([...disk.data.values()].join(''), /secret|not-applied/);
});

test('preferences are isolated by both tenant and account; revocation clears only the active identity', () => {
  const disk = storage(); const store = new SavedReportViews(disk); store.bind(10, 2);
  store.set('usage', { queryKey: '', value: { groupBy: 'workspace' } });
  store.bind(20, 2); assert.equal(store.size, 0);
  store.bind(10, 3); assert.equal(store.size, 0);
  store.bind(10, 2); assert.equal(store.get('usage')?.value.groupBy, 'workspace');
  store.clear();
  assert.equal(disk.getItem('ai-report-views:v1:2:10'), null);
  store.bind(10); store.set('skills', { queryKey: '', value: { search: 'not persisted' } });
  assert.equal(disk.data.size, 0);
});

test('bad or unavailable storage cannot prevent report access; invalid dates fall back to published range', () => {
  const disk = storage(); disk.setItem('ai-report-views:v1:2:10', '{broken');
  const store = new SavedReportViews(disk); assert.doesNotThrow(() => store.bind(10, 2));
  assert.equal(store.size, 0);
  assert.deepEqual(savedFilters(filters, '2026-09-12'), filters);
  assert.deepEqual(savedFilters({ ...filters, to: '2026-09-13' }, '2026-09-12'), { ...filters, from: '2026-08-14' });
  const restricted = new SavedReportViews({ getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } });
  assert.doesNotThrow(() => { restricted.bind(10, 2); restricted.set('usage', { queryKey: '', value: { groupBy: 'user' } }); restricted.clear(); });
});
