import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveDockerSharedPythonPath } from '../agent-session-runtime.js';

import { prepareEvaluationSession, readEvaluationMcpConfig } from './session-container.js';
import { createEvaluationRuntime } from './runtime.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-mcp-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'original'), temp = path.join(root, 'case');
  await fs.mkdir(workspace); await fs.mkdir(temp);
  return { root, workspace, temp };
}

test('MCP config is optional but invalid, oversized and linked configurations fail without exposing content', async t => {
  const f = await fixture(t), file = path.join(f.workspace, '.mcp.json');
  assert.deepEqual(await readEvaluationMcpConfig(f.workspace), {});
  for (const content of ['secret-unparseable', '[]', '{"mcpServers":[]}', '{"mcpServers":{"x":null}}', 'x'.repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(file, content);
    await assert.rejects(readEvaluationMcpConfig(f.workspace), error => error.code === 'EVAL_MCP_CONFIG_INVALID' && !error.message.includes('secret-unparseable'));
  }
  await fs.unlink(file);
  await fs.writeFile(path.join(f.root, 'outside.json'), '{}');
  await fs.symlink(path.join(f.root, 'outside.json'), file);
  await assert.rejects(readEvaluationMcpConfig(f.workspace), { code: 'EVAL_MCP_CONFIG_INVALID' });
});

test('session settings, network, helpers and MCP config use temporary mounts and container-only model execution', async t => {
  const f = await fixture(t);
  const config = { mcpServers: { reports: { type: 'http', url: 'http://host.docker.internal:3001/mcp', headers: { Authorization: 'private-mcp-value' } } } };
  await fs.writeFile(path.join(f.workspace, '.mcp.json'), JSON.stringify(config));
  let helperOptions, spawnCall;
  const access = { disallowedTools: ['mcp__reports__delete'], isAllowed: name => name !== 'mcp__reports__delete' };
  const session = await prepareEvaluationSession({ scope: { id: 'job', workspacePath: f.workspace, tenantId: 1, workspaceId: 2, userId: 3 },
    temp: f.temp, projection: path.join(f.temp, 'skill'), id: 'case-container', image: 'session-image', docker: '/custom/docker',
    env: { CLOUDCLI_DOCKER_MEMORY: '3g', CLOUDCLI_DOCKER_CPUS: '3', CLOUDCLI_DOCKER_SHARED_PYTHON: 'false' },
    auth: { ANTHROPIC_API_KEY: 'model-private-value' },
    applyHelpers: async (servers, options) => { helperOptions = options; return servers; },
    resolveAccess: scope => { assert.equal(scope.userId, 3); return access; },
    spawnImpl: (...args) => { spawnCall = args; return 'fake-child'; },
  });
  assert.equal(helperOptions.runtimeMode, 'docker');
  assert.equal(helperOptions.runtimeHomePath, session.home);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(session.workspace, '.mcp.json'), 'utf8')), config);
  assert.ok(session.args.includes('host.docker.internal:host-gateway'));
  assert.ok(!session.args.includes('--network=none'));
  assert.ok(session.args.includes('3g'));
  assert.ok(session.args.includes('--read-only'));
  const mounts = session.args.filter(value => value.startsWith('type=bind'));
  assert.equal(mounts.length, 3);
  assert.ok(mounts.every(value => value.startsWith(`type=bind,src=${f.temp}/`)));
  assert.ok(mounts.some(value => value.endsWith('dst=/skill,readonly')));
  assert.ok(!JSON.stringify(session.args).includes('private-value'));
  assert.equal(session.spawn({ args: ['--version'], env: session.env }), 'fake-child');
  assert.equal(spawnCall[0], '/custom/docker');
  assert.ok(spawnCall[1].includes('claude'));
  assert.ok(spawnCall[1].includes('ANTHROPIC_API_KEY=model-private-value'));
  assert.ok(!JSON.stringify(spawnCall[2]).includes('model-private-value'));
  assert.equal(session.sanitize('private-mcp-value model-private-value'), '[REDACTED] [REDACTED]');
  assert.equal(session.access, access);
});

