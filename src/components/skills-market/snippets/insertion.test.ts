import assert from 'node:assert/strict';
import test from 'node:test';

import { snippetInsertion } from './insertion';

function apply(content: string, from: number, to: number, markdown = '正文') {
  const change = snippetInsertion(content, from, to, markdown);
  return content.slice(0, change.from) + change.insert + content.slice(change.to);
}

test('insert at cursor or replace selection verbatim with no snippet references', () => {
  assert.equal(apply('before after', 7, 7), 'before 正文after');
  assert.equal(apply('before after', 7, 12), 'before 正文');
  assert.equal(apply('', 0, 0, '{{literal}}\n# Heading'), '{{literal}}\n# Heading');
  assert.equal(apply('😀hello', 2, 7), '😀正文');
});
test('selection intersecting frontmatter appends and preserves metadata, including CRLF', () => {
  const content = '---\nname: demo\n---\n\n# Skill';
  assert.equal(apply(content, 0, content.length), `${content}\n\n正文`);
  assert.equal(apply(content, 7, 7), `${content}\n\n正文`);
  assert.equal(apply(content, content.length, content.length), `${content}正文`);
  const crlf = '\uFEFF---\r\nname: demo\r\n---\r\nBody';
  assert.equal(apply(crlf, 5, 5), `${crlf}\r\n\r\n正文`);
  assert.equal(apply('---\nname: demo\n---', 1, 1), '---\nname: demo\n---\n\n正文');
});
test('reject broken header and invalid or stale ranges', () => {
  assert.throws(() => apply('---\nname: demo\n', 5, 5), /尚未闭合/);
  assert.throws(() => apply('abc', 0, 4), /选区已失效/);
  assert.throws(() => apply('abc', 2, 1), /选区已失效/);
  assert.throws(() => apply('abc', -1, 1), /选区已失效/);
});
