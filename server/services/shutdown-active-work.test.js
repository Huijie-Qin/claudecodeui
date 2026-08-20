import assert from 'node:assert/strict';
import test from 'node:test';

import { requestActiveWorkShutdown } from './shutdown-active-work.js';

test('forced shutdown closes Claude streams and aborts every active work registry', async () => {
  const events = [];
  const result = requestActiveWorkShutdown({
    closeAllClaudeSessions: async () => { events.push('close-claude'); },
    listProviderCommands: () => [
      {
        provider: 'claude',
        registeredSessionId: null,
        abortPending: () => events.push('abort-pending-claude'),
      },
      {
        provider: 'claude',
        registeredSessionId: 'registered-claude',
        abortPending: () => events.push('abort-registered-claude'),
      },
    ],
    listCursorSessions: () => ['cursor-one'],
    abortCursorSession: (id) => events.push(`cursor:${id}`),
    listCodexSessions: () => [{ id: 'codex-one' }],
    abortCodexSession: (id) => events.push(`codex:${id}`),
    listGeminiSessions: () => ['gemini-one'],
    abortGeminiSession: (id) => events.push(`gemini:${id}`),
    abortAgentGraphRuns: () => { events.push('agent-graph'); return 2; },
    abortTopSkillJobs: () => { events.push('top-skill'); return 3; },
  });

  await result.completion;
  assert.deepEqual(result.summary, {
    pendingProviderCommands: 1,
    cursor: 1,
    codex: 1,
    gemini: 1,
    agentGraph: 2,
    topSkillJobs: 3,
  });
  assert.deepEqual(events, [
    'abort-pending-claude',
    'cursor:cursor-one',
    'codex:codex-one',
    'gemini:gemini-one',
    'agent-graph',
    'top-skill',
    'close-claude',
  ]);
});
