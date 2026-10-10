import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { hookNumberColumns } from './HookNumberColumns';
import HookStatisticSelect from './HookStatisticSelect';
import { hookNumberMetrics, hookStatisticSort, isHookNumberMetric } from './usageUtils';

const i18n = createInstance();
await i18n.init({ lng: 'zh-CN', defaultNS: 'aiUsage', resources: { 'zh-CN': { aiUsage: {
  aggregation: '统计方式', fieldResult: '统计结果', validSamples: '有效样本数',
  hookReportFields: { sum: '求和', avg: '平均值', min: '最小值', max: '最大值' },
} } } });
const t = i18n.getFixedT('zh-CN', 'aiUsage');

test('only the selected statistic is displayed, with sample counts retained in data but hidden', () => {
  assert.deepEqual(hookNumberColumns(t).map(({ key }) => key), ['sum']);
  const row = { validCount: 4, sum: 20, average: 5, min: 2, max: 9, unit: '条' };
  for (const { key, title } of hookNumberMetrics) {
    const columns = hookNumberColumns(t, key, true);
    assert.deepEqual(columns.map((column) => column.key), [key]);
    assert.equal(columns[0].sortKey, key);
    assert.equal(columns[0].title, `统计结果 · ${t(title)}`);
    for (const unit of ['分', '条', '行', '分钟', '', undefined]) {
      const html = renderToStaticMarkup(createElement('div', null, columns[0].render!({ ...row, unit })));
      assert.match(html, new RegExp(`>${row[key]}<`));
      assert.doesNotMatch(html, /分|条|行/);
    }
  }
  assert.ok(hookNumberColumns(t, 'average').every((column) => column.sortKey === undefined));
});

test('statistic selector offers four exclusive choices and reflects the inherited selection', () => {
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(HookStatisticSelect, { value: 'average', onChange: () => {} })));
  assert.equal((html.match(/role="combobox"/g) || []).length, 1);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="平均值"/);
  assert.match(html, />统计方式</);
  assert.deepEqual(hookNumberMetrics.map(({ key }) => key), ['sum', 'average', 'min', 'max']);
  assert.doesNotMatch(html, /multiple|role="listbox"|<select/);
});

test('switching a sorted statistic follows its new value, preserving other sort columns and direction', () => {
  for (const { key } of hookNumberMetrics) {
    assert.deepEqual(hookStatisticSort({ sortBy: 'sum', sortDir: 'asc' }, key), { sortBy: key, sortDir: 'asc' });
  }
  for (const sortBy of ['hookName', 'userName', 'validCount', 'label']) {
    const sort = { sortBy, sortDir: 'desc' };
    assert.equal(hookStatisticSort(sort, 'average'), sort);
  }
  for (const value of ['sum', 'average', 'min', 'max']) assert.equal(isHookNumberMetric(value), true);
  for (const value of ['avg', 'none', '', null, undefined]) assert.equal(isHookNumberMetric(value), false);
});
