import {
  BrowserWindow,
  ipcMain,
  Notification,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  NotificationRateLimiter,
  isTrustedNotificationSender,
  validateNotificationInput,
  type ValidatedNotificationInput,
} from '../shared/notifications';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { ALLOWED_ORIGINS } from '../shared/runtime-config';

const NOTIFICATION_SHOW_TIMEOUT_MS = 5_000;
const NOTIFICATION_REFERENCE_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_NOTIFICATIONS = 64;

interface ActiveNotification {
  notification: Notification;
  dispose(closeNotification: boolean): void;
}

export class DesktopNotificationController {
  private readonly limiter = new NotificationRateLimiter();
  private readonly activeNotifications = new Map<string, ActiveNotification>();

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  register(): void {
    ipcMain.handle(
      IPC_CHANNELS.showNotification,
      (event, input: unknown) => this.showFromRenderer(event, input),
    );
  }

  dispose(): void {
    ipcMain.removeHandler(IPC_CHANNELS.showNotification);
    for (const activeNotification of [...this.activeNotifications.values()]) {
      activeNotification.dispose(true);
    }
    this.activeNotifications.clear();
  }

  private isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const senderFrame = event.senderFrame;
    if (!senderFrame || senderFrame !== event.sender.mainFrame) {
      return false;
    }
    return isTrustedNotificationSender(senderFrame.url, true, ALLOWED_ORIGINS);
  }

  private async showFromRenderer(
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<boolean> {
    if (!this.isTrustedSender(event) || !Notification.isSupported()) {
      return false;
    }

    let notificationInput: ValidatedNotificationInput;
    try {
      notificationInput = validateNotificationInput(input);
    } catch (error) {
      console.warn('[desktop] Rejected invalid notification payload.', error);
      return false;
    }

    if (!this.limiter.allow(notificationInput.tag)) {
      console.warn('[desktop] Notification rate limit reached.');
      return false;
    }

    let notification: Notification;
    try {
      notification = new Notification({
        id: notificationInput.tag,
        title: notificationInput.title,
        body: notificationInput.body,
        silent: false,
      });
    } catch (error) {
      console.warn('[desktop] Failed to create native notification.', error);
      return false;
    }

    this.activeNotifications.get(notificationInput.tag)?.dispose(true);
    while (this.activeNotifications.size >= MAX_ACTIVE_NOTIFICATIONS) {
      const oldestNotification = this.activeNotifications.values().next().value;
      if (!oldestNotification) {
        break;
      }
      oldestNotification.dispose(true);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let disposed = false;
      let showTimeout: ReturnType<typeof setTimeout> | undefined;
      let referenceTtl: ReturnType<typeof setTimeout> | undefined;

      const settle = (shown: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (showTimeout) {
          clearTimeout(showTimeout);
          showTimeout = undefined;
        }
        resolve(shown);
      };

      const dispose = (closeNotification: boolean): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        settle(false);
        if (showTimeout) {
          clearTimeout(showTimeout);
          showTimeout = undefined;
        }
        if (referenceTtl) {
          clearTimeout(referenceTtl);
          referenceTtl = undefined;
        }
        notification.removeListener('show', handleShow);
        notification.removeListener('failed', handleFailed);
        notification.removeListener('click', handleClick);
        notification.removeListener('close', handleClose);

        const activeNotification = this.activeNotifications.get(notificationInput.tag);
        if (activeNotification?.notification === notification) {
          this.activeNotifications.delete(notificationInput.tag);
        }

        if (closeNotification) {
          try {
            notification.close();
          } catch (error) {
            console.warn('[desktop] Failed to close native notification.', error);
          }
        }
      };

      const handleShow = (): void => {
        settle(true);
      };
      const handleFailed = (_event: Electron.Event, error: string): void => {
        console.warn('[desktop] Native notification failed to show.', error);
        dispose(false);
      };
      const handleClick = (): void => {
        settle(true);
        dispose(false);

        const mainWindow = this.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          return;
        }
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send(IPC_CHANNELS.notificationActivated, {
          ...(notificationInput.sessionId ? { sessionId: notificationInput.sessionId } : {}),
        });
      };
      const handleClose = (): void => {
        dispose(false);
      };

      notification.once('show', handleShow);
      notification.once('failed', handleFailed);
      notification.once('click', handleClick);
      notification.once('close', handleClose);

      showTimeout = setTimeout(() => {
        console.warn('[desktop] Timed out waiting for native notification to show.');
        dispose(true);
      }, NOTIFICATION_SHOW_TIMEOUT_MS);
      showTimeout.unref?.();
      referenceTtl = setTimeout(() => {
        dispose(true);
      }, NOTIFICATION_REFERENCE_TTL_MS);
      referenceTtl.unref?.();

      this.activeNotifications.set(notificationInput.tag, {
        notification,
        dispose,
      });

      try {
        notification.show();
      } catch (error) {
        console.warn('[desktop] Failed to show native notification.', error);
        dispose(true);
      }
    });
  }
}
