import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Set<(...args: unknown[]) => void>();
  const app = {
    isPackaged: true,
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'before-quit') {
        listeners.add(listener);
      }
      return app;
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'before-quit') {
        listeners.delete(listener);
      }
      return app;
    }),
  };
  return {
    app,
    listeners,
    emitBeforeQuit: () => {
      for (const listener of [...listeners]) {
        listeners.delete(listener);
        listener({});
      }
    },
    showMessageBox: vi.fn(async () => ({ response: 0 })),
    quitAndInstall: vi.fn(),
    updaterOn: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: class {},
  dialog: { showMessageBox: mocks.showMessageBox },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: mocks.updaterOn,
    quitAndInstall: mocks.quitAndInstall,
  },
}));

vi.mock('../src/shared/runtime-config', () => ({
  UPDATE_BASE_URL: 'https://updates.example.test',
}));

import {
  DesktopUpdater,
  UPDATE_RESTART_CONFIRMATION_TIMEOUT_MS,
} from '../src/main/updater';

describe('desktop updater restart recovery', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.app.once.mockClear();
    mocks.app.removeListener.mockClear();
    mocks.showMessageBox.mockClear();
    mocks.quitAndInstall.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for backend preparation and confirms a real before-quit transition', async () => {
    let finishPreparation: (() => void) | undefined;
    const prepare = vi.fn(() => new Promise<void>((resolve) => {
      finishPreparation = resolve;
    }));
    const recover = vi.fn(async () => undefined);
    const updater = new DesktopUpdater(() => null, prepare, recover);

    const restarting = updater.restartAndInstall();
    await Promise.resolve();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();

    finishPreparation?.();
    await vi.waitFor(() => expect(mocks.quitAndInstall).toHaveBeenCalledOnce());
    expect(mocks.app.once).toHaveBeenCalledWith('before-quit', expect.any(Function));
    mocks.emitBeforeQuit();

    await expect(restarting).resolves.toBe(true);
    expect(recover).not.toHaveBeenCalled();
  });

  it('restores the application when quitAndInstall throws synchronously', async () => {
    const prepare = vi.fn(async () => undefined);
    const recover = vi.fn(async () => undefined);
    mocks.quitAndInstall.mockImplementation(() => {
      throw new Error('installer launch failed');
    });
    const updater = new DesktopUpdater(() => null, prepare, recover);

    await expect(updater.restartAndInstall()).resolves.toBe(false);

    expect(prepare).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'warning',
      title: '更新重启失败',
      message: expect.stringContaining('本地 CloudCLI 服务已恢复'),
    }));
  });

  it('restores the application when no before-quit event arrives', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(async () => undefined);
    const recover = vi.fn(async () => undefined);
    const updater = new DesktopUpdater(() => null, prepare, recover);

    const restarting = updater.restartAndInstall();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.quitAndInstall).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(UPDATE_RESTART_CONFIRMATION_TIMEOUT_MS);
    await expect(restarting).resolves.toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });
});
