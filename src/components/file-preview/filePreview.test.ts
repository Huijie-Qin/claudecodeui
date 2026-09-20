import assert from 'node:assert/strict';
import test from 'node:test';

import { readPreviewBlob } from './filePreview';

test('bounded reads preserve original bytes and MIME type', async () => {
  const source = new Uint8Array([0, 255, 128, 1]);
  const blob = await readPreviewBlob(new Response(source, { headers: { 'content-type': 'image/png' } }), 4);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), source);
});

test('declared oversized files cancel without being buffered', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-length': '101' },
  });
  await assert.rejects(readPreviewBlob(response, 100), /预览上限/);
  assert.equal(cancelled, true);
});

test('chunked files cannot bypass the byte limit', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readPreviewBlob(response, 6), /预览上限/);
  assert.equal(cancelled, true);
});

test('aborting a pending read cancels the stream and rejects', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readPreviewBlob(response, 100, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('permission errors preserve the API error instead of parsing an error page as a file', async () => {
  await assert.rejects(readPreviewBlob(new Response(JSON.stringify({ error: 'Workspace access denied' }), { status: 403 }), 100), /Workspace access denied/);
});
