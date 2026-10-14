import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { isInheritedUsageMessage } from './ai-usage-inheritance.js';

// Only completion identity is evidence. The sidecar write time is NOT the
// response timestamp and must never extend a request's measured interval.
export async function readTranscriptCompletionMarkers(file, { checkWindow = () => {} } = {}) {
  const markerFile = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'completed-replies.jsonl');
  const completedReplyUuids = new Set();
  let handle;
  try {
    handle = await fs.open(markerFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await handle.stat();
    if (!before.isFile()) return { completedReplyUuids, fingerprint: 'unreadable', status: 'unreadable' };
    const hash = createHash('sha256');
    let offset = 0, carry = Buffer.alloc(0), oversized = false;
    while (offset < before.size) {
      checkWindow();
      const buffer = Buffer.alloc(Math.min(256 * 1024, before.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw Object.assign(new Error('Changed completion markers'), { code: 'FILE_CHANGED' });
      offset += bytesRead;
      const chunk = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      let start = 0;
      for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
        if (!oversized && end - start <= 2 * 1024 * 1024) {
          const line = chunk.subarray(start, end);
          hash.update(line).update('\n');
          try {
            const record = JSON.parse(line.toString('utf8'));
            if (!isInheritedUsageMessage(record) && record.version === 1 && typeof record.sourceMessageUuid === 'string' && record.sourceMessageUuid
              && record.sourceMessageUuid.length <= 256) completedReplyUuids.add(record.sourceMessageUuid);
          } catch { /* An invalid marker supplies no completion evidence. */ }
        }
        oversized = false;
        start = end + 1;
      }
      carry = chunk.subarray(start);
      if (carry.length > 2 * 1024 * 1024) { carry = Buffer.alloc(0); oversized = true; }
    }
    const after = await handle.stat();
    const current = await fs.stat(markerFile);
    if (before.ino !== current.ino || before.dev !== current.dev || after.size < before.size
      || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) {
      throw Object.assign(new Error('Changed completion markers'), { code: 'FILE_CHANGED' });
    }
    return { completedReplyUuids, fingerprint: hash.digest('hex'), status: 'read' };
  } catch (error) {
    // Lease/window failures must keep their batch-level meaning.
    if (!error.code || !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EIO', 'ESTALE', 'FILE_CHANGED'].includes(error.code)) throw error;
    const status = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable';
    return { completedReplyUuids: new Set(), fingerprint: status, status };
  } finally { await handle?.close(); }
}
