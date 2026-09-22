// Checks real Docker isolation without calling a model or consuming model credits.
import '../server/load-env.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildSandboxArgs } from '../server/services/skill-evals/runtime.js';

const exec = promisify(execFile);
const docker = process.env.DOCKER_CLI_PATH || 'docker';
const image = process.env.SKILL_EVAL_IMAGE;
assert.ok(image, 'Set SKILL_EVAL_IMAGE in .env or the process environment');
const projection = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-sandbox-smoke-'));
const id = `ccui-sandbox-smoke-${randomUUID()}`;
let attempted = false;
const run = (args) => exec(docker, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
try {
  await fs.writeFile(path.join(projection, 'input.txt'), 'sandbox-input');
  await fs.chmod(projection, 0o755);
  await fs.chmod(path.join(projection, 'input.txt'), 0o644);
  attempted = true;
  await run(buildSandboxArgs({ id, image, projection }));
  const { stdout: config } = await run(['inspect', id]);
  const container = JSON.parse(config)[0];
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Config.User, '1000:1000');
  assert.equal(container.Mounts.filter((m) => m.Type === 'bind').length, 1);
  const { stdout } = await run(['exec', id, 'sh', '-lc', `
set -e
test "$(cat /skill/input.txt)" = sandbox-input
test "$(id -u)" = 1000
test -z "$ANTHROPIC_API_KEY"
test -z "$ANTHROPIC_AUTH_TOKEN"
test -z "$OPENAI_API_KEY"
test ! -S /var/run/docker.sock
if touch /skill/should-not-write 2>/dev/null; then exit 1; fi
if touch /etc/should-not-write 2>/dev/null; then exit 1; fi
printf sandbox-ok > /output/check.txt
/usr/bin/python3 -I -c 'from pathlib import Path; print(Path("/output/check.txt").read_text())'
`]);
  assert.equal(stdout.trim(), 'sandbox-ok');
} finally {
  try {
    if (attempted) await run(['rm', '-f', id]);
  } finally {
    await fs.rm(projection, { recursive: true, force: true });
  }
}
console.log('Docker isolation, mounted input, Python, output collection and cleanup: passed');
console.log('No model was called; run skill-evaluation-smoke.mjs after configuring Claude credentials.');
