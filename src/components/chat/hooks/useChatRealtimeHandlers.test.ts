import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatRealtimeMessageHandler } from './useChatRealtimeHandlers';
import { createSessionStreamAccumulator } from './sessionStreamAccumulator';

test('pre-init provider failure clears the pending composer using its client session id', () => {
  let loading = true;
  let status: { text: string } | null = { text: 'Processing' };
  const clearedSessions: string[] = [];
  const pendingViewSessionRef = { current: { sessionId: 'new-session-123', startedAt: 1 } };
  const handle = createChatRealtimeMessageHandler({
    provider: 'cursor',
    selectedSession: null,
    currentSessionId: null,
    setCurrentSessionId: () => {},
    setIsLoading: (value) => { loading = value; },
    setCanAbortSession: () => {},
    setClaudeStatus: (value) => { status = value; },
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef,
    streamAccumulatorRef: { current: createSessionStreamAccumulator() },
    streamTimersRef: { current: new Map() },
    onSessionNotProcessing: (sessionId) => { if (sessionId) clearedSessions.push(sessionId); },
    sessionStore: {
      appendRealtime: () => {},
    } as any,
  });

  handle({
    kind: 'error',
    content: 'CLI exited before init',
    sessionId: 'provider-process-key',
    clientSessionId: 'new-session-123',
    provider: 'cursor',
  });

  assert.equal(loading, false);
  assert.equal(status, null);
  assert.deepEqual(clearedSessions, ['new-session-123']);
  assert.equal(pendingViewSessionRef.current, null);
});

test('background session creation does not transfer a foreground pending session', () => {
  const replacements: string[] = [];
  const handle = createChatRealtimeMessageHandler({
    provider: 'claude',
    selectedSession: null,
    currentSessionId: null,
    setCurrentSessionId: () => {},
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: { sessionId: 'new-session-123', startedAt: 1 } },
    streamAccumulatorRef: { current: createSessionStreamAccumulator() },
    streamTimersRef: { current: new Map() },
    onReplaceTemporarySession: (sessionId) => { if (sessionId) replacements.push(sessionId); },
    sessionStore: {
      appendRealtime: () => {},
    } as any,
  });

  handle({
    kind: 'session_created',
    newSessionId: 'background-session',
    sessionId: 'background-session',
    scheduledTaskId: 42,
    provider: 'claude',
  });

  assert.deepEqual(replacements, []);
});

test('legacy provider rejection clears only its matching pending session without duplicating the error card', () => {
  let loading = true;
  let status: { text: string } | null = { text: 'Processing' };
  const clearedSessions: string[] = [];
  const addedMessages: unknown[] = [];
  const pendingViewSessionRef = { current: { sessionId: 'new-session-123', startedAt: 1 } };
  const handle = createChatRealtimeMessageHandler({
    provider: 'cursor',
    selectedSession: null,
    currentSessionId: null,
    setCurrentSessionId: () => {},
    setIsLoading: (value) => { loading = value; },
    setCanAbortSession: () => {},
    setClaudeStatus: (value) => { status = value; },
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef,
    streamAccumulatorRef: { current: createSessionStreamAccumulator() },
    streamTimersRef: { current: new Map() },
    onSessionNotProcessing: (sessionId) => { if (sessionId) clearedSessions.push(sessionId); },
    addMessage: (message) => { addedMessages.push(message); },
    sessionStore: { appendRealtime: () => {} } as any,
  });

  handle({ type: 'error', sessionId: 'other-process', clientSessionId: 'other-session', message: 'Background failed' });
  assert.equal(loading, true);
  assert.deepEqual(clearedSessions, []);

  handle({ type: 'error', sessionId: 'provider-process-key', clientSessionId: 'new-session-123', message: 'Already sent' });
  assert.equal(loading, false);
  assert.equal(status, null);
  assert.deepEqual(clearedSessions, ['new-session-123']);
  assert.equal(pendingViewSessionRef.current, null);
  assert.deepEqual(addedMessages, []);
});

test('an unrelated pre-init normalized error cannot clear the selected session', () => {
  let loading = true;
  const appended: unknown[] = [];
  const clearedSessions: string[] = [];
  const handle = createChatRealtimeMessageHandler({
    provider: 'cursor',
    selectedSession: { id: 'visible-session' } as any,
    currentSessionId: 'visible-session',
    setCurrentSessionId: () => {},
    setIsLoading: (value) => { loading = value; },
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: { current: null },
    streamAccumulatorRef: { current: createSessionStreamAccumulator() },
    streamTimersRef: { current: new Map() },
    onSessionNotProcessing: (sessionId) => { if (sessionId) clearedSessions.push(sessionId); },
    sessionStore: { appendRealtime: (_sessionId: string, message: unknown) => { appended.push(message); } } as any,
  });

  handle({ kind: 'error', sessionId: '', clientSessionId: 'other-temp', content: 'Background failed', provider: 'cursor' });
  assert.equal(loading, true);
  assert.deepEqual(clearedSessions, []);
  assert.deepEqual(appended, []);
});
