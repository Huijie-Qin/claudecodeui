import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getActiveCursorSessions, spawnCursor } from './cursor-cli.js';
import { spawnGemini } from './gemini-cli.js';
import sessionManager from './sessionManager.js';

async function withFakeCli(name, script, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ccui-client-session-id-'));
  const executable = path.join(directory, name);
  await writeFile(executable, `#!/bin/sh\n${script}\n`);
  await chmod(executable, 0o755);

  const previousPath = process.env.PATH;
  const previousGeminiPath = process.env.GEMINI_PATH;
  const previousSessionsDir = sessionManager.sessionsDir;
  process.env.PATH = `${directory}${path.delimiter}${previousPath || ''}`;
  process.env.GEMINI_PATH = executable;
  sessionManager.sessionsDir = directory;

  try {
    await run(directory);
  } finally {
    process.env.PATH = previousPath;
    if (previousGeminiPath === undefined) delete process.env.GEMINI_PATH;
    else process.env.GEMINI_PATH = previousGeminiPath;
    sessionManager.sessionsDir = previousSessionsDir;
    await rm(directory, { recursive: true, force: true });
  }
}

function collectMessages() {
  const messages = [];
  return {
    messages,
    writer: {
      send: (message) => messages.push(message),
      setSessionId: () => {},
      getSessionId: () => 'stale-session-from-another-request',
    },
  };
}

test('Cursor early failure keeps clientSessionId on error and completion', async () => {
  await withFakeCli('cursor-agent', 'printf "initialization failed\\n" >&2; exit 23', async (cwd) => {
    const { messages, writer } = collectMessages();
    await assert.rejects(
      spawnCursor('hello', { cwd, clientSessionId: 'new-session-cursor' }, writer),
      /code 23/,
    );

    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    for (const kind of ['error', 'complete']) {
      const message = messages.find((entry) => entry.kind === kind);
      assert.ok(message, `expected ${kind}`);
      assert.equal(message.clientSessionId, 'new-session-cursor');
      assert.notEqual(message.sessionId, 'new-session-cursor');
      assert.notEqual(message.sessionId, 'stale-session-from-another-request');
    }
  });
});

test('Cursor final unterminated init line maps session_created and completion to the request', async () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-real-session' });
  await withFakeCli('cursor-agent', `printf '%s' '${init}'`, async (cwd) => {
    const { messages, writer } = collectMessages();
    await spawnCursor('hello', { cwd, clientSessionId: 'new-session-cursor' }, writer);

    for (const kind of ['session_created', 'complete']) {
      const message = messages.find((entry) => entry.kind === kind);
      assert.ok(message, `expected ${kind}`);
      assert.equal(message.sessionId, 'cursor-real-session');
      assert.equal(message.clientSessionId, 'new-session-cursor');
    }
  });
});

test('Cursor result waits for process close before completion', async () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still running' }] } });
  await withFakeCli('cursor-agent', `printf '%s\\n' '${result}' '${assistant}'; sleep 0.2`, async (cwd) => {
    const { messages, writer } = collectMessages();
    let sawAssistant;
    const assistantObserved = new Promise((resolve) => { sawAssistant = resolve; });
    writer.send = (message) => {
      messages.push(message);
      if (message.kind === 'stream_delta') sawAssistant();
    };

    const run = spawnCursor('hello', { cwd, clientSessionId: 'new-session-cursor' }, writer);
    await assistantObserved;
    assert.equal(messages.some((message) => message.kind === 'complete'), false);
    await run;
    const completions = messages.filter((message) => message.kind === 'complete');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].resultText, 'done');
  });
});

test('Cursor failed result stays failed when the child exits with code zero', async () => {
  const result = JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'Turn limit reached' });
  await withFakeCli('cursor-agent', `printf '%s\n' '${result}'`, async (cwd) => {
    const { messages, writer } = collectMessages();
    await assert.rejects(
      spawnCursor('hello', { cwd, clientSessionId: 'new-session-cursor' }, writer),
      /code 1/,
    );

    assert.equal(messages.filter((message) => message.kind === 'error').length, 1);
    const complete = messages.find((message) => message.kind === 'complete');
    assert.equal(complete?.exitCode, 1);
    assert.equal(complete?.isError, true);
    assert.equal(complete?.clientSessionId, 'new-session-cursor');
  });
});

test('Cursor trust retry clears the active process after an init event', async () => {
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cursor-trust-session' });
  const script = `case " $* " in *--trust*) exit 0;; *) printf '%s\\n' '${init}'; printf 'workspace trust required\\n' >&2; exit 1;; esac`;
  await withFakeCli('cursor-agent', script, async (cwd) => {
    const { messages, writer } = collectMessages();
    await spawnCursor('hello', { cwd, clientSessionId: 'new-session-cursor' }, writer);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.deepEqual(getActiveCursorSessions(), []);
  });
});

test('Gemini early failure keeps clientSessionId on error and completion', async () => {
  await withFakeCli('gemini', 'printf "initialization failed\\n" >&2; exit 23', async (cwd) => {
    const { messages, writer } = collectMessages();
    await assert.rejects(
      spawnGemini('hello', { cwd, clientSessionId: 'new-session-gemini' }, writer),
      /code 23/,
    );

    assert.equal(messages.some((message) => message.kind === 'session_created'), false);
    for (const kind of ['error', 'complete']) {
      const message = messages.find((entry) => entry.kind === kind);
      assert.ok(message, `expected ${kind}`);
      assert.equal(message.clientSessionId, 'new-session-gemini');
      assert.notEqual(message.sessionId, 'new-session-gemini');
      assert.notEqual(message.sessionId, 'stale-session-from-another-request');
    }
  });
});

test('Gemini session_created and completion retain the request clientSessionId', async () => {
  const init = JSON.stringify({ type: 'init', session_id: 'gemini-cli-session' });
  await withFakeCli('gemini', `printf '%s\\n' '${init}'`, async (cwd) => {
      const { messages, writer } = collectMessages();
      await spawnGemini('hello', { cwd, clientSessionId: 'new-session-gemini' }, writer);

      const created = messages.find((entry) => entry.kind === 'session_created');
      const complete = messages.find((entry) => entry.kind === 'complete');
      assert.ok(created);
      assert.ok(complete);
      assert.match(created.sessionId, /^gemini_/);
      assert.equal(complete.sessionId, created.sessionId);
      assert.equal(created.clientSessionId, 'new-session-gemini');
      assert.equal(complete.clientSessionId, 'new-session-gemini');
  });
});

test('Gemini stream error waits for process close before a terminal event', async () => {
  const streamError = JSON.stringify({ type: 'error', error: 'stream failed' });
  const assistant = JSON.stringify({ type: 'message', role: 'assistant', content: 'still running' });
  await withFakeCli('gemini', `printf '%s\\n' '${streamError}' '${assistant}'; sleep 0.2; exit 1`, async (cwd) => {
    const { messages, writer } = collectMessages();
    let sawAssistant;
    const assistantObserved = new Promise((resolve) => { sawAssistant = resolve; });
    writer.send = (message) => {
      messages.push(message);
      if (message.kind === 'stream_delta') sawAssistant();
    };

    const run = spawnGemini('hello', { cwd, clientSessionId: 'new-session-gemini' }, writer);
    await assistantObserved;
    assert.equal(messages.some((message) => message.kind === 'error' || message.kind === 'complete'), false);
    await assert.rejects(run, /stream failed/);
    assert.equal(messages.filter((message) => message.kind === 'error').length, 1);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  });
});
