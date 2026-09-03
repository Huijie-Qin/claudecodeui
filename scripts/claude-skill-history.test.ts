import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildClaudeUserMessage, resolveClaudeUserMessageId } from '../server/claude-sdk.js';
import { appendClaudeDisplayCommand } from '../server/modules/providers/list/claude/claude-display-command-store.js';
import { ClaudeSessionsProvider } from '../server/modules/providers/list/claude/claude-sessions.provider.js';
import { normalizedToChatMessages } from '../src/components/chat/hooks/useChatMessages';
import { computeMerged, reconcileRealtimeAfterServerRefresh } from '../src/stores/sessionMerge';
import type { NormalizedMessage } from '../src/stores/useSessionStore';
import { createClientMessageId } from '../src/utils/clientMessageId';

// Exercise the real JSONL reader, provider normalization and UI reconciliation.
// No Claude API call is needed: the fixture represents the SDK's rewritten entry.
for (const [label, input] of [
  ['same name with extra whitespace', '/game_skill   你好   '],
  ['SKILL.md alias', '/game_test 你好'],
  ['alias without arguments', '/game_test'],
  ['multiline arguments', '/game_test 第一行\n\n第二行'],
]) {
  test(`skill history stays singular after refresh and re-entry: ${label}`, async (t) => {
    const runtimeHomePath = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-skill-refresh-'));
    t.after(() => fs.rm(runtimeHomePath, { recursive: true, force: true }));
    const sessionId = 'skill-refresh';
    const clientMessageId = createClientMessageId();
    const sent = buildClaudeUserMessage(input, [], {
      uuid: resolveClaudeUserMessageId(clientMessageId),
    });
    assert.equal(sent.uuid, clientMessageId);
    assert.equal(sent.message.content, input);

    const args = input.replace(/^\/\S+\s*/, '').trim();
    const envelope = `<command-message>game_skill</command-message>\n<command-name>/game_skill</command-name>\n<command-args>${args}</command-args>`;
    const projectDirectory = path.join(runtimeHomePath, '.claude', 'projects', '-workspace');
    await fs.mkdir(projectDirectory, { recursive: true });
    await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), [
      {
        type: 'user', uuid: sent.uuid, sessionId,
        timestamp: '2026-09-03T10:20:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: envelope }] },
      },
      {
        type: 'user', uuid: 'skill-body', sessionId, isMeta: true,
        timestamp: '2026-09-03T10:20:00.001Z',
        message: { role: 'user', content: 'Base directory for this skill: /skills/game_skill\nInstructions.' },
      },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const local: NormalizedMessage = {
      id: `local_${clientMessageId}`, clientMessageId, sessionId,
      provider: 'claude', kind: 'text', role: 'user', content: input,
      // Model queueing and server/browser clock skew cannot break identity.
      timestamp: '2026-09-03T10:00:00.000Z',
    };
    const provider = new ClaudeSessionsProvider();
    const history = await provider.fetchHistory(sessionId, { runtimeHomePath });
    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].clientMessageId, clientMessageId);
    assert.equal(normalizedToChatMessages(computeMerged(history.messages, [local])).length, 1);
    assert.deepEqual(reconcileRealtimeAfterServerRefresh(history.messages, [local]), []);

    // Preserve what the user typed even if Claude chose the directory name.
    assert.equal(await appendClaudeDisplayCommand({
      runtimeHomePath, projectPath: '/workspace', sessionId,
      messageId: sent.uuid, displayCommand: input, modelContent: input,
    }), true);
    const restored = await provider.fetchHistory(sessionId, { runtimeHomePath });
    for (const realtime of [[local], [], [local]]) {
      const displayed = normalizedToChatMessages(computeMerged(restored.messages, realtime));
      assert.equal(displayed.length, 1);
      assert.equal(displayed[0].content, input.trim());
      assert.deepEqual(reconcileRealtimeAfterServerRefresh(restored.messages, realtime), []);
    }
  });
}
