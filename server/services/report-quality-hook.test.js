import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeHookScript } from './hook-script-executor.js';
import { REPORT_QUALITY_HOOK_EXAMPLE } from './report-quality-hook.js';

const config = {
  enabled: true, reference: 'reports/example.html', report: 'reports/report.html',
  source: 'reports/data.json', checkerSkill: '.claude/skills/check-html-report/SKILL.md',
  verdict: '.ccui/report-quality-result.json', maxAttempts: 3,
};
const checkerScript = '.claude/skills/check-html-report/scripts/check_report.py';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccui-report-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (file, data) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), typeof data === 'string' ? data : JSON.stringify(data));
  };
  await write('.ccui/report-quality.json', config);
  await write(config.reference, '<html>示例</html>');
  await write(config.report, '<html>本次数据</html>');
  await write(config.source, { total: 0 });
  await write(config.checkerSkill, '# Checker');
  await write(checkerScript, '# Test checker');
  const run = async (active = false, sessionId = 'session-one') => (await executeHookScript({
    hookId: 'report-gate', ...REPORT_QUALITY_HOOK_EXAMPLE.extensionLogic,
    workspaceRoot: root, env: {}, event: { session_id: sessionId, stop_hook_active: active },
  })).output;
  const state = async (session = 'session-one') => JSON.parse(await fs.readFile(path.join(root, `.ccui/report-quality-runs/${session}.json`), 'utf8'));
  const verdict = async (overrides = {}, session = 'session-one') => {
    const current = await state(session);
    const reportHash = createHash('sha256').update(await fs.readFile(path.join(root, config.report))).digest('hex');
    await write(config.verdict, {
      version: 1, sessionId: session, attemptToken: current.token,
      passed: true, checks: { structure: true, completeness: true, data: true }, issues: [],
      fingerprints: { ...current.baseline, report: reportHash }, ...overrides,
    });
  };
  return { root, write, run, state, verdict };
}

test('Stop blocks until a fresh full verdict, then allows completion; each new turn rechecks', async (t) => {
  const f = await fixture(t);
  const first = await f.run();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /python3 .*--session-id 'session-one' --attempt-token/);
  await f.verdict({ passed: false, checks: { structure: false, completeness: true, data: true }, issues: [{ message: '缺少区域表' }] });
  const repair = await f.run(true);
  assert.equal(repair.decision, 'block');
  assert.match(repair.reason, /缺少区域表/);
  await f.verdict();
  assert.equal((await f.run(true)).status, 'passed');
  assert.equal((await f.run()).decision, 'block');
});

test('changed reports, forged partial passes and another session verdict cannot finish', async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.verdict();
  await f.write(config.report, '<html>改过的报告</html>');
  assert.equal((await f.run(true)).decision, 'block');
  await f.verdict({ checks: { structure: true, completeness: true, data: false } });
  assert.equal((await f.run(true)).decision, 'block');
  await f.verdict({ sessionId: 'someone-else' });
  const stopped = await f.run(true);
  assert.equal(stopped.continue, false);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.stopReason, /3 轮仍未通过/);
});

test('editing the template or disabling config during repair fails explicitly', async (t) => {
  const f = await fixture(t);
  await f.run();
  await f.write(config.reference, 'weakened template');
  assert.equal((await f.run(true)).continue, false);
  await f.run(); // A new user turn can establish a new baseline.
  await f.write('.ccui/report-quality.json', { ...config, enabled: false });
  assert.equal((await f.run(true)).continue, false);
  assert.equal((await f.run()).status, 'inactive');
});

test('missing input data fails explicitly; missing report requests generation; absent config is inactive', async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, config.report));
  const missingReport = await f.run();
  assert.equal(missingReport.decision, 'block');
  assert.match(missingReport.reason, /尚未生成报告文件/);
  await fs.rm(path.join(f.root, config.source));
  assert.equal((await f.run()).continue, false);
  await fs.rm(path.join(f.root, '.ccui/report-quality.json'));
  assert.equal((await f.run()).status, 'inactive');
  assert.equal((await f.run(true)).continue, false);
});

test('a new user turn recovers from interrupted state writes and can disable the workflow', async (t) => {
  const f = await fixture(t);
  await f.write('.ccui/report-quality-runs/session-one.json', '{broken');
  assert.equal((await f.run()).decision, 'block');
  await f.write('.ccui/report-quality-runs/session-one.json', '{broken');
  await f.write('.ccui/report-quality.json', { ...config, enabled: false });
  assert.equal((await f.run()).status, 'inactive');
});

test('configured paths cannot overlap inputs through dot aliases or use the gate state directory', async (t) => {
  const f = await fixture(t);
  for (const report of ['reports/./example.html', '.ccui/report-quality-runs/session-one.json', '/reports/report.html']) {
    await f.write('.ccui/report-quality.json', { ...config, report });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.continue, false);
  }
});

test('workspace fingerprints use raw bytes in JS and Python and enforce workspace boundaries', async (t) => {
  const f = await fixture(t);
  const data = Buffer.from([0, 255, 128, 10]);
  await fs.writeFile(path.join(f.root, 'bytes.bin'), data);
  const digest = createHash('sha256').update(data).digest('hex');
  for (const language of ['javascript', 'python']) {
    const code = language === 'python'
      ? 'async def run(event, ccui):\n    return {"hash": await ccui.workspace.sha256(event["path"])}'
      : 'async function run(event, ccui) { return {hash: await ccui.workspace.sha256(event.path)}; }';
    const options = { language, code, workspaceRoot: f.root, env: {}, event: { path: 'bytes.bin' } };
    assert.equal((await executeHookScript(options)).hash, digest);
    await assert.rejects(executeHookScript({ ...options, event: { path: '../outside' } }), /inside the current workspace/);
    await fs.symlink('/etc/hosts', path.join(f.root, `outside-${language}`));
    await assert.rejects(executeHookScript({ ...options, event: { path: `outside-${language}` } }), /symbolic link outside/);
  }
});
