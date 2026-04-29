import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSocketMessageDispatcher } from './webSocketMessageDispatch';

test('websocket message dispatcher delivers every published message in order', () => {
  const latestMessages: string[] = [];
  const delivered: string[] = [];
  const dispatcher = createWebSocketMessageDispatcher<string>({
    updateLatestMessage: (message) => latestMessages.push(message),
  });

  dispatcher.subscribe((message) => delivered.push(message));

  dispatcher.publish('你');
  dispatcher.publish('好');
  dispatcher.publish('！');

  assert.deepEqual(latestMessages, ['你', '好', '！']);
  assert.deepEqual(delivered, ['你', '好', '！']);
});

test('websocket message dispatcher isolates listener errors', () => {
  const errors: unknown[] = [];
  const delivered: string[] = [];
  const dispatcher = createWebSocketMessageDispatcher<string>({
    updateLatestMessage: () => {},
    onListenerError: (error) => errors.push(error),
  });

  dispatcher.subscribe(() => {
    throw new Error('listener failed');
  });
  dispatcher.subscribe((message) => delivered.push(message));

  dispatcher.publish('stream_delta');

  assert.equal(errors.length, 1);
  assert.deepEqual(delivered, ['stream_delta']);
});
