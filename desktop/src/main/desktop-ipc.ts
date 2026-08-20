import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  DesktopBackendStatus,
  DesktopBootstrapSession,
} from '../shared/backend-protocol';
import type { DesktopBackendController } from './backend-controller';

interface DesktopIpcControllerOptions {
  backend: DesktopBackendController;
  isOfflineUrl: (url: string) => boolean;
}

export function isTrustedMainFrameSender(
  event: IpcMainInvokeEvent,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  const senderFrame = event.senderFrame;
  if (!senderFrame || senderFrame !== event.sender.mainFrame) {
    return false;
  }

  try {
    const parsed = new URL(senderFrame.url);
    return !parsed.username
      && !parsed.password
      && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export class DesktopIpcController {
  constructor(private readonly options: DesktopIpcControllerOptions) {}

  register(): void {
    ipcMain.handle(
      IPC_CHANNELS.getBootstrapSession,
      (event) => this.getBootstrapSession(event),
    );
    ipcMain.handle(
      IPC_CHANNELS.getBackendStatus,
      (event) => this.withTrustedShellSender(event, () => this.options.backend.getStatus()),
    );
    ipcMain.handle(
      IPC_CHANNELS.retryBackend,
      (event) => this.withTrustedShellSender(event, async () => {
        try {
          await this.options.backend.restart();
        } catch {
          // The controller status carries the sanitized startup failure for the page.
        }
        return this.options.backend.getStatus();
      }),
    );
    ipcMain.handle(
      IPC_CHANNELS.openBackendLogs,
      (event) => this.withTrustedShellSender(event, () => {
        shell.showItemInFolder(this.options.backend.getLogPath());
      }),
    );
  }

  dispose(): void {
    ipcMain.removeHandler(IPC_CHANNELS.getBootstrapSession);
    ipcMain.removeHandler(IPC_CHANNELS.getBackendStatus);
    ipcMain.removeHandler(IPC_CHANNELS.retryBackend);
    ipcMain.removeHandler(IPC_CHANNELS.openBackendLogs);
  }

  private async getBootstrapSession(
    event: IpcMainInvokeEvent,
  ): Promise<DesktopBootstrapSession | null> {
    const origin = this.options.backend.getOrigin();
    if (!origin || !isTrustedMainFrameSender(event, new Set([origin]))) {
      return null;
    }
    return this.options.backend.requestBootstrapSession();
  }

  private withTrustedShellSender<T>(
    event: IpcMainInvokeEvent,
    action: () => T,
  ): T | DesktopBackendStatus {
    const senderUrl = event.senderFrame?.url ?? '';
    const origin = this.options.backend.getOrigin();
    const trustedBackend = Boolean(
      origin && isTrustedMainFrameSender(event, new Set([origin])),
    );
    const trustedOfflinePage = event.senderFrame === event.sender.mainFrame
      && this.options.isOfflineUrl(senderUrl);
    if (!trustedBackend && !trustedOfflinePage) {
      return {
        state: 'error',
        code: 'UNTRUSTED_IPC_SENDER',
        message: 'Desktop request rejected.',
      };
    }
    return action();
  }
}
