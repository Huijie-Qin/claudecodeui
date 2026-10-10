// This worker only transforms an in-memory transcript. In particular, it never
// starts a Claude query, reads a default HOME, or discovers sessions on disk.
import { forkSession } from '@anthropic-ai/claude-agent-sdk';

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { sourceSessionId, sourceMessageUuid, sourceEntries, title } = JSON.parse(
    Buffer.concat(chunks).toString('utf8'),
  );
  let forkEntries = [];
  let writtenSessionId;
  const sessionStore = {
    async load(key) {
      return key.sessionId === sourceSessionId ? sourceEntries : null;
    },
    async append(key, entries) {
      if (key.sessionId === sourceSessionId || (writtenSessionId && writtenSessionId !== key.sessionId)) {
        throw new Error('Unexpected fork destination');
      }
      writtenSessionId = key.sessionId;
      forkEntries.push(...entries);
    },
  };
  const result = await forkSession(sourceSessionId, {
    // The explicit directory is only a store namespace, never a path to scan.
    dir: '/ccui-session-fork',
    upToMessageId: sourceMessageUuid,
    title,
    sessionStore,
  });
  if (result.sessionId !== writtenSessionId || forkEntries.length === 0) {
    throw new Error('Claude SDK did not fork through the supplied session store');
  }
  process.stdout.write(JSON.stringify({ sessionId: result.sessionId, forkEntries }));
} catch (error) {
  // Do not emit transcript content on an IPC or SDK failure.
  process.stderr.write(error instanceof Error ? error.message : 'Claude session fork failed');
  process.exitCode = 1;
}
