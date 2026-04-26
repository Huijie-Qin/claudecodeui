import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWebSocketLifecycleState,
  isCurrentWebSocketConnectionAttempt,
  markWebSocketLifecycleClosed,
  prepareWebSocketConnectionAttempt,
  shouldAttemptTenantWebSocketConnection,
} from './webSocketLifecycle';

test('prepareWebSocketConnectionAttempt allows reconnect after dependency cleanup', () => {
  const lifecycleRef = { current: createWebSocketLifecycleState() };
  lifecycleRef.current.unmounted = true;

  prepareWebSocketConnectionAttempt(lifecycleRef);

  assert.equal(lifecycleRef.current.unmounted, false);
});

test('stale websocket attempts are ignored after tenant changes', () => {
  const lifecycleRef = { current: createWebSocketLifecycleState() };

  const firstAttempt = prepareWebSocketConnectionAttempt(lifecycleRef);
  markWebSocketLifecycleClosed(lifecycleRef);
  const secondAttempt = prepareWebSocketConnectionAttempt(lifecycleRef);

  assert.equal(isCurrentWebSocketConnectionAttempt(lifecycleRef, firstAttempt), false);
  assert.equal(isCurrentWebSocketConnectionAttempt(lifecycleRef, secondAttempt), true);
});

test('shouldAttemptTenantWebSocketConnection waits until a tenant is selected', () => {
  assert.equal(shouldAttemptTenantWebSocketConnection(null), false);
  assert.equal(shouldAttemptTenantWebSocketConnection(undefined), false);
  assert.equal(shouldAttemptTenantWebSocketConnection(3), true);
});
