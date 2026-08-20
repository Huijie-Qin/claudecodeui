import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error('CloudCLI Desktop supports only macOS and Windows.');
}

const bridge: CloudCliDesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  appVersion: __DESKTOP_APP_VERSION__,
  async getBootstrapSession(): Promise<CloudCliDesktopBootstrapSession | null> {
    const session = await ipcRenderer.invoke(IPC_CHANNELS.getBootstrapSession) as unknown;
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return null;
    }
    const candidate = session as Record<string, unknown>;
    const user = candidate.user;
    if (
      typeof candidate.token !== 'string'
      || !candidate.token
      || !user
      || typeof user !== 'object'
      || Array.isArray(user)
      || typeof (user as Record<string, unknown>).username !== 'string'
    ) {
      return null;
    }
    return Object.freeze({
      user: Object.freeze({ ...(user as CloudCliDesktopBootstrapUser) }),
      token: candidate.token,
    });
  },
  async getBackendStatus(): Promise<CloudCliDesktopBackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.getBackendStatus) as Promise<CloudCliDesktopBackendStatus>;
  },
  async retryBackend(): Promise<CloudCliDesktopBackendStatus> {
    return ipcRenderer.invoke(IPC_CHANNELS.retryBackend) as Promise<CloudCliDesktopBackendStatus>;
  },
  async openBackendLogs(): Promise<void> {
    await ipcRenderer.invoke(IPC_CHANNELS.openBackendLogs);
  },
  async showNotification(input: CloudCliDesktopNotificationInput): Promise<boolean> {
    const result = await ipcRenderer.invoke(IPC_CHANNELS.showNotification, input);
    return result === true;
  },
  onNotificationActivated(
    listener: (input: CloudCliDesktopNotificationActivation) => void,
  ): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Notification activation listener must be a function.');
    }

    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      input: unknown,
    ): void => {
      const candidate = input && typeof input === 'object'
        ? input as Record<string, unknown>
        : {};
      const activation: CloudCliDesktopNotificationActivation = {};
      if (typeof candidate.sessionId === 'string') {
        activation.sessionId = candidate.sessionId;
      }
      listener(Object.freeze(activation));
    };
    ipcRenderer.on(IPC_CHANNELS.notificationActivated, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notificationActivated, wrappedListener);
    };
  },
});

contextBridge.exposeInMainWorld('cloudcliDesktop', bridge);
