import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import HookResultViewer from './HookResultViewer';
import { createResultPager, RESULT_PAGE_BYTES, RESULT_PAGE_LINES } from './hookResultPages';

test('collapsed result never traverses or serializes its payload', () => {
  const value = { get rows() { throw new Error('Must stay lazy'); } };
  const html = renderToStaticMarkup(createElement(HookResultViewer, { value }));
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre|data-hook-result-preview/);
});

test('page one does not visit all 3000 rows', () => {
  let visited = 0;
  const rows = Array.from({ length: 3000 }, (_, index) => ({ get index() { visited++; return index; }, text: 'result'.repeat(20) }));
  const page = createResultPager({ status: 'success', rows })(0);
  assert.equal(page.hasMore, true);
  assert.ok(visited < 100, `visited ${visited} rows`);
  assert.ok(page.text.split('\n').length <= RESULT_PAGE_LINES);
  assert.ok(Buffer.byteLength(page.text) <= RESULT_PAGE_BYTES);
});

test('pagination reconstructs the full JSON without losing data and keeps every page bounded', () => {
  const value = { status: 'success', rows: Array.from({ length: 3000 }, (_, index) => ({ index, text: '你好😀'.repeat(40) })) };
  const getPage = createResultPager(value);
  let text = '';
  for (let index = 0; ; index++) {
    const page = getPage(index);
    assert.ok(page.text.split('\n').length <= RESULT_PAGE_LINES);
    assert.ok(Buffer.byteLength(page.text) <= RESULT_PAGE_BYTES);
    text += page.text;
    assert.equal(getPage(index), page);
    if (!page.hasMore) break;
  }
  assert.deepEqual(JSON.parse(text), value);
});

test('a single long line is also byte-bounded, including Unicode and escaped quotes', () => {
  const value = '😀汉字"\\'.repeat(20_000);
  const getPage = createResultPager(value);
  let text = '';
  for (let index = 0; ; index++) {
    const page = getPage(index);
    assert.ok(Buffer.byteLength(page.text) <= RESULT_PAGE_BYTES);
    text += page.text;
    if (!page.hasMore) break;
  }
  assert.equal(JSON.parse(text), value);
});

test('preview redacts credentials without changing the original result', () => {
  const value = { USER_KEY: 'private-value', text: 'Authorization: Bearer abc123', rows: [1, null] };
  const page = createResultPager(value)(0);
  assert.doesNotMatch(page.text, /private-value|abc123/);
  assert.equal(value.USER_KEY, 'private-value');
});

test('invalid page jumps fail instead of synchronously formatting the entire payload', () => {
  assert.throws(() => createResultPager([1, 2])(100), /Invalid result page/);
});
