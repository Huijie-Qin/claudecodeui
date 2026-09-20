import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { createElement, useEffect, useState } from 'react';
import { act, create } from 'react-test-renderer';

// Exercise the actual provider and hooks; only auth and transport are stubbed.
const user = { id: 1 };
const tenant = { id: 1, code: 'one', name: 'One', permission: 'edit' };
const session = { id: 'session-1', __provider: 'claude' };
const project = {
  name: 'workspace', displayName: 'Workspace', fullPath: '/workspace',
  workspaceId: 10, tenantId: 1, sessions: [session],
};
const response = (value) => ({ ok: true, json: async () => structuredClone(value) });
let tenantPayload;
let projectPayload;
let projectRequests;
let tenantRequests;
const api = {
  tenants: {
    mine: async () => { tenantRequests += 1; return response({ tenants: tenantPayload }); },
    checkAgentList: async () => response({}),
  },
  projects: async () => { projectRequests += 1; return response(projectPayload); },
};
mock.module(new URL('../src/utils/api.js', import.meta.url).href, {
  namedExports: { api, authenticatedFetch: async () => response({}) },
});
mock.module(new URL('../src/components/auth/context/AuthContext.tsx', import.meta.url).href, {
  namedExports: { useAuth: () => ({ user }) },
});
const { TenantProvider, useTenant } = await import('../src/contexts/TenantContext.tsx');
const { useProjectsState } = await import('../src/hooks/useProjectsState.ts');
const { useChatSessionState } = await import('../src/components/chat/hooks/useChatSessionState.ts');

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

beforeEach(() => {
  globalThis.window = new EventTarget();
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  tenantPayload = [tenant];
  projectPayload = [project];
  projectRequests = 0;
  tenantRequests = 0;
});