test('case MCP calls honor user restrictions, record evidence and clean up without changing workspace config', async t => {
  const f = await fixture(t);
  const config = { mcpServers: { reports: { type: 'http', url: 'http://test.invalid/mcp', headers: { Authorization: 'private-mcp-value' } } } };
  const original = JSON.stringify(config);
  await fs.writeFile(path.join(f.workspace, '.mcp.json'), original);
  const commands = []; let caseWorkspace;
  const runtime = createEvaluationRuntime({ env: { CLOUDCLI_DOCKER_SHARED_PYTHON: 'false' },
    resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'model-private-value' }),
    command: async (_binary, args) => {
      commands.push(args);
      if (args.includes('/usr/bin/python3')) return { stdout: '{}', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    runQuery: ({ options }) => (async function* () {
      caseWorkspace = options.cwd;
      assert.deepEqual(options.mcpServers.reports, config.mcpServers.reports);
      assert.equal(options.strictMcpConfig, true);
      assert.ok(options.tools.includes('Bash'));
      assert.equal(options.env.HOME, '/home/cloudcli');
      assert.equal(options.pathToClaudeCodeExecutable, 'claude');
      assert.equal((await options.canUseTool('mcp__reports__query', {})).behavior, 'allow');
      assert.equal((await options.canUseTool('mcp__unconfigured__query', {})).behavior, 'deny');
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__reports__query', input: { query: 'select 1' } }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'private-mcp-value: result' }] } };
      yield { type: 'result', subtype: 'success', result: 'private-mcp-value: done', total_cost_usd: 0.01 };
    })(),
  });
  const result = await runtime.runCase({ scope: { id: 'job', workspacePath: f.workspace },
    files: { 'SKILL.md': Buffer.from('Use reports MCP').toString('base64') }, testCase: { prompt: 'Query reports', files: [] },
    budget: { remainingUsd: 5, calls: 0, costUsd: 0 }, runtimeProfile: { model: 'test', image: 'session-image' } });
  assert.equal(result.events.find(event => event.kind === 'tool_use').tool, 'mcp__reports__query');
  assert.equal(typeof result.events.find(event => event.kind === 'tool_use').input, 'string');
  assert.equal(result.events.find(event => event.kind === 'tool_result').parent, result.events.find(event => event.kind === 'tool_use').id);
  assert.ok(!JSON.stringify(result).includes('private-mcp-value'));
  assert.ok(commands.some(args => args[0] === 'rm'));
  await assert.rejects(fs.access(caseWorkspace), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.workspace, '.mcp.json'), 'utf8'), original);
});

test('MCP permission checks reject disabled tools even when the server is configured', async () => {
  const runtime = createEvaluationRuntime({ resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test' }), runQuery: ({ options }) => (async function* () {
    assert.deepEqual(options.disallowedTools, ['mcp__reports__write']);
    assert.equal((await options.canUseTool('mcp__reports__write', {})).behavior, 'deny');
    assert.equal((await options.canUseTool('mcp__reports__read', {})).behavior, 'allow');
    yield { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0 };
  })() });
  await runtime.modelCall({ scope: {}, prompt: 'test', budget: { remainingUsd: 2, calls: 0, costUsd: 0 }, execution: {
    workspace: '/tmp', env: {}, spawn: () => {}, mcpServers: { reports: { type: 'http', url: 'http://test.invalid' } },
    access: { disallowedTools: ['mcp__reports__write'], isAllowed: name => name !== 'mcp__reports__write' },
  } });
});

test('shared Python packages use the session image name and are mounted read-only', async t => {
  const f = await fixture(t);
  const env = { CLOUDCLI_RUNTIME_ROOT: path.join(f.root, 'runtimes') };
  const shared = resolveDockerSharedPythonPath(env, 'workspace:prod');
  await fs.mkdir(shared, { recursive: true });
  const session = await prepareEvaluationSession({ scope: {}, temp: f.temp, projection: path.join(f.temp, 'skill'), id: 'shared-case',
    image: 'sha256:inspected', sharedImage: 'workspace:prod', docker: 'docker', env, auth: {} });
  assert.ok(session.args.includes(`type=bind,src=${shared},dst=/opt/cloudcli/python,readonly`));
});

test('model failure and cancellation still remove the temporary case container', async () => {
  for (const cancel of [false, true]) {
    const calls = [], controller = new AbortController();
    const runtime = createEvaluationRuntime({ env: { CLOUDCLI_DOCKER_SHARED_PYTHON: 'false' }, resolveEnvironment: () => ({ ANTHROPIC_API_KEY: 'test' }),
      command: async (_bin, args) => { calls.push(args); return { stdout: '' }; },
      runQuery: () => (async function* () { if (cancel) controller.abort(new Error('cancelled')); throw new Error('model failed'); })(),
    });
    await assert.rejects(runtime.runCase({ scope: { id: 'cleanup' }, files: { 'SKILL.md': 'eA==' }, testCase: { prompt: 'test' }, signal: controller.signal,
      budget: { remainingUsd: 2, calls: 0, costUsd: 0 }, runtimeProfile: { image: 'session-image' } }));
    assert.ok(calls.some(args => args[0] === 'rm'));
    const workspaceMount = calls.find(args => args[0] === 'run').find(value => value.endsWith('dst=/workspace'));
    await assert.rejects(fs.access(workspaceMount.split('src=')[1].split(',dst=')[0]), { code: 'ENOENT' });
  }
});
