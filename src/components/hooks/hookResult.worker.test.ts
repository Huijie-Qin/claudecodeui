import assert from 'node:assert/strict';
import test from 'node:test';

test('result worker only returns a bounded preview and ignores pagination and download requests', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const replies: Array<{ type: string; index?: number; text?: string; hasMore?: boolean }> = [];
  const scope = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    postMessage: (message: typeof replies[number]) => replies.push(message),
  };
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else Reflect.deleteProperty(globalThis, 'self');
  });
  await import('./hookResult.worker');
  scope.onmessage!({ data: { type: 'init', value: { rows: Array.from({ length: 3000 }, (_, index) => ({ index })) } } });
  assert.equal(replies[0].type, 'preview');
  assert.equal(replies[0].index, undefined);
  assert.equal(replies[0].hasMore, true);
  assert.ok(replies[0].text!.split('\n').length <= 100);
  assert.ok(Buffer.byteLength(replies[0].text!) <= 20 * 1024);
  scope.onmessage!({ data: { type: 'page', index: 1 } });
  scope.onmessage!({ data: { type: 'download' } });
  assert.equal(replies.length, 1);
});
