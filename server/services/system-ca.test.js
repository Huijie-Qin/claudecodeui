import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSystemCaCertificates } from './system-ca.js';

test('mergeSystemCaCertificates adds system roots without dropping Node defaults', () => {
  const calls = [];
  const result = mergeSystemCaCertificates({
    getCACertificates(type) {
      return type === 'system'
        ? ['system-root', 'shared-root']
        : ['bundled-root', 'shared-root'];
    },
    setDefaultCACertificates(certificates) {
      calls.push(certificates);
    },
  });

  assert.deepEqual(calls, [[
    'bundled-root',
    'shared-root',
    'system-root',
  ]]);
  assert.deepEqual(result, {
    enabled: true,
    reason: null,
    systemCertificateCount: 2,
    trustedCertificateCount: 3,
  });
});

test('mergeSystemCaCertificates is a safe no-op on older Node runtimes', () => {
  assert.deepEqual(mergeSystemCaCertificates({}), {
    enabled: false,
    reason: 'unsupported_node_runtime',
    systemCertificateCount: 0,
  });
});

test('mergeSystemCaCertificates keeps the existing defaults when the system store is empty', () => {
  let changed = false;
  const result = mergeSystemCaCertificates({
    getCACertificates(type) {
      return type === 'system' ? [] : ['bundled-root'];
    },
    setDefaultCACertificates() {
      changed = true;
    },
  });

  assert.equal(changed, false);
  assert.deepEqual(result, {
    enabled: false,
    reason: 'empty_system_store',
    systemCertificateCount: 0,
  });
});
