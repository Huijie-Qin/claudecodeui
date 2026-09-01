import { promises as fs } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

const baseUrl = String(process.env.CCUI_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const username = String(process.env.CCUI_ADMIN_USERNAME || 'root');
const password = String(process.env.CCUI_ADMIN_PASSWORD || '');
if (!password) throw new Error('CCUI_ADMIN_PASSWORD is required');

async function request(route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${route} failed (${response.status}): ${payload.error || payload.message || 'unknown error'}`);
  }
  return payload;
}

async function runClaudeTurn({ token, tenantId, project }) {
  const wsUrl = new URL(baseUrl.replace(/^http/, 'ws') + '/ws');
  wsUrl.searchParams.set('token', token);
  wsUrl.searchParams.set('tenantId', String(tenantId));
  const messages = [];
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 15_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', reject);
  });

  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Claude Hook verification timed out')), 240_000);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.kind === 'error' || message.type === 'error') {
        clearTimeout(timer);
        reject(new Error(message.content || message.error || 'Claude turn failed'));
      }
      if (message.kind === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.send(JSON.stringify({
    type: 'claude-command',
    command: 'Return exactly this SQL in one fenced sql block, with no prose: SELECT id,\\n       username\\nFROM users;',
    options: {
      projectName: project.name,
      projectPath: project.fullPath,
      cwd: project.fullPath,
      workspaceId: project.workspaceId,
      sessionId: null,
      resume: false,
      permissionMode: 'bypassPermissions',
      toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: true },
      sessionSummary: 'Hook verification',
    },
  }));

  await completed;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  socket.close();
  return messages;
}

const auth = await request('/api/auth/login', {
  method: 'POST',
  body: { username, password },
});
if (!auth.user?.is_system_admin) throw new Error('Verification user is not a system administrator');
const token = auth.token;

const tenantPayload = await request('/api/admin/tenants', { token });
const tenant = (tenantPayload.tenants || []).find((item) => item.code === 'default') || tenantPayload.tenants?.[0];
if (!tenant?.id) throw new Error('No tenant is available for Hook verification');

let projects = await request(`/api/projects?tenantId=${tenant.id}`, { token });
let project = projects.find((item) => item.name === 'hook-verification');
if (!project) {
  const created = await request(`/api/projects/create-workspace?tenantId=${tenant.id}`, {
    method: 'POST',
    token,
    body: { workspaceType: 'new', path: 'hook-verification' },
  });
  project = created.project;
}

const beforeHooks = await request('/api/admin/hooks', { token });
const hooksByName = new Map((beforeHooks.hooks || []).map((hook) => [hook.name, hook]));
const sqlHook = hooksByName.get('SQL 响应指标记录');
const normalHook = hooksByName.get('对话正常结束通知');
const failureHook = hooksByName.get('失败通知与 HTTP 200 会话恢复');
if (![sqlHook, normalHook, failureHook].every((hook) => hook?.status === 'published' && hook.boundUserCount > 0)) {
  throw new Error('One or more requested Hooks are not published and bound to a user');
}

const messages = await runClaudeTurn({ token, tenantId: tenant.id, project });
const serializedMessages = JSON.stringify(messages);
const markerSeenInConversation = serializedMessages.includes('HOOK_NOTIFICATION_SKILL_EXECUTED');

const notificationPath = path.join(project.fullPath, '.ccui', 'hook-notifications.jsonl');
const notificationText = await fs.readFile(notificationPath, 'utf8');
const notifications = notificationText.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const lastNotification = notifications.at(-1);
if (lastNotification?.executed !== true || lastNotification?.skill !== 'hook-notification') {
  throw new Error('Notification Skill did not produce its verification record');
}

const sqlRecordsPayload = await request(`/api/admin/hooks/${sqlHook.id}/data-records?limit=20`, { token });
const sqlRecord = (sqlRecordsPayload.records || []).find((record) => record.type === 'sql_response_metrics');
if (!sqlRecord?.data?.sqlLineCount || sqlRecord.data.statementCount !== 1) {
  throw new Error('SQL metrics Hook did not write the expected structured record');
}

const { hookConfigService } = await import('file:///app/dist-server/server/services/hook-configs.js');
const { createHookRuntimeSession } = await import('file:///app/dist-server/server/services/hook-runtime.js');
const activeHooks = hookConfigService.listActiveHooksForUser(auth.user.id);
const activeFailureHook = activeHooks.find((hook) => hook.id === failureHook.id);
const recoveryRequests = [];
const runtime = createHookRuntimeSession({
  hooks: [activeFailureHook],
  userId: auth.user.id,
  username,
  tenantId: tenant.id,
  workspaceId: project.workspaceId,
  workspaceRoot: project.fullPath,
  enqueueSkillRecovery: async (requestData) => recoveryRequests.push(requestData),
});
await runtime.executeHook(activeFailureHook, {
  hook_event_name: 'StopFailure',
  session_id: 'verification-http-200-session',
  error: 'server_error',
  error_details: 'upstream stream ended unexpectedly with HTTP 200',
  last_assistant_message: '',
});
const recovery = recoveryRequests[0];
if (!recovery || recovery.displayCommand.includes('HTTP 200') === false || recovery.modelContent.includes('HTTP 200') === false) {
  throw new Error('HTTP 200 StopFailure did not enqueue the recovery Skill turn');
}

const executionSummaries = {};
for (const hook of [sqlHook, normalHook, failureHook]) {
  const payload = await request(`/api/admin/hooks/${hook.id}/executions?limit=20`, { token });
  executionSummaries[hook.name] = {
    count: payload.executions?.length || 0,
    latestStatus: payload.executions?.[0]?.status || null,
  };
}

console.log(JSON.stringify({
  modelTurnCompleted: true,
  markerSeenInConversation,
  notificationSkill: {
    executed: lastNotification.executed,
    recordPath: notificationPath,
    recordCount: notifications.length,
  },
  sqlMetrics: sqlRecord.data,
  http200Recovery: {
    scheduled: true,
    sameSessionId: recovery.event.session_id,
    displayCommand: recovery.displayCommand.replace(/details=.*/, 'details=[verified HTTP 200 payload]'),
  },
  hookExecutions: executionSummaries,
}, null, 2));
