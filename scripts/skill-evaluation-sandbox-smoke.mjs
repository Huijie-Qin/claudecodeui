// Checks real Docker mounts and MCP connectivity without model calls or real external services.
import '../server/load-env.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { prepareEvaluationSession } from '../server/services/skill-evals/session-container.js';
import { resolveEvaluationSandboxConfig } from '../server/services/skill-evals/sandbox-image.js';

const exec = promisify(execFile);
const { docker, image } = resolveEvaluationSandboxConfig();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-sandbox-smoke-'));
const original = path.join(temp, 'original'), projection = path.join(temp, 'skill');
const id = `ccui-sandbox-smoke-${randomUUID()}`;
let attempted = false;
const run = (args) => exec(docker, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
const config = { mcpServers: { fixture: { type: 'http', url: 'http://127.0.0.1:23456/mcp' } } };
try {
  await fs.mkdir(original); await fs.mkdir(projection);
  await fs.writeFile(path.join(original, '.mcp.json'), JSON.stringify(config));
  await fs.writeFile(path.join(projection, 'input.txt'), 'sandbox-input', { mode: 0o644 });
  await fs.chmod(projection, 0o755);
  const session = await prepareEvaluationSession({ scope: { workspacePath: original }, temp, projection, id, image, docker,
    env: { ...process.env, CLOUDCLI_DOCKER_SHARED_PYTHON: 'false' }, auth: {} });
  attempted = true;
  await run(session.args);
  const { stdout: inspected } = await run(['inspect', id]);
  const container = JSON.parse(inspected)[0];
  assert.notEqual(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Mounts.filter(m => m.Type === 'bind').length, 3);
  assert.ok(container.Mounts.every(m => m.Source !== original));
  const { stdout } = await run(['exec', id, 'sh', '-lc', `
set -e
test "$(cat /skill/input.txt)" = sandbox-input
test -z "$ANTHROPIC_API_KEY"
test -z "$ANTHROPIC_AUTH_TOKEN"
test ! -S /var/run/docker.sock
if touch /skill/should-not-write 2>/dev/null; then exit 1; fi
if touch /etc/should-not-write 2>/dev/null; then exit 1; fi
printf workspace-ok > /workspace/local-result.txt
printf home-ok > /home/cloudcli/local-result.txt
printf sandbox-ok > /output/check.txt
/usr/bin/python3 -I -c 'from pathlib import Path; print(Path("/output/check.txt").read_text())'
`]);
  assert.equal(stdout.trim(), 'sandbox-ok');
  const { stdout: mcpResult } = await run(['exec', id, 'node', '--input-type=module', '-e', `
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const config = JSON.parse(fs.readFileSync('/workspace/.mcp.json', 'utf8'));
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  assert.equal(request.method, 'tools/call');
  assert.equal(request.params.name, 'echo');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'mcp-ok' }] } }));
});
await new Promise(resolve => server.listen(23456, '127.0.0.1', resolve));
try {
  const response = await fetch(config.mcpServers.fixture.url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }) });
  assert.equal((await response.json()).result.content[0].text, 'mcp-ok');
  console.log('mcp-ok');
} finally { await new Promise(resolve => server.close(resolve)); }
`]);
  assert.equal(mcpResult.trim(), 'mcp-ok');
  assert.equal(await fs.readFile(path.join(original, '.mcp.json'), 'utf8'), JSON.stringify(config));
} finally {
  try { if (attempted) await run(['rm', '-f', id]); }
  finally { await fs.rm(temp, { recursive: true, force: true }); }
}
console.log('Docker network, isolated workspace/home, MCP fixture, read-only skill and cleanup: passed');
console.log('No Claude CLI/model or real workspace MCP service was called.');
