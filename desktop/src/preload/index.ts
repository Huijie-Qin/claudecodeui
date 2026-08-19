import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error('CloudCLI Desktop supports only macOS and Windows.');
}

const bridge: CloudCliDesktopBridge = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  appVersion: __DESKTOP_APP_VERSION__,
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
