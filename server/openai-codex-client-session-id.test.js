import assert from 'node:assert/strict';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';

import { providerAuthService } from './modules/providers/services/provider-auth.service.js';

test('Codex startup failure identifies the pending client session', async () => {
  const originalSetInterval = globalThis.setInterval;
  // The runtime's maintenance interval should not keep this isolated test alive.
  globalThis.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    timer.unref?.();
    return timer;
  };

  let queryCodex;
  try {
    ({ queryCodex } = await import('./openai-codex.js'));
  } finally {
    globalThis.setInterval = originalSetInterval;
  }

  const originalStartThread = Codex.prototype.startThread;
  const originalIsInstalled = providerAuthService.isProviderInstalled;
  const messages = [];
  Codex.prototype.startThread = () => { throw new Error('startup failed'); };
  providerAuthService.isProviderInstalled = async () => true;

  try {
    await queryCodex('hello', { clientSessionId: 'new-session-codex' }, {
      isWebSocketWriter: true,
      send: (message) => messages.push(message),
    });
    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    const error = messages.find((message) => message.kind === 'error');
    assert.ok(error);
    assert.equal(error.sessionId, '');
    assert.equal(error.clientSessionId, 'new-session-codex');
    assert.match(error.content, /startup failed/);
  } finally {
    Codex.prototype.startThread = originalStartThread;
    providerAuthService.isProviderInstalled = originalIsInstalled;
  }
});

test('Codex turn.completed waits for stream iteration to settle', async () => {
  const { queryCodex } = await import('./openai-codex.js');
  const originalStartThread = Codex.prototype.startThread;
  const messages = [];
  let releaseStream;
  const streamReleased = new Promise((resolve) => { releaseStream = resolve; });
  let sawUsage;
  const usageObserved = new Promise((resolve) => { sawUsage = resolve; });

  Codex.prototype.startThread = () => ({
    id: 'codex-real-session',
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        await streamReleased;
      })(),
    }),
  });

  try {
    const run = queryCodex('hello', { clientSessionId: 'new-session-codex' }, {
      isWebSocketWriter: true,
      send: (message) => {
        messages.push(message);
        if (message.kind === 'status' && message.text === 'token_budget') sawUsage();
      },
    });

    await usageObserved;
    assert.equal(messages.some((message) => message.kind === 'complete'), false);
    releaseStream();
    await run;
    const complete = messages.find((message) => message.kind === 'complete');
    assert.ok(complete);
    assert.equal(complete.clientSessionId, 'new-session-codex');
  } finally {
    releaseStream();
    Codex.prototype.startThread = originalStartThread;
  }
});

test('Codex stream error is terminal only after iteration ends', async () => {
  const { queryCodex } = await import('./openai-codex.js');
  const originalStartThread = Codex.prototype.startThread;
  const messages = [];
  let releaseStream;
  const streamReleased = new Promise((resolve) => { releaseStream = resolve; });
  let sawStatus;
  const statusObserved = new Promise((resolve) => { sawStatus = resolve; });

  Codex.prototype.startThread = () => ({
    id: 'codex-error-session',
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: 'error', message: 'stream failed' };
        yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        await streamReleased;
      })(),
    }),
  });

  try {
    const run = queryCodex('hello', { clientSessionId: 'new-session-codex' }, {
      isWebSocketWriter: true,
      send: (message) => {
        messages.push(message);
        if (message.kind === 'status' && message.text === 'token_budget') sawStatus();
      },
    });
    await statusObserved;
    assert.equal(messages.some((message) => message.kind === 'error' || message.kind === 'complete'), false);
    releaseStream();
    await run;
    const errors = messages.filter((message) => message.kind === 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0].content, /stream failed/);
    assert.equal(errors[0].clientSessionId, 'new-session-codex');
    assert.equal(messages.some((message) => message.kind === 'complete'), false);
  } finally {
    releaseStream();
    Codex.prototype.startThread = originalStartThread;
  }
});
