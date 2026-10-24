import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createElement, useState } from 'react';

import ReportDateInput from './ReportDateInput';

const { act, create } = createRequire(import.meta.url)('react-test-renderer');

function Harness() {
  const [value, setValue] = useState('2026-10-01');
  return createElement(ReportDateInput, { value, onChange: setValue, label: '开始日期', calendarLabel: '选择日期', max: '2026-10-23' });
}

test('typing preserves unfinished input and normalizes a valid pasted date on blur', t => {
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(createElement(Harness)); });
  t.after(() => act(() => tree.unmount()));
  const text = () => tree.root.findByProps({ type: 'text' });
  const calendar = () => tree.root.findByProps({ type: 'date' });
  act(() => text().props.onChange({ target: { value: '2026/10/' } }));
  act(() => text().props.onBlur());
  assert.equal(text().props.value, '2026/10/');
  assert.equal(calendar().props.value, '');
  act(() => text().props.onChange({ target: { value: ' 2026/10/4 ' } }));
  assert.equal(text().props.value, ' 2026/10/4 ');
  assert.equal(calendar().props.value, '2026-10-04');
  act(() => text().props.onBlur());
  assert.equal(text().props.value, '2026-10-04');
});

test('impossible dates stay visible for correction and choosing a day updates the same text field', t => {
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(createElement(Harness)); });
  t.after(() => act(() => tree.unmount()));
  const text = () => tree.root.findByProps({ type: 'text' });
  const calendar = () => tree.root.findByProps({ type: 'date' });
  act(() => text().props.onChange({ target: { value: '2026-02-30' } }));
  act(() => text().props.onBlur());
  assert.equal(text().props.value, '2026-02-30');
  assert.equal(calendar().props.value, '');
  assert.equal(calendar().props.max, '2026-10-23');
  assert.equal(calendar().props['aria-label'], '开始日期 · 选择日期');
  assert.equal(calendar().props.required, undefined);
  assert.equal(tree.root.findByType('label').props.htmlFor, text().props.id);
  act(() => calendar().props.onChange({ target: { value: '2026-10-12' } }));
  assert.equal(text().props.value, '2026-10-12');
  act(() => calendar().props.onChange({ target: { value: '' } }));
  assert.equal(text().props.value, '');
});