async function mountProjects(t) {
  let state;
  let tenantState;
  let mounts = 0;
  let setDraft;
  const frames = [];
  const args = { sessionId: session.id, navigate: () => {}, latestMessage: null, isMobile: false, activeSessions: new Set() };
  function Editor() {
    const [draft, update] = useState('');
    setDraft = update;
    useEffect(() => { mounts += 1; }, []);
    return createElement('span', null, draft);
  }
  function Probe() {
    state = useProjectsState(args);
    tenantState = useTenant();
    frames.push({ loading: state.isLoadingProjects, project: state.selectedProject, session: state.selectedSession });
    return state.isLoadingProjects || !state.selectedProject ? null : createElement(Editor);
  }
  let renderer;
  await act(async () => { renderer = create(createElement(TenantProvider, null, createElement(Probe))); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return {
    get state() { return state; },
    get tenantState() { return tenantState; },
    get mounts() { return mounts; },
    get draft() { return renderer.toJSON()?.children?.[0]; },
    frames,
    setDraft: (value) => act(async () => setDraft(value)),
    focus: () => act(async () => window.dispatchEvent(new Event('focus'))),
    push: (value) => act(async () => {
      args.latestMessage = value;
      renderer.update(createElement(TenantProvider, null, createElement(Probe)));
    }),
  };
}

test('repeated window focus preserves selected project, session, tab and draft', async (t) => {
  const app = await mountProjects(t);
  await app.setDraft('unfinished message');
  await act(async () => app.state.setActiveTab('files'));
  const selectedProject = app.state.selectedProject;
  const selectedSession = app.state.selectedSession;
  const requests = projectRequests;
  const mounts = app.mounts;
  app.frames.length = 0;
  for (let i = 0; i < 3; i += 1) await app.focus();
  assert.equal(tenantRequests, 4, 'tenant permissions still refresh on focus');
  assert.equal(projectRequests, requests, 'focus must not reload projects');
  assert.equal(app.state.selectedProject, selectedProject);
  assert.equal(app.state.selectedSession, selectedSession);
  assert.equal(app.state.activeTab, 'files');
  assert.equal(app.mounts, mounts);
  assert.equal(app.draft, 'unfinished message');
  assert.ok(app.frames.every((frame) => !frame.loading && frame.project === selectedProject && frame.session === selectedSession));
});

test('permission updates stay live without resetting the current workspace', async (t) => {
  const app = await mountProjects(t);
  await app.setDraft('keep me');
  tenantPayload = [{ ...tenant, name: 'Renamed', permission: 'view', role: 'member' }];
  const requests = projectRequests;
  app.frames.length = 0;
  await app.focus();
  assert.equal(app.tenantState.currentTenant.permission, 'view');
  assert.equal(app.tenantState.currentTenant.name, 'Renamed');
  assert.equal(app.tenantState.currentTenant.role, 'member');
  assert.equal(projectRequests, requests);
  assert.equal(app.draft, 'keep me');
  assert.ok(app.frames.every((frame) => !frame.loading && frame.session?.id === session.id));
});

test('an actual tenant switch still clears selections and loads the new projects', async (t) => {
  const app = await mountProjects(t);
  const requests = projectRequests;
  projectPayload = [{ ...project, workspaceId: 20, tenantId: 2, sessions: [] }];
  app.frames.length = 0;
  await act(async () => app.tenantState.selectTenant({ ...tenant, id: 2 }));
  assert.equal(projectRequests, requests + 1);
  assert.ok(app.frames.some((frame) => frame.loading && !frame.project && !frame.session));
  assert.equal(app.state.projects[0].tenantId, 2);
  assert.equal(app.state.selectedSession, null);
});

test('revoked tenant access still clears the visible project and session', async (t) => {
  const app = await mountProjects(t);
  tenantPayload = [];
  await app.focus();
  assert.equal(app.tenantState.currentTenant, null);
  assert.deepEqual(app.state.projects, []);
  assert.equal(app.state.selectedProject, null);
  assert.equal(app.state.selectedSession, null);
});

test('background project pushes keep the workspace mounted and update its metadata', async (t) => {
  const app = await mountProjects(t);
  await app.setDraft('keep me');
  const mounts = app.mounts;
  app.frames.length = 0;
  await app.push({ type: 'projects_updated', tenantId: 1, projects: [{ ...project, displayName: 'Renamed project' }] });
  assert.equal(app.state.selectedProject.displayName, 'Renamed project');
  assert.equal(app.state.selectedSession.id, session.id);
  assert.equal(app.mounts, mounts);
  assert.equal(app.draft, 'keep me');
  assert.ok(app.frames.every((frame) => !frame.loading && frame.project && frame.session));
});

async function mountChat(t) {
  let state;
  const frames = [];
  const fetches = [];
  const refreshes = [];
  const slots = new Map();
  const messages = [{ id: 'msg-1', sessionId: session.id, provider: 'claude', kind: 'text', role: 'assistant', content: 'Existing history', timestamp: '2026-09-20T01:00:00Z' }];
  const store = {
    setActiveSession: () => {},
    getMessages: () => messages,
    getSessionSlot: (id) => slots.get(id),
    has: (id) => slots.has(id),
    isStale: () => true, // Reproduce a project push after the 30-second cache TTL.
    fetchFromServer: async (id, options) => {
      fetches.push({ id, options });
      const slot = { hasMore: true, total: 120, offset: 20 };
      slots.set(id, slot);
      return slot;
    },
    refreshFromServer: async (id, options) => { refreshes.push({ id, options }); },
  };
  let args = {
    selectedProject: project, selectedSession: session, ws: null,
    sendMessage: () => {}, autoScrollToBottom: false, externalMessageUpdate: 0,
    resetStreamingState: () => {}, pendingViewSessionRef: { current: null }, sessionStore: store,
  };
  function Probe() {
    state = useChatSessionState(args);
    frames.push({ loading: state.isLoadingSessionMessages, total: state.totalMessages });
    return null;
  }
  let renderer;
  await act(async () => { renderer = create(createElement(Probe)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return {
    get state() { return state; },
    frames, fetches, refreshes,
    update: (patch) => act(async () => { args = { ...args, ...patch }; renderer.update(createElement(Probe)); }),
  };
}

test('project/session metadata updates do not reload stale history or reset its viewport', async (t) => {
  const chat = await mountChat(t);
  await act(async () => chat.state.setIsUserScrolledUp(true));
  const messages = chat.state.chatMessages;
  chat.frames.length = 0;
  await chat.update({
    selectedProject: { ...project, displayName: 'Updated', sessions: [{ ...session, messageCount: 123 }] },
    selectedSession: { ...session, title: 'Updated title' },
  });
  assert.equal(chat.fetches.length, 1);
  assert.equal(chat.state.chatMessages, messages);
  assert.equal(chat.state.isUserScrolledUp, true);
  assert.equal(chat.state.hasMoreMessages, true);
  assert.ok(chat.frames.every((frame) => !frame.loading && frame.total === 120));
});

test('external history changes refresh silently once per update, not per project metadata render', async (t) => {
  const chat = await mountChat(t);
  chat.frames.length = 0;
  await chat.update({ externalMessageUpdate: 1 });
  assert.equal(chat.refreshes.length, 1);
  await chat.update({ selectedProject: { ...project, displayName: 'Updated' }, selectedSession: { ...session, title: 'Updated' } });
  assert.equal(chat.refreshes.length, 1);
  await chat.update({ externalMessageUpdate: 2 });
  assert.equal(chat.refreshes.length, 2);
  assert.equal(chat.fetches.length, 1);
  assert.ok(chat.frames.every((frame) => !frame.loading));
});

test('actual session, workspace and provider changes still load the requested history', async (t) => {
  const chat = await mountChat(t);
  await chat.update({ selectedSession: { ...session, id: 'session-2' } });
  assert.equal(chat.fetches.at(-1).id, 'session-2');
  await chat.update({ selectedProject: { ...project, workspaceId: 20 } });
  assert.equal(chat.fetches.at(-1).options.workspaceId, 20);
  await chat.update({ selectedSession: { id: 'session-2', __provider: 'codex' } });
  assert.equal(chat.fetches.at(-1).options.provider, 'codex');
  assert.equal(chat.fetches.length, 4);
});
