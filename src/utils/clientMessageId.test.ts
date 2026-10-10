import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientMessageId } from './clientMessageId';

test('client IDs remain valid and distinct with native UUIDs, HTTP crypto and no crypto API', (t) => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const browserCrypto = globalThis.crypto;
  t.after(() => {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  });
  for (const cryptoApi of [browserCrypto, {
    getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto),
  }, {}, undefined]) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: cryptoApi });
    const ids = Array.from({ length: 20 }, createClientMessageId);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});
