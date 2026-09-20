import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

// Invoked by the isolated fixture with --verify. No live model or user DB.
export async function verifyProcessingLoopLifecycle({ base, token, tenantId, workspace, root }) {
  const report = [];
  for (const rounds of [1, 2]) {
    const events = [];
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token)}&tenantId=${tenantId}`);
    const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('Loop completion timed out')); }, timeoutMs);
      const onMessage = () => {
        const error = events.find(event => event.message.kind === 'error');
        const found = events.find(predicate);
        if (!error && !found) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        if (error) reject(new Error(JSON.stringify(error.message)));
        else resolve(found);
      };
      socket.on('message', onMessage);
    });
    socket.on('message', data => events.push({ at: Date.now(), message: JSON.parse(String(data)) }));
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      socket.send(JSON.stringify({ type: 'claude-command', command: rounds === 1
        ? '请提交一次模拟任务，查询一次状态，等待循环 Hook 完成后报告结果。'
        : '请顺序执行两轮循环：第一轮 Hook 结束恢复后，再提交第二个任务并等待第二轮 Hook，最后汇总。',
      options: { workspaceId: workspace.workspaceId, projectName: workspace.name,
        projectPath: workspace.path, cwd: workspace.path, permissionMode: 'default', model: 'sonnet' } }));
      const completed = await waitFor(event => event.message.kind === 'complete' && !event.message.suspended, 45000);
      const sessionId = completed.message.sessionId;
      const final = events.find(event => event.message.kind === 'text' && event.message.content?.includes('最终汇总已完成'));
      assert.ok(final, 'final assistant response must precede completion');
      assert.ok(completed.at - final.at < 5000, 'completion must not wait for the 120-second watchdog');
      assert.equal(events.filter(event => event.message.kind === 'complete' && event.message.suspended).length, rounds);
      const finishedJobs = new Set(events.filter(event => event.message.loopStatus === 'succeeded').map(event => event.message.loopJobId));
      assert.equal(finishedJobs.size, rounds, 'each resumed loop must reach its own terminal state');
      socket.send(JSON.stringify({ type: 'check-session-status', sessionId, provider: 'claude' }));
      const status = await waitFor(event => event.message.type === 'session-status' && event.message.sessionId === sessionId, 5000);
      assert.equal(status.message.isProcessing, false, 'completed session must leave the processing registry');
      report.push({ rounds, sessionId, passed: true, finalToCompleteMs: completed.at - final.at, events });
      console.log(`PROCESSING_LOOP_VERIFIED rounds=${rounds} finalToCompleteMs=${completed.at - final.at}`);
    } finally {
      socket.close();
      await fs.writeFile(path.join(root, `regression-${rounds}-events.json`), JSON.stringify(events, null, 2));
    }
  }
  await fs.writeFile(path.join(root, 'regression-results.json'), JSON.stringify(report, null, 2));
  return report;
}
