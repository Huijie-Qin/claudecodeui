import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

import { createSessionStreamAccumulator } from '../components/chat/hooks/sessionStreamAccumulator';
import { createChatRealtimeMessageHandler } from '../components/chat/hooks/useChatRealtimeHandlers';
import { normalizedToChatMessages } from '../components/chat/hooks/useChatMessages';

import type { NormalizedMessage, SessionStore } from './useSessionStore';

let vite: ViteDevServer;
let useSessionStore: typeof import('./useSessionStore').useSessionStore;

before(async () => {
  // Load the real hook through Vite so import.meta.env in authenticatedFetch
  // has exactly the same semantics as in the application. No HTTP server or
  // real backend requests are needed for these controlled race regressions.
  vite = await createServer({
    configFile: false,
    envFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
  });
  ({ useSessionStore } = await vite.ssrLoadModule('/src/stores/useSessionStore.ts'));
});

after(async () => { await vite?.close(); });

function makeStore() {
  let store: SessionStore | undefined;
  function Harness() {
    store = useSessionStore();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  assert.ok(store);
  store.setActiveSession('session-1');
  return store;
}

function installBrowserGlobals(t: TestContext) {
  for (const [key, value] of Object.entries({
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, removeItem: () => {} },
    window: { setTimeout },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
}

function interceptHistory(t: TestContext) {
  installBrowserGlobals(t);
  const replies: Array<(messages: NormalizedMessage[], status?: number) => void> = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => {
    replies.push((messages, status = 200) => resolve(new Response(JSON.stringify({
      messages, total: messages.length, hasMore: false,
    }), { status })));
  }));
  return replies;
}

function answer(content: string, id = 'parent-answer'): NormalizedMessage {
  return {
    id, sessionId: 'session-1', provider: 'claude', kind: 'text', role: 'assistant',
    timestamp: '2026-09-03T10:00:00.000Z', content,
  };
}

function displayedText(store: SessionStore) {
  return normalizedToChatMessages(store.getMessages('session-1'))
    .filter(message => message.type === 'assistant' && !message.isToolUse)
    .map(message => message.content);
}

function makeHandler(t: TestContext) {
  installBrowserGlobals(t);
  const store = makeStore();
  const accumulator = createSessionStreamAccumulator();
  const timers = new Map<string, number>();
  t.after(() => { for (const timer of timers.values()) clearTimeout(timer); });
  const process = createChatRealtimeMessageHandler({
    provider: 'claude', selectedSession: null, currentSessionId: 'session-1',
    setCurrentSessionId: () => {}, setIsLoading: () => {}, setCanAbortSession: () => {},
    setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null },
    streamAccumulatorRef: { current: accumulator }, streamTimersRef: { current: timers },
    sessionStore: store,
  });
  return { process, store, accumulator, timers };
}

test('a canonical message before the 100ms flush cannot erase buffered parent text', (t) => {
  const { process, store, timers } = makeHandler(t);
  const full = 'Parent response, including the final paragraph.';
  process({ ...answer(full), kind: 'stream_delta' });
  // Canonical events can lag the live buffer. Do not advance any timers.
  process(answer('Parent response,'));
  process({ ...answer('', 'complete-1'), kind: 'complete', exitCode: 0 });

  assert.deepEqual(displayedText(store), [full]);
  assert.equal(timers.size, 0);
});

test('a complete canonical copy replaces the published buffer without duplicates', (t) => {
  const { process, store, accumulator, timers } = makeHandler(t);
  const full = 'Full canonical answer.';
  process({ ...answer('Full canonical'), kind: 'stream_delta' });
  process(answer(full));
  process({ ...answer('', 'complete-1'), kind: 'complete', exitCode: 0 });
  assert.deepEqual(displayedText(store), [full]);
  assert.equal(accumulator.get('session-1'), '');
  assert.equal(timers.size, 0);
});

test('child canonical events do not clear buffered parent or other-session content', (t) => {
  const { process, store, accumulator } = makeHandler(t);
  process({ ...answer('Parent tail.'), kind: 'stream_delta' });
  process({ ...answer('Other session.'), sessionId: 'session-2', kind: 'stream_delta' });
  process({ ...answer('Child tail.'), kind: 'stream_delta', parentToolUseId: 'child' });
  process({ ...answer('Child', 'child-answer'), parentToolUseId: 'child' });
  assert.equal(accumulator.get('session-1'), 'Parent tail.');
  assert.equal(accumulator.get('session-2'), 'Other session.');
  assert.ok(store.getMessages('session-1').some(message =>
    message.parentToolUseId === 'child' && message.content === 'Child tail.'
  ));
  process({ ...answer('', 'complete-1'), kind: 'complete', exitCode: 0 });
  assert.ok(displayedText(store).includes('Parent tail.'));
  assert.equal(accumulator.get('session-2'), 'Other session.');
});

