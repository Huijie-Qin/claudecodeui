import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeProcessDiagnostics } from './claude-sdk-diagnostics.js';

test('explicit Hook secrets redact custom names, short values and encoded values in process diagnostics', () => {
  const diagnostics = createClaudeProcessDiagnostics();
  const secret = '测试 value\nwith "quotes"';
  diagnostics.addRedactionValues([secret, 'tiny']);
  diagnostics.appendOutput('stdout', JSON.stringify({ custom_name: secret }));
  diagnostics.appendOutput('stderr', `failed: ${secret}; ${encodeURIComponent(secret)}; tiny`);
  const spawn = diagnostics.createSpawn(() => { throw new Error(secret); });
  assert.throws(() => spawn({ command: 'claude', args: [secret, 'tiny'] }));
  const snapshot = diagnostics.snapshot({ arbitrary: secret });
  assert.equal(snapshot.arbitrary, '[redacted]');
  assert.equal(snapshot.spawnError, '[redacted]');
  assert.deepEqual(snapshot.args, ['[redacted]', '[redacted]']);
  assert.equal(snapshot.stdoutTail, '{"custom_name":"[redacted]"}');
  assert.equal(snapshot.stderrTail, 'failed: [redacted]; [redacted]; [redacted]');
  assert.equal(diagnostics.redactText(secret), '[redacted]');
  assert.deepEqual(diagnostics.redactValue({ custom_name: secret }), { custom_name: '[redacted]' });
  diagnostics.addRedactionValues(['updated-secret']);
  assert.equal(diagnostics.redactText('tiny updated-secret'), '[redacted] [redacted]');
});
