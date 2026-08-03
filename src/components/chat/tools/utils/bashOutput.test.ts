import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBashOutput } from './bashOutput';

test('normalizeBashOutput prefers structured stdout over duplicate content', () => {
  assert.deepEqual(
    normalizeBashOutput({
      content: 'build complete',
      isError: false,
      toolUseResult: { stdout: 'build complete\n', stderr: '' },
    }),
    { stdout: 'build complete', stderr: '', hasOutput: true },
  );
});

test('normalizeBashOutput falls back to content without structured streams', () => {
  assert.deepEqual(
    normalizeBashOutput({ content: 'fallback output\n', isError: false }),
    { stdout: 'fallback output', stderr: '', hasOutput: true },
  );
});

test('normalizeBashOutput keeps stdout and stderr separate', () => {
  assert.deepEqual(
    normalizeBashOutput({
      content: 'combined output',
      toolUseResult: { stdout: 'normal output', stderr: 'warning output' },
    }),
    { stdout: 'normal output', stderr: 'warning output', hasOutput: true },
  );
});

test('normalizeBashOutput does not duplicate content when only stderr is structured', () => {
  assert.deepEqual(
    normalizeBashOutput({
      content: 'same error',
      toolUseResult: { stdout: '', stderr: 'same error' },
    }),
    { stdout: '', stderr: 'same error', hasOutput: true },
  );
});

test('normalizeBashOutput removes ANSI escape sequences and ignores empty output', () => {
  assert.deepEqual(
    normalizeBashOutput({
      content: '',
      toolUseResult: { stdout: '\u001b[32mSuccess\u001b[0m\n', stderr: '' },
    }),
    { stdout: 'Success', stderr: '', hasOutput: true },
  );

  assert.deepEqual(
    normalizeBashOutput({ content: '\n', toolUseResult: { stdout: '', stderr: '' } }),
    { stdout: '', stderr: '', hasOutput: false },
  );
});
