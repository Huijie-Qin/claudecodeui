import path from 'node:path';

import { redact } from './contracts.js';

export function createInvocationCapture({ skillRoot, save }) {
  let last = null, usable = true, finished = false;
  return {
    observe(messages) {
      for (const message of messages) {
        if (message.kind === 'error') usable = false;
        if (message.kind === 'tool_use') {
          const input = message.input || message.toolInput || {};
          // External tools, shell reads and output files need a fixture adapter; never silently drop them.
          const file = typeof input.file_path === 'string' ? path.resolve(input.file_path) : '';
          if (message.toolName !== 'Read' || !file.startsWith(`${skillRoot}${path.sep}`) || file.includes(`${path.sep}evals${path.sep}`)) usable = false;
        }
        if (message.kind === 'text' && message.role === 'assistant' && !message.parentToolUseId) last = message;
      }
    },
    reject() { usable = false; },
    finish() {
      if (finished) return; finished = true;
      const output = String(last?.content || last?.text || '');
      if (!usable || !last?.id || !output.trim() || output.length > 50000 || redact(output) !== output) return;
      save({ messageId: last.id, output });
    },
  };
}
