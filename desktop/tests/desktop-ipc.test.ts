import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle.mockImplementation(
      (channel: string, handler: (...args: never[]) => unknown) => {
        mocks.handlers.set(channel, handler);
      },
    ),
    removeHandler: mocks.removeHandler,
  },
  shell: { showItemInFolder: mocks.showItemInFolder },
}));

import { DesktopIpcController } from '../src/main/desktop-ipc';

function event(url: string, isMainFrame = true): never {
  const mainFrame = { url };
  return {
    senderFrame: isMainFrame ? mainFrame : { url },
    sender: { mainFrame },
  } as never;
}

describe('desktop private IPC', () => {
  const backend = {
    getOrigin: vi.fn(() => 'http://127.0.0.1:43123'),
    requestBootstrapSession: vi.fn(async () => ({
      user: { username: 'desktop-admin' },
      token: 'bootstrap-token',
    })),
    getStatus: vi.fn(() => ({
      state: 'error',
      code: 'BACKEND_CRASHED',
      message: 'Local backend crashed.',
    })),
    getLogPath: vi.fn(() => '/state/logs/desktop-backend.log'),
    restart: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.handle.mockClear();
    mocks.removeHandler.mockClear();
    mocks.showItemInFolder.mockClear();
    backend.getOrigin.mockClear();
    backend.requestBootstrapSession.mockClear();
    backend.getStatus.mockClear();
    backend.getLogPath.mockClear();
    backend.restart.mockClear();
  });

  it('requests a fresh bootstrap secret only for the current backend main frame', async () => {
    const controller = new DesktopIpcController({
      backend: backend as never,
      isOfflineUrl: (url) => url === 'cloudcli-offline://app/',
    });
    controller.register();
    const handler = mocks.handlers.get('cloudcli-desktop:get-bootstrap-session');

    await expect(handler?.(event('http://127.0.0.1:43123/'))).resolves.toEqual({
      user: { username: 'desktop-admin' },
      token: 'bootstrap-token',
    });
    await expect(handler?.(event('http://127.0.0.1:43124/'))).resolves.toBeNull();
    await expect(handler?.(event('http://127.0.0.1:43123/', false))).resolves.toBeNull();
    await expect(handler?.(event('https://127.0.0.1:43123/'))).resolves.toBeNull();
    expect(backend.requestBootstrapSession).toHaveBeenCalledOnce();
  });

  it('allows crash recovery actions from the fixed offline renderer only', async () => {
    const controller = new DesktopIpcController({
      backend: backend as never,
      isOfflineUrl: (url) => url === 'cloudcli-offline://app/',
    });
    controller.register();

    const retry = mocks.handlers.get('cloudcli-desktop:retry-backend');
    const openLogs = mocks.handlers.get('cloudcli-desktop:open-backend-logs');
    await retry?.(event('cloudcli-offline://app/'));
    expect(backend.restart).toHaveBeenCalledOnce();
    await openLogs?.(event('cloudcli-offline://app/'));
    expect(mocks.showItemInFolder).toHaveBeenCalledWith('/state/logs/desktop-backend.log');

    const rejected = await retry?.(event('https://evil.example/'));
    expect(rejected).toMatchObject({
      state: 'error',
      code: 'UNTRUSTED_IPC_SENDER',
    });
    expect(backend.restart).toHaveBeenCalledOnce();
  });
});
