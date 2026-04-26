import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareWebSocketConnectionAttempt } from './webSocketLifecycle';

test('prepareWebSocketConnectionAttempt allows reconnect after dependency cleanup', () => {
  const unmountedRef = { current: true };

  prepareWebSocketConnectionAttempt(unmountedRef);

  assert.equal(unmountedRef.current, false);
});
