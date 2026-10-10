import assert from 'node:assert/strict';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ReportSelect from './ReportSelect';

const options = [{ value: '', label: '全部数值字段' }, { value: 'recordCount', label: '归档条数', description: 'recordCount' }];
const render = (props = {}) => renderToStaticMarkup(createElement(ReportSelect, {
  label: '数值字段', value: 'recordCount', options, onChange: () => {}, ...props,
}));

test('report select has a labelled, closed combobox with a concise selected name', () => {
  const html = render();
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-labelledby="[^"]+-label"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="归档条数 · recordCount"/);
  assert.match(html, /class="ai-report-select-value">归档条数</);
  assert.doesNotMatch(html, /role="listbox"|aria-activedescendant|<select/);
});

test('the all-fields option, unavailable fallback and disabled states remain explicit', () => {
  assert.match(render({ value: '' }), /class="ai-report-select-value">全部数值字段</);
  assert.match(render({ value: 'removedKey' }), /class="ai-report-select-value">removedKey</);
  assert.match(render({ disabled: true }), /disabled=""/);
  assert.match(render({ options: [] }), /disabled=""/);
});

test('field names are escaped and full long names stay accessible in the title', () => {
  const label = '<script>较长字段名称</script>'.repeat(4);
  const html = render({ options: [{ value: 'recordCount', label }] });
  assert.match(html, /title="&lt;script&gt;/);
  assert.match(html, /ai-report-select-value/);
  assert.doesNotMatch(html, /<script>/);
});
