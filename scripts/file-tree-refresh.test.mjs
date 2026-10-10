import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

// Exercise the actual data hook and local event bus with delayed transport.
let latestMessage;
let showInternalConfigFiles;
let requests;
mock.module(new URL('../src/utils/api.js', import.meta.url).href, {
  namedExports: { api: { getFiles: (name, options, workspaceId, showInternal) => new Promise((resolve, reject) => {
    requests.push({ name, workspaceId, showInternal, signal: options.signal, resolve, reject });
  }) } },
});
mock.module(new URL('../src/contexts/WebSocketContext.tsx', import.meta.url).href, {
  namedExports: { useWebSocket: () => ({ latestMessage }) },
});
mock.module(new URL('../src/hooks/useUiPreferences.ts', import.meta.url).href, {
  namedExports: { useUiPreferences: () => ({ preferences: { showInternalConfigFiles } }) },
});
const { useFileTreeData } = await import('../src/components/file-tree/hooks/useFileTreeData.ts');
const { dispatchProjectFilesChanged } = await import('../src/components/file-tree/utils/fileTreeEvents.ts');
const project = { name: 'workspace', workspaceId: 10, tenantId: 1 };
const files = [{ name: 'existing.txt', path: '/workspace/existing.txt', type: 'file', size: 10 }];
const response = (value) => ({ ok: true, json: async () => value });

beforeEach(() => {
  latestMessage = null;
  showInternalConfigFiles = false;
  requests = [];
});

async function mount(t) {
  let selected = project;
  let state;
  const frames = [];
  function Probe() {
    state = useFileTreeData(selected);
    frames.push(state);
    return null;
  }
  let renderer;
  await act(async () => { renderer = create(createElement(Probe)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return {
    get state() { return state; }, frames,
    update: (next = selected) => act(async () => { selected = next; renderer.update(createElement(Probe)); }),
    complete: (index, value) => act(async () => requests[index].resolve(response(value))),
    push: async (message) => {
      latestMessage = message;
      await act(async () => renderer.update(createElement(Probe)));
    },
  };
}

test('file notifications keep the loaded list and upload controls available during refresh', async (t) => {
  const app = await mount(t);
  assert.equal(app.state.initialLoading, true);
  await app.complete(0, files);
  await app.push({ type: 'files_changed', ...project });
  assert.equal(requests.length, 2);
  assert.equal(app.state.loading, true);
  assert.equal(app.state.initialLoading, false);
  assert.equal(app.state.files, files);
  const updated = [...files, { name: 'uploaded.txt', path: '/workspace/uploaded.txt', type: 'file' }];
  await app.complete(1, updated);
  assert.equal(app.state.loading, false);
  assert.equal(app.state.files, updated);
});

test('an empty loaded directory also refreshes without replacing the upload area', async (t) => {
  const app = await mount(t);
  await app.complete(0, []);
  await act(async () => dispatchProjectFilesChanged({ projectName: project.name, workspaceId: 10, reason: 'upload' }));
  assert.equal(app.state.loading, true);
  assert.equal(app.state.initialLoading, false);
  assert.deepEqual(app.state.files, []);
  await app.complete(1, files);
  assert.equal(app.state.files, files);
});

test('a refresh failure preserves the existing list and supports retry', async (t) => {
  const app = await mount(t);
  await app.complete(0, files);
  t.mock.method(console, 'error', () => {});
  await act(async () => app.state.refreshFiles());
  await act(async () => requests[1].resolve({ ok: false, status: 503, text: async () => 'Unavailable' }));
  assert.match(app.state.error, /503/);
  assert.equal(app.state.initialLoading, false);
  assert.equal(app.state.files, files);
  await act(async () => app.state.refreshFiles());
  assert.equal(app.state.initialLoading, false);
  await app.complete(2, files);
  assert.equal(app.state.error, null);
});

test('switching workspaces immediately hides old files and ignores late responses', async (t) => {
  const app = await mount(t);
  await app.complete(0, files);
  await act(async () => app.state.refreshFiles());
  app.frames.length = 0;
  await app.update({ ...project, workspaceId: 20 });
  assert.equal(requests[1].signal.aborted, true);
  assert.ok(app.frames.every(frame => frame.files.length === 0 && frame.initialLoading));
  await app.complete(1, files);
  assert.deepEqual(app.state.files, []);
  assert.equal(app.state.initialLoading, true);
  await app.complete(2, []);
  assert.equal(app.state.loading, false);
  await app.update(null);
  assert.deepEqual(app.state.files, []);
  assert.equal(app.state.loading, false);
});

test('tenant changes cannot reuse a previous tenant file snapshot', async (t) => {
  const app = await mount(t);
  await app.complete(0, files);
  await app.update({ ...project, tenantId: 2 });
  assert.equal(app.state.initialLoading, true);
  assert.deepEqual(app.state.files, []);
  assert.equal(requests.length, 2);
});

test('metadata updates and unrelated file notifications do not refetch files', async (t) => {
  const app = await mount(t);
  await app.complete(0, files);
  await app.update({ ...project, displayName: 'Renamed', sessions: [] });
  await app.push({ type: 'projects_updated', projects: [] });
  await app.push({ type: 'files_changed', projectName: 'other', workspaceId: 10 });
  await app.push({ type: 'files_changed', projectName: project.name, workspaceId: 20 });
  await act(async () => dispatchProjectFilesChanged({ projectName: project.name, workspaceId: 20 }));
  assert.equal(requests.length, 1);
  assert.equal(app.state.files, files);
});

test('preference changes refresh in place and retain the requested visibility setting', async (t) => {
  const app = await mount(t);
  await app.complete(0, files);
  showInternalConfigFiles = true;
  await app.update();
  assert.equal(requests[1].showInternal, true);
  assert.equal(app.state.initialLoading, false);
  assert.equal(app.state.files, files);
});
