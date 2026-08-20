import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopBackendController,
  persistBackendPort,
  readPersistedBackendPort,
  selectBackendPort,
  type BackendProcess,
} from '../src/main/backend-controller';

class TestBackendProcess extends EventEmitter implements BackendProcess {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

const runtimePaths = {
  runtimeRoot: '/runtime',
  backendEntry: '/runtime/dist-server/server/index.js',
  claudeCli: '/runtime/claude/darwin-arm64/claude',
  nodeExecutable: '/runtime/node/darwin-arm64/node',
  npmCli: '/runtime/node/darwin-arm64/npm/bin/npm-cli.js',
};

describe('desktop backend controller', () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'cloudcli-backend-controller-'));
  });

  afterEach(async () => {
    await rm(stateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
    vi.restoreAllMocks();
  });

  it('persists valid ports and falls back when the preferred port is occupied', async () => {
    await persistBackendPort(stateDirectory, 42111);
    expect(await readPersistedBackendPort(stateDirectory)).toBe(42111);
    expect(JSON.parse(await readFile(
      join(stateDirectory, 'desktop-backend-port.json'),
      'utf8',
    ))).toEqual({ port: 42111 });

    const allocate = vi.fn(async () => 43222);
    await expect(selectBackendPort({
      persistedPort: 42111,
      isAvailable: async () => false,
      allocate,
    })).resolves.toBe(43222);
    expect(allocate).toHaveBeenCalledOnce();
  });

  it('does not resolve startup or cache a session from a valid ready message', async () => {
    const child = new TestBackendProcess();
    const forkProcess = vi.fn(() => child);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
      environment: { PATH: '/usr/bin' },
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledOnce());
    expect(controller.getStatus().state).toBe('starting');

    child.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: { user: { username: 'desktop-admin' }, token: 'token-1' },
    });

    await expect(startup).resolves.toMatchObject({
      type: 'ready',
      origin: 'http://127.0.0.1:3001',
      session: null,
    });
    await vi.waitFor(async () => {
      expect(await readPersistedBackendPort(stateDirectory)).toBe(3001);
    });
  });

  it('requests a freshly signed bootstrap session for every renderer bootstrap', async () => {
    const child = new TestBackendProcess();
    const forkProcess = vi.fn(() => child);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledOnce());
    child.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: null,
    });
    await startup;

    const first = controller.requestBootstrapSession();
    const firstRequest = child.postMessage.mock.calls.at(-1)?.[0] as {
      type: string;
      requestId: string;
    };
    expect(firstRequest).toMatchObject({ type: 'bootstrap-session-request' });
    child.emit('message', {
      type: 'bootstrap-session-result',
      requestId: firstRequest.requestId,
      session: {
        user: { id: 1, username: 'desktop-admin' },
        token: 'fresh-token-1',
      },
    });
    await expect(first).resolves.toMatchObject({ token: 'fresh-token-1' });

    const second = controller.requestBootstrapSession();
    const secondRequest = child.postMessage.mock.calls.at(-1)?.[0] as {
      type: string;
      requestId: string;
    };
    expect(secondRequest.requestId).not.toBe(firstRequest.requestId);
    child.emit('message', {
      type: 'bootstrap-session-result',
      requestId: secondRequest.requestId,
      session: {
        user: { id: 1, username: 'desktop-admin' },
        token: 'fresh-token-2',
      },
    });
    await expect(second).resolves.toMatchObject({ token: 'fresh-token-2' });
  });

  it('cleans up bootstrap requests on timeout and process exit', async () => {
    const child = new TestBackendProcess();
    const forkProcess = vi.fn(() => child);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
      bootstrapSessionTimeoutMs: 5,
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledOnce());
    child.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: null,
    });
    await startup;

    await expect(controller.requestBootstrapSession()).rejects.toMatchObject({
      code: 'BOOTSTRAP_SESSION_TIMEOUT',
    });

    const pending = controller.requestBootstrapSession();
    child.emit('exit', 7);
    await expect(pending).rejects.toMatchObject({ code: 'BACKEND_EXITED' });
  });

  it('retries EADDRINUSE on a fresh port and records a second failure', async () => {
    const first = new TestBackendProcess();
    const second = new TestBackendProcess();
    const forkProcess = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
      allocatePort: async () => 45999,
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledTimes(1));
    first.emit('message', {
      type: 'startup-error',
      code: 'EADDRINUSE',
      message: 'Port is already in use.',
    });
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledTimes(2));
    expect(forkProcess.mock.calls[1][1].env?.SERVER_PORT).toBe('45999');

    second.emit('message', {
      type: 'startup-error',
      code: 'DATABASE_FAILED',
      message: 'Database initialization failed.',
    });
    await expect(startup).rejects.toMatchObject({ code: 'DATABASE_FAILED' });
    expect(controller.getStatus()).toEqual({
      state: 'error',
      code: 'DATABASE_FAILED',
      message: 'Database initialization failed.',
    });
  });

  it('surfaces runtime preflight failures as startup errors', async () => {
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      isPortAvailable: async () => true,
    });

    await expect(controller.start()).rejects.toMatchObject({
      code: 'BACKEND_START_FAILED',
    });
    expect(controller.getStatus()).toMatchObject({
      state: 'error',
      code: 'BACKEND_START_FAILED',
    });
    const log = await readFile(controller.getLogPath(), 'utf8');
    expect(log).toContain('Running desktop backend preflight');
    expect(log).toContain('Startup failed [BACKEND_START_FAILED]');
    expect(log).toContain('/runtime');
  });

  it('cancels an in-flight startup before retrying with a new process', async () => {
    const first = new TestBackendProcess();
    const second = new TestBackendProcess();
    first.kill.mockImplementation(() => {
      queueMicrotask(() => first.emit('exit', 0));
      return true;
    });
    const forkProcess = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
    });

    const initialStartup = controller.start();
    const cancelledStartup = initialStartup.catch((error: unknown) => error);
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledTimes(1));
    const restarted = controller.restart();
    await expect(cancelledStartup).resolves.toMatchObject({
      code: 'BACKEND_START_CANCELLED',
    });
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledTimes(2));
    second.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: { user: { username: 'desktop-admin' }, token: 'token-retry' },
    });
    await expect(restarted).resolves.toMatchObject({
      origin: 'http://127.0.0.1:3001',
    });
    await vi.waitFor(async () => {
      expect(await readPersistedBackendPort(stateDirectory)).toBe(3001);
    });
  });

  it('reports runtime crashes and waits for graceful shutdown acknowledgement', async () => {
    const child = new TestBackendProcess();
    const forkProcess = vi.fn(() => child);
    const controller = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
    });

    const startup = controller.start();
    await vi.waitFor(() => expect(forkProcess).toHaveBeenCalledOnce());
    child.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: { user: { username: 'desktop-admin' }, token: 'token-1' },
    });
    await startup;
    await vi.waitFor(async () => {
      expect(await readPersistedBackendPort(stateDirectory)).toBe(3001);
    });

    const stopping = controller.stop();
    await vi.waitFor(() => {
      expect(child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    });
    expect(controller.getStatus().state).toBe('stopping');
    child.emit('exit', 0);
    await stopping;
    expect(controller.getStatus()).toEqual({ state: 'stopped' });

    const crashedChild = new TestBackendProcess();
    const crashedForkProcess = vi.fn(() => crashedChild);
    const crashedController = new DesktopBackendController({
      utilityEntry: '/app/backend-entry.js',
      runtimePaths,
      stateDirectory,
      forkProcess: crashedForkProcess,
      assertRuntime: () => undefined,
      isPortAvailable: async () => true,
    });
    const crashedStartup = crashedController.start();
    await vi.waitFor(() => expect(crashedForkProcess).toHaveBeenCalledOnce());
    crashedChild.emit('message', {
      type: 'ready',
      port: 3001,
      origin: 'http://127.0.0.1:3001',
      session: { user: { username: 'desktop-admin' }, token: 'token-2' },
    });
    await crashedStartup;
    await vi.waitFor(async () => {
      expect(await readPersistedBackendPort(stateDirectory)).toBe(3001);
    });
    crashedChild.emit('exit', 7);
    expect(crashedController.getStatus()).toEqual({
      state: 'error',
      code: 'BACKEND_CRASHED',
      message: '本地 CloudCLI 服务意外退出（退出码 7）。',
    });
  });
});
