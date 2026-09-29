import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

async function openTraceSocket({ base, token, tenantId }) {
  const events = [];
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token)}&tenantId=${tenantId}`);
  socket.on('message', data => events.push({ at: Date.now(), message: JSON.parse(String(data)) }));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const waitFor = (predicate, timeoutMs = 45000, { rejectErrors = true } = {}) => new Promise((resolve, reject) => {
    const check = () => {
      const failure = rejectErrors ? events.find(event => event.message.kind === 'error') : null;
      const found = events.find(predicate);
      if (!failure && !found) return;
      clearTimeout(timer);
      socket.off('message', check);
      if (failure) reject(new Error(JSON.stringify(failure.message)));
      else resolve(found);
    };
    const timer = setTimeout(() => {
      socket.off('message', check);
      reject(new Error(`Timed out waiting for event; observed ${events.length} messages`));
    }, timeoutMs);
    socket.on('message', check);
    check();
  });
  return {
    events,
    socket,
    waitFor,
    send: message => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

function chatOptions(workspace) {
  return { workspaceId: workspace.workspaceId, projectName: workspace.name,
    projectPath: workspace.path, cwd: workspace.path, permissionMode: 'default', model: 'sonnet' };
}

function snapshot(trace, requestId) {
  trace.send({ type: 'get-active-sessions', requestId });
  return trace.waitFor(event => event.message.type === 'active-sessions'
    && event.message.requestId === requestId, 5000);
}

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

      const observedLoopIds = new Set();
      for (let loopIndex = 0; loopIndex < rounds; loopIndex += 1) {
        const started = await waitFor(event => event.message.kind === 'hook_activity'
          && event.message.actionType === 'mcp_loop_run'
          && event.message.loopJobId
          && !observedLoopIds.has(event.message.loopJobId), 45000);
        observedLoopIds.add(started.message.loopJobId);
        const sessionId = started.message.sessionId;
        assert.ok(sessionId, 'loop activity must identify its parent session');

        // The original SDK query exits while the Hook polls. Wait for that
        // transition before checking the session and its concurrency lease.
        await waitFor(event => events.indexOf(event) > events.indexOf(started)
          && event.message.kind === 'status'
          && event.message.sessionId === sessionId
          && event.message.text === 'Processing', 10000);
        assert.equal(events.some(event => event.message.kind === 'complete'), false,
          'MCP polling must not complete the parent session');

        const statusRequestStart = events.length;
        socket.send(JSON.stringify({ type: 'check-session-status', sessionId, provider: 'claude' }));
        const status = await waitFor(event => events.indexOf(event) >= statusRequestStart
          && event.message.type === 'session-status'
          && event.message.sessionId === sessionId, 5000);
        assert.equal(status.message.isProcessing, true, 'MCP polling must keep the session processing');

        const requestId = `loop-concurrency-${rounds}-${loopIndex}-${Date.now()}`;
        socket.send(JSON.stringify({ type: 'get-active-sessions', requestId }));
        const snapshot = await waitFor(event => event.message.type === 'active-sessions'
          && event.message.requestId === requestId, 5000);
        assert.equal(snapshot.message.concurrency?.activeCount, 1,
          'MCP polling must retain exactly one user concurrency slot');
        assert.ok(snapshot.message.sessions?.claude?.includes(sessionId),
          'MCP polling must remain in the active session snapshot');
        assert.equal(events.some(event => event.message.kind === 'complete'), false,
          'MCP polling must not emit completion before the final answer');
      }

      const completed = await waitFor(event => event.message.kind === 'complete' && !event.message.suspended, 45000);
      const sessionId = completed.message.sessionId;
      const final = events.find(event => event.message.kind === 'text' && event.message.content?.includes('最终汇总已完成'));
      assert.ok(final, 'final assistant response must precede completion');
      assert.ok(completed.at - final.at < 5000, 'completion must not wait for the 120-second watchdog');
      assert.equal(events.filter(event => event.message.kind === 'complete').length, 1,
        'only the final Claude answer may complete the session');
      if (rounds === 1) {
        const historyResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/messages?provider=claude&tenantId=${tenantId}&workspaceId=${workspace.workspaceId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(historyResponse.status, 200, 'completed session history must be readable after refresh');
        const history = await historyResponse.json();
        const transcript = JSON.stringify(history.messages || []);
        assert.ok(transcript.includes('请提交一次模拟任务'), 'history must retain the user prompt');
        assert.ok(transcript.includes('最终汇总已完成'), 'history must retain the final answer');
      }
      const finishedJobs = new Set(events.filter(event => event.message.loopStatus === 'succeeded').map(event => event.message.loopJobId));
      assert.equal(finishedJobs.size, rounds, 'each resumed loop must reach its own terminal state');
      const statusRequestStart = events.length;
      socket.send(JSON.stringify({ type: 'check-session-status', sessionId, provider: 'claude' }));
      const status = await waitFor(event => events.indexOf(event) >= statusRequestStart
        && event.message.type === 'session-status' && event.message.sessionId === sessionId, 5000);
      assert.equal(status.message.isProcessing, false, 'completed session must leave the processing registry');

      const requestId = `loop-complete-${rounds}-${Date.now()}`;
      socket.send(JSON.stringify({ type: 'get-active-sessions', requestId }));
      const snapshot = await waitFor(event => event.message.type === 'active-sessions'
        && event.message.requestId === requestId, 5000);
      assert.equal(snapshot.message.concurrency?.activeCount, 0,
        'the final Claude completion must release the concurrency slot');
      report.push({ rounds, sessionId, passed: true, finalToCompleteMs: completed.at - final.at, events });
      console.log(`PROCESSING_LOOP_VERIFIED rounds=${rounds} finalToCompleteMs=${completed.at - final.at}`);
    } finally {
      socket.close();
      await fs.writeFile(path.join(root, `regression-${rounds}-events.json`), JSON.stringify(events, null, 2));
    }
  }

  {
    const events = [];
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token)}&tenantId=${tenantId}`);
    const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
      const existing = events.find(predicate);
      if (existing) { resolve(existing); return; }
      const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('Loop abort timed out')); }, timeoutMs);
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
      socket.send(JSON.stringify({ type: 'claude-command',
        command: '请提交一次模拟任务，查询一次状态，等待循环 Hook 完成后报告结果。',
        options: { workspaceId: workspace.workspaceId, projectName: workspace.name,
          projectPath: workspace.path, cwd: workspace.path, permissionMode: 'default', model: 'sonnet' },
      }));

      const started = await waitFor(event => event.message.kind === 'hook_activity'
        && event.message.actionType === 'mcp_loop_run' && event.message.loopJobId, 45000);
      const sessionId = started.message.sessionId;
      assert.ok(sessionId, 'abort scenario loop activity must identify its parent session');
      await waitFor(event => events.indexOf(event) > events.indexOf(started)
        && event.message.kind === 'status' && event.message.sessionId === sessionId
        && event.message.text === 'Processing', 10000);

      const statusRequestStart = events.length;
      socket.send(JSON.stringify({ type: 'check-session-status', sessionId, provider: 'claude' }));
      const activeStatus = await waitFor(event => events.indexOf(event) >= statusRequestStart
        && event.message.type === 'session-status' && event.message.sessionId === sessionId, 5000);
      assert.equal(activeStatus.message.isProcessing, true, 'loop must be processing before Stop');

      const activeRequestId = `loop-abort-active-${Date.now()}`;
      socket.send(JSON.stringify({ type: 'get-active-sessions', requestId: activeRequestId }));
      const activeSnapshot = await waitFor(event => event.message.type === 'active-sessions'
        && event.message.requestId === activeRequestId, 5000);
      assert.equal(activeSnapshot.message.concurrency?.activeCount, 1,
        'loop must occupy one concurrency slot before Stop');
      assert.ok(activeSnapshot.message.sessions?.claude?.includes(sessionId));
      assert.equal(events.some(event => event.message.kind === 'complete'), false,
        'loop must not complete before Stop');

      socket.send(JSON.stringify({ type: 'abort-session', sessionId, provider: 'claude' }));
      const acknowledged = await waitFor(event => event.message.type === 'abort-session-result'
        && event.message.sessionId === sessionId, 10000);
      assert.equal(acknowledged.message.success, true, 'Stop request must be accepted');
      const completed = await waitFor(event => event.message.kind === 'complete'
        && event.message.sessionId === sessionId && event.message.aborted === true, 10000);
      assert.ok(completed, 'stopped loop must send an aborted completion');

      const stoppedStatusRequestStart = events.length;
      socket.send(JSON.stringify({ type: 'check-session-status', sessionId, provider: 'claude' }));
      const stoppedStatus = await waitFor(event => events.indexOf(event) >= stoppedStatusRequestStart
        && event.message.type === 'session-status' && event.message.sessionId === sessionId, 5000);
      assert.equal(stoppedStatus.message.isProcessing, false, 'stopped loop must leave processing');

      const stoppedRequestId = `loop-abort-stopped-${Date.now()}`;
      socket.send(JSON.stringify({ type: 'get-active-sessions', requestId: stoppedRequestId }));
      const stoppedSnapshot = await waitFor(event => event.message.type === 'active-sessions'
        && event.message.requestId === stoppedRequestId, 5000);
      assert.equal(stoppedSnapshot.message.concurrency?.activeCount, 0,
        'stopped loop must release its concurrency slot');
      assert.equal(events.filter(event => event.message.kind === 'complete').length, 1,
        'stopped loop must send exactly one completion');
      report.push({ scenario: 'abort', sessionId, passed: true, events });
      console.log(`PROCESSING_LOOP_ABORT_VERIFIED session=${sessionId}`);
    } finally {
      socket.close();
      await fs.writeFile(path.join(root, 'regression-abort-events.json'), JSON.stringify(events, null, 2));
    }
  }

  {
    const parent = await openTraceSocket({ base, token, tenantId });
    let reconnected = null;
    let competing = null;
    let competingEvents = [];
    try {
      parent.send({ type: 'claude-command', command: '请提交一次模拟任务，查询一次状态，等待循环 Hook 完成后报告结果。',
        options: chatOptions(workspace) });
      const started = await parent.waitFor(event => event.message.kind === 'hook_activity'
        && event.message.actionType === 'mcp_loop_run' && event.message.loopJobId);
      const sessionId = started.message.sessionId;
      await parent.waitFor(event => parent.events.indexOf(event) > parent.events.indexOf(started)
        && event.message.kind === 'status' && event.message.sessionId === sessionId
        && event.message.text === 'Processing', 10000);
      const active = await snapshot(parent, `limit-active-${Date.now()}`);
      assert.equal(active.message.concurrency?.limit, 1);
      assert.equal(active.message.concurrency?.activeCount, 1);

      competing = await openTraceSocket({ base, token, tenantId });
      competing.send({ type: 'claude-command', command: '这是另一个新会话', options: chatOptions(workspace) });
      const rejection = await competing.waitFor(event => event.message.kind === 'error'
        && event.message.code === 'SESSION_LIMIT_EXCEEDED', 10000, { rejectErrors: false });
      assert.equal(rejection.message.currentConcurrentRequests, 1);
      assert.equal(rejection.message.sessionLimit, 1);
      assert.equal(competing.events.some(event => event.message.kind === 'session_created'), false,
        'the rejected request must not start another session');
      competingEvents = competing.events;
      competing.close();
      competing = null;

      parent.close();
      reconnected = await openTraceSocket({ base, token, tenantId });
      reconnected.send({ type: 'check-session-status', sessionId, provider: 'claude' });
      const recovered = await reconnected.waitFor(event => event.message.type === 'session-status'
        && event.message.sessionId === sessionId, 5000);
      assert.equal(recovered.message.isProcessing, true);
      assert.equal(recovered.message.status?.text, 'Processing');
      const polling = await snapshot(reconnected, `limit-reconnected-${Date.now()}`);
      assert.equal(polling.message.concurrency?.activeCount, 1);
      assert.ok(polling.message.sessions?.claude?.includes(sessionId));
      assert.equal(reconnected.events.some(event => event.message.kind === 'complete'), false);

      const completed = await reconnected.waitFor(event => event.message.kind === 'complete'
        && event.message.sessionId === sessionId, 45000);
      assert.equal(completed.message.aborted, false);
      const available = await snapshot(reconnected, `limit-available-${Date.now()}`);
      assert.equal(available.message.concurrency?.activeCount, 0);

      // A new request may start as soon as the loop and its Agent reply finish.
      reconnected.send({ type: 'claude-command', command: '再发起一个会话以验证名额已释放', options: chatOptions(workspace) });
      const nextSession = await reconnected.waitFor(event => event.message.kind === 'session_created'
        && event.message.sessionId !== sessionId, 15000);
      assert.ok(nextSession.message.sessionId);
      reconnected.send({ type: 'abort-session', sessionId: nextSession.message.sessionId, provider: 'claude' });
      await reconnected.waitFor(event => event.message.kind === 'complete'
        && event.message.sessionId === nextSession.message.sessionId && event.message.aborted === true, 15000);
      const cleared = await snapshot(reconnected, `limit-cleared-${Date.now()}`);
      assert.equal(cleared.message.concurrency?.activeCount, 0);
      report.push({ scenario: 'limit-and-reconnect', sessionId, passed: true,
        parentEvents: parent.events, competingEvents, events: reconnected.events });
      console.log(`PROCESSING_LOOP_LIMIT_RECONNECT_VERIFIED session=${sessionId}`);
    } finally {
      parent.close();
      competing?.close();
      reconnected?.close();
      await fs.writeFile(path.join(root, 'regression-limit-parent-events.json'), JSON.stringify(parent.events, null, 2));
      await fs.writeFile(path.join(root, 'regression-limit-reconnected-events.json'), JSON.stringify(reconnected?.events || [], null, 2));
    }
  }

  for (const scenario of [
    { name: 'parallel', command: '请并行两项任务，分别查询状态，等待两个循环完成后汇总。', expectedJobs: 2, expectedStatus: 'succeeded' },
    { name: 'failed-result', command: '请提交失败任务，查询状态，等待循环返回失败结果后汇总。', expectedJobs: 1, expectedStatus: 'failed' },
  ]) {
    const trace = await openTraceSocket({ base, token, tenantId });
    try {
      trace.send({ type: 'claude-command', command: scenario.command, options: chatOptions(workspace) });
      const started = await trace.waitFor(event => event.message.kind === 'hook_activity'
        && event.message.actionType === 'mcp_loop_run' && event.message.loopJobId);
      const sessionId = started.message.sessionId;
      await trace.waitFor(event => trace.events.indexOf(event) > trace.events.indexOf(started)
        && event.message.kind === 'status' && event.message.sessionId === sessionId
        && event.message.text === 'Processing', 10000);
      const polling = await snapshot(trace, `${scenario.name}-polling-${Date.now()}`);
      assert.equal(polling.message.concurrency?.activeCount, 1);
      assert.equal(trace.events.some(event => event.message.kind === 'complete'), false);

      const completed = await trace.waitFor(event => event.message.kind === 'complete'
        && event.message.sessionId === sessionId, 45000);
      assert.equal(completed.message.aborted, false);
      const terminalJobs = new Set(trace.events.filter(event => event.message.kind === 'hook_activity'
        && event.message.loopStatus === scenario.expectedStatus).map(event => event.message.loopJobId));
      assert.equal(terminalJobs.size, scenario.expectedJobs,
        `${scenario.name} must deliver every terminal job before the final Agent reply`);
      assert.equal(trace.events.filter(event => event.message.kind === 'complete').length, 1);
      const done = await snapshot(trace, `${scenario.name}-done-${Date.now()}`);
      assert.equal(done.message.concurrency?.activeCount, 0);
      report.push({ scenario: scenario.name, sessionId, passed: true, events: trace.events });
      console.log(`PROCESSING_LOOP_${scenario.name.toUpperCase().replaceAll('-', '_')}_VERIFIED session=${sessionId}`);
    } finally {
      trace.close();
      await fs.writeFile(path.join(root, `regression-${scenario.name}-events.json`), JSON.stringify(trace.events, null, 2));
    }
  }

  await fs.writeFile(path.join(root, 'regression-results.json'), JSON.stringify(report, null, 2));
  return report;
}
