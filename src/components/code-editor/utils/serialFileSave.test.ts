import assert from 'node:assert/strict';
import test from 'node:test';

import { createSerialFileSave } from './serialFileSave';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('a tab switch saves immediately and serializes a later edit', async () => {
  let content = 'first';
  let dirty = true;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const firstSave = deferred<boolean>();
  const persisted: string[] = [];
  const flush = createSerialFileSave({
    getContent: () => content,
    isDirty: () => dirty,
    persist: async (snapshot) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      persisted.push(snapshot);
      const result = persisted.length === 1 ? await firstSave.promise : true;
      concurrent -= 1;
      return result;
    },
    markClean: () => { dirty = false; },
  });

  const switching = flush();
  content = 'second';
  dirty = true;
  const automatic = flush();
  firstSave.resolve(true);
  assert.equal(await switching, true);
  assert.equal(await automatic, true);
  assert.deepEqual(persisted, ['first', 'second']);
  assert.equal(maximumConcurrent, 1);
  assert.equal(dirty, false);
});

test('failed saves keep the document dirty for a later retry', async () => {
  let dirty = true;
  let attempts = 0;
  const flush = createSerialFileSave({
    getContent: () => 'draft',
    isDirty: () => dirty,
    persist: async () => { attempts += 1; return attempts > 1; },
    markClean: () => { dirty = false; },
  });

  assert.equal(await flush(), false);
  assert.equal(dirty, true);
  assert.equal(await flush(), true);
  assert.equal(dirty, false);
  assert.equal(attempts, 2);
});