test('stream output after completion is still routed into the current transcript', (t) => {
  const { process, store } = makeHandler(t);
  process(answer('Initial answer.'));
  process({ ...answer('', 'complete-1'), kind: 'complete', exitCode: 0 });
  process({ ...answer('Late parent text.', 'late-delta'), kind: 'stream_delta' });
  process({ ...answer('', 'late-end'), kind: 'stream_end' });
  assert.deepEqual(displayedText(store), ['Initial answer.', 'Late parent text.']);
});

for (const staleRequest of ['refresh', 'initial-fetch'] as const) {
  test(`late ${staleRequest} cannot roll back a newer reconciled history`, async (t) => {
    const replies = interceptHistory(t);
    const store = makeStore();
    const partial = answer('Partial');
    const complete = answer('Partial plus final paragraph.');
    const oldRequest = staleRequest === 'refresh'
      ? store.refreshFromServer('session-1')
      : store.fetchFromServer('session-1');
    store.appendRealtime('session-1', complete);
    const newRequest = store.refreshFromServer('session-1');
    replies[1]([complete]);
    await newRequest;
    assert.deepEqual(store.getSessionSlot('session-1')?.realtimeMessages, []);
    assert.deepEqual(displayedText(store), [complete.content]);

    replies[0]([partial]);
    await oldRequest;
    assert.deepEqual(displayedText(store), [complete.content]);
  });
}

test('a failed newer history request does not prevent an older successful response', async (t) => {
  const replies = interceptHistory(t);
  const store = makeStore();
  t.mock.method(console, 'error', () => {});
  const older = store.refreshFromServer('session-1');
  const newer = store.refreshFromServer('session-1');
  replies[1]([], 500);
  await newer;
  const complete = answer('Successful snapshot.');
  replies[0]([complete]);
  await older;
  assert.deepEqual(displayedText(store), [complete.content]);
});

test('late initial-load failure cannot replace the state of a successful refresh', async (t) => {
  const replies = interceptHistory(t);
  const store = makeStore();
  const older = store.fetchFromServer('session-1');
  const newer = store.refreshFromServer('session-1');
  const complete = answer('Completed answer.');
  replies[1]([complete]);
  await newer;
  replies[0]([], 500);
  await older;
  assert.equal(store.getSessionSlot('session-1')?.status, 'idle');
  assert.deepEqual(displayedText(store), [complete.content]);
});

test('history response ordering is independent for each session', async (t) => {
  const replies = interceptHistory(t);
  const store = makeStore();
  const first = store.refreshFromServer('session-1');
  const second = store.refreshFromServer('session-2');
  const secondAnswer = { ...answer('Second session.'), sessionId: 'session-2' };
  replies[1]([secondAnswer]);
  await second;
  replies[0]([answer('First session.')]);
  await first;
  assert.deepEqual(displayedText(store), ['First session.']);
  assert.equal(store.getMessages('session-2')[0].content, secondAnswer.content);
});

test('pagination based on an old snapshot cannot overwrite a newer full history', async (t) => {
  const replies = interceptHistory(t);
  const store = makeStore();
  const slot = store.getSlot('session-1');
  slot.hasMore = true;
  const page = store.fetchMore('session-1');
  const refresh = store.refreshFromServer('session-1');
  const full = answer('Full answer including its tail.');
  replies[1]([full]);
  await refresh;
  replies[0]([answer('Full answer')]);
  await page;
  assert.deepEqual(displayedText(store), [full.content]);
  assert.equal(slot.offset, 1);
  assert.equal(slot.hasMore, false);
});

for (const mode of ['single', 'batch'] as const) {
  test(`busy subagents cannot evict unconfirmed parent output (${mode})`, () => {
    const store = makeStore();
    const parent = answer('Parent output must stay visible.');
    store.appendRealtime('session-1', parent);
    const messages: NormalizedMessage[] = Array.from({ length: 510 }, (_, index) => ({
      ...answer(`Child progress ${index}`, `child-${index}`),
      kind: 'task_notification', taskId: 'child', status: 'running',
    }));
    if (mode === 'batch') store.appendRealtimeBatch('session-1', messages);
    else for (const message of messages) store.appendRealtime('session-1', message);
    assert.ok(store.getMessages('session-1').some(message => message.id === parent.id));
  });
}

test('confirmed history still releases redundant realtime copies after high activity', async (t) => {
  const replies = interceptHistory(t);
  const store = makeStore();
  const messages = Array.from({ length: 510 }, (_, index) => answer(`Answer ${index}`, `answer-${index}`));
  store.appendRealtimeBatch('session-1', messages);
  const refresh = store.refreshFromServer('session-1');
  replies[0](messages);
  await refresh;
  assert.equal(store.getSessionSlot('session-1')?.realtimeMessages.length, 0);
  assert.equal(store.getMessages('session-1').length, messages.length);
});
