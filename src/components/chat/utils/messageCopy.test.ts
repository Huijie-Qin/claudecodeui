import assert from 'node:assert/strict';
import test from 'node:test';

import { getMessageCopyPayload } from './messageCopy';

test('user messages are copied verbatim in text mode', () => {
  const content = '  a < b > c\r\n> quoted\n**bold** and `code`  ';

  assert.equal(getMessageCopyPayload({ content, format: 'text', messageType: 'user' }), content);
});

test('assistant messages are converted when copied as text', () => {
  const content = '<section>hello</section>\n> quoted\n**bold**';

  assert.equal(
    getMessageCopyPayload({ content, format: 'text', messageType: 'assistant' }),
    'hello\nquoted\nbold'
  );
});

test('assistant messages are copied verbatim in markdown mode', () => {
  const content = '  > quoted\n**bold**  ';

  assert.equal(getMessageCopyPayload({ content, format: 'markdown', messageType: 'assistant' }), content);
});
