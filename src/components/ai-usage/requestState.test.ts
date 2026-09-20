import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyUsageDetailData, isUsageAccessFailure, usageDetailReducer, usageFailureKey } from './requestState';
import type { UsageDetailData } from './requestState';

const oldData: UsageDetailData = {
  list: { batchId: 'old-batch', items: [{ id: 'private-record' }], total: 1, page: 1, pageSize: 20 },
  statistics: [{ key: 'private-field', sum: 9 }],
};
test('a replaced report asks for refresh while unrelated errors keep their own message', () => {
  assert.equal(usageFailureKey({ code: 'reportUpdated', status: 409 }), 'batchMismatch');
  assert.equal(usageFailureKey({ code: 'reportUpdated' }, 'exportFailed'), 'batchMismatch');
  assert.equal(usageFailureKey({ code: 'splitNotReady', status: 409 }), 'splitNotReady');
  assert.equal(usageFailureKey(new Error('offline')), 'requestFailed');
  assert.equal(usageFailureKey(null, 'exportFailed'), 'exportFailed');
});
test('authentication loss and role revocation both invalidate report access', () => {
  assert.equal(isUsageAccessFailure({ status: 401 }), true);
  assert.equal(isUsageAccessFailure({ status: 403 }), true);
  assert.equal(isUsageAccessFailure({ status: 500 }), false);
  assert.equal(isUsageAccessFailure(null), false);
});
test('starting another detail request clears records and numeric summaries atomically', () => {
  assert.deepEqual(usageDetailReducer(oldData, { type: 'request_started' }), emptyUsageDetailData());
});
test('failed or denied details do not retain the previous Hook field statistics', () => {
  for (const status of [401, 403, 500]) {
    assert.deepEqual(usageDetailReducer(oldData, { type: 'request_failed' }), { list: null, statistics: [] }, `status ${status}`);
  }
});
test('only a successful replacement installs a new detail snapshot', () => {
  const list = { batchId: 'new-batch', items: [], total: 0, page: 1, pageSize: 20 };
  assert.deepEqual(usageDetailReducer(oldData, { type: 'succeeded', list, statistics: [] }), { list, statistics: [] });
});
