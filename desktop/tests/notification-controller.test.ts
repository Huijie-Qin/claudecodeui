import { EventEmitter } from 'node:events';

import type {
  BrowserWindow,
  NotificationConstructorOptions,
} from 'electron';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type ShowNotificationHandler = (
  event: unknown,
  input: unknown,
) => Promise<boolean>;

class TestNotification extends EventEmitter {
  static supported = true;
  static instances: TestNotification[] = [];

  static isSupported(): boolean {
    return TestNotification.supported;
  }

  readonly show = vi.fn();
  readonly close = vi.fn(() => {
    this.emit('close', {});
  });

  constructor(readonly options: NotificationConstructorOptions) {
    super();
    TestNotification.instances.push(this);
  }
}

let registeredHandler: ShowNotificationHandler | undefined;
const ipcMainMock = {
  handle: vi.fn((_channel: string, handler: ShowNotificationHandler) => {
    registeredHandler = handler;
  }),
  removeHandler: vi.fn(),
};

const mainWindow = {
  isDestroyed: vi.fn(() => false),
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: {
    send: vi.fn(),
  },
};

let DesktopNotificationController: typeof import(
  '../src/main/notification-controller'
).DesktopNotificationController;
let controller: InstanceType<typeof DesktopNotificationController>;

function activeNotificationCount(): number {
  return (controller as unknown as {
    activeNotifications: Map<string, unknown>;
  }).activeNotifications.size;
}

function showNotification(input: Record<string, unknown>): Promise<boolean> {
  if (!registeredHandler) {
    throw new Error('Notification IPC handler was not registered.');
  }
  return registeredHandler({}, input);
}

beforeAll(async () => {
  vi.doMock('electron', () => ({
    BrowserWindow: class {},
    ipcMain: ipcMainMock,
    Notification: TestNotification,
  }));
  ({ DesktopNotificationController } = await import(
    '../src/main/notification-controller'
  ));
});

afterAll(() => {
  vi.doUnmock('electron');
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  TestNotification.supported = true;
  TestNotification.instances = [];
  registeredHandler = undefined;
  ipcMainMock.handle.mockClear();
  ipcMainMock.removeHandler.mockClear();
  mainWindow.isDestroyed.mockClear();
  mainWindow.isMinimized.mockClear();
  mainWindow.restore.mockClear();
  mainWindow.show.mockClear();
  mainWindow.focus.mockClear();
  mainWindow.webContents.send.mockClear();
  controller = new DesktopNotificationController(
    () => mainWindow as unknown as BrowserWindow,
  );
  controller.register();
});

afterEach(() => {
  controller.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('desktop native notification lifecycle', () => {
  it('waits for show and passes the notification payload to Electron', async () => {
    const result = showNotification({
      tag: ' task-1 ',
      title: ' Task complete ',
      body: ' The response is ready. ',
      sessionId: 'session-1',
    });
    let resolved = false;
    void result.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0].options).toMatchObject({
      id: ' task-1 ',
      title: ' Task complete ',
      body: ' The response is ready. ',
    });

    TestNotification.instances[0].emit('show', {});
    await expect(result).resolves.toBe(true);
    expect(activeNotificationCount()).toBe(1);

    TestNotification.instances[0].emit('close', {});
    expect(activeNotificationCount()).toBe(0);
  });

  it('returns false and releases the notification when native display fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = showNotification({
      tag: 'failed-1',
      title: 'Task failed',
      body: 'Native notification failure.',
    });

    TestNotification.instances[0].emit('failed', {}, 'permission denied');
    await expect(result).resolves.toBe(false);
    expect(activeNotificationCount()).toBe(0);
  });

  it('times out an unconfirmed show and expires a shown notification by TTL', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const timedOut = showNotification({
      tag: 'timeout-1',
      title: 'Waiting',
      body: 'No native event will arrive.',
    });
    const timedOutNotification = TestNotification.instances[0];

    await vi.runOnlyPendingTimersAsync();
    await expect(timedOut).resolves.toBe(false);
    expect(timedOutNotification.close).toHaveBeenCalledOnce();
    expect(activeNotificationCount()).toBe(0);

    const shown = showNotification({
      tag: 'ttl-1',
      title: 'Shown',
      body: 'This reference will expire.',
    });
    const shownNotification = TestNotification.instances[1];
    shownNotification.emit('show', {});
    await expect(shown).resolves.toBe(true);

    await vi.runOnlyPendingTimersAsync();
    expect(shownNotification.close).toHaveBeenCalledOnce();
    expect(activeNotificationCount()).toBe(0);
  });

  it('releases clicked notifications and activates their session', async () => {
    const result = showNotification({
      tag: 'click-1',
      title: 'Needs attention',
      body: 'Open the session.',
      sessionId: 'session-123',
    });
    const notification = TestNotification.instances[0];
    notification.emit('show', {});
    await expect(result).resolves.toBe(true);

    notification.emit('click', {});
    expect(activeNotificationCount()).toBe(0);
    expect(mainWindow.show).toHaveBeenCalledOnce();
    expect(mainWindow.focus).toHaveBeenCalledOnce();
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'cloudcli-desktop:notification-activated',
      { sessionId: 'session-123' },
    );
  });
});
