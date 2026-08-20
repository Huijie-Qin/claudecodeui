import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UPDATE_BASE_URL } from '../shared/runtime-config';

const INITIAL_UPDATE_DELAY = 30_000;
const UPDATE_INTERVAL = 6 * 60 * 60 * 1_000;
export const UPDATE_RESTART_CONFIRMATION_TIMEOUT_MS = 2_000;

interface BeforeQuitConfirmation {
  promise: Promise<boolean>;
  cancel(): void;
}

function waitForBeforeQuit(timeoutMs: number): BeforeQuitConfirmation {
  let settled = false;
  let settlePromise: (confirmed: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => {
    settlePromise = resolve;
  });
  const finish = (confirmed: boolean): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    app.removeListener('before-quit', handleBeforeQuit);
    settlePromise(confirmed);
  };
  const handleBeforeQuit = (): void => finish(true);
  const timeout = setTimeout(() => finish(false), timeoutMs);
  timeout.unref();
  app.once('before-quit', handleBeforeQuit);

  return {
    promise,
    cancel: () => finish(false),
  };
}

export class DesktopUpdater {
  private manualCheck = false;
  private checking = false;
  private started = false;

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly prepareForRestart: () => Promise<void> = async () => undefined,
    private readonly recoverFromFailedRestart: () => Promise<void> = async () => undefined,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!app.isPackaged) {
      return;
    }

    const platform = process.platform === 'darwin' ? 'mac' : 'win';
    const arch = process.platform === 'darwin' ? 'universal' : 'x64';
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${UPDATE_BASE_URL}/latest/${platform}/${arch}`,
      channel: 'latest',
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.channel = 'latest';
    // electron-updater's channel setter enables downgrades, so reset this after it.
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('update-not-available', () => {
      if (this.manualCheck) {
        this.manualCheck = false;
        void this.showMessage('已是最新版本', '当前已安装最新的 CloudCLI 桌面版。');
      }
    });
    autoUpdater.on('error', (error) => {
      console.error('[desktop] Update check failed.', error);
      if (this.manualCheck) {
        this.manualCheck = false;
        void this.showMessage('检查更新失败', '暂时无法检查更新，请稍后重试。', 'warning');
      }
    });
    autoUpdater.on('update-downloaded', () => {
      this.manualCheck = false;
      void this.promptForRestart();
    });

    const initialTimer = setTimeout(() => {
      void this.check(false);
    }, INITIAL_UPDATE_DELAY);
    initialTimer.unref();
    const interval = setInterval(() => {
      void this.check(false);
    }, UPDATE_INTERVAL);
    interval.unref();
  }

  async check(manual = true): Promise<void> {
    if (!app.isPackaged) {
      if (manual) {
        await this.showMessage('开发模式', '自动更新只在已安装的正式版本中启用。');
      }
      return;
    }

    if (this.checking) {
      this.manualCheck ||= manual;
      return;
    }

    this.checking = true;
    this.manualCheck ||= manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error('[desktop] Update check failed.', error);
      const shouldNotify = this.manualCheck;
      this.manualCheck = false;
      if (shouldNotify) {
        await this.showMessage('检查更新失败', '暂时无法检查更新，请稍后重试。', 'warning');
      }
    } finally {
      this.checking = false;
    }
  }

  quitAndInstall(): void {
    // restartAndInstall registers the before-quit confirmation first and owns
    // lifecycle recovery if this call throws or never begins application exit.
    autoUpdater.quitAndInstall(false, true);
  }

  async restartAndInstall(): Promise<boolean> {
    try {
      await this.prepareForRestart();
    } catch (error) {
      console.error('[desktop] Failed to prepare for update restart.', error);
      await this.recoverAndReportFailedRestart();
      return false;
    }

    // Subscribe before invoking electron-updater because before-quit may be
    // emitted synchronously by a platform implementation.
    const confirmation = waitForBeforeQuit(UPDATE_RESTART_CONFIRMATION_TIMEOUT_MS);
    try {
      this.quitAndInstall();
    } catch (error) {
      confirmation.cancel();
      console.error('[desktop] Failed to launch the downloaded update.', error);
      await this.recoverAndReportFailedRestart();
      return false;
    }

    if (await confirmation.promise) {
      return true;
    }

    console.error('[desktop] Downloaded update did not begin quitting in time.');
    await this.recoverAndReportFailedRestart();
    return false;
  }

  private async promptForRestart(): Promise<void> {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'CloudCLI 更新已就绪',
      message: '新版本已下载完成',
      detail: '立即重启会先停止接收新请求，并等待本机正在运行的任务完成；最长等待 30 分钟。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      await this.restartAndInstall();
    }
  }

  private async recoverAndReportFailedRestart(): Promise<void> {
    let recovered = false;
    try {
      await this.recoverFromFailedRestart();
      recovered = true;
    } catch (error) {
      console.error('[desktop] Failed to restore the local backend after update failure.', error);
    }

    await this.showMessage(
      '更新重启失败',
      recovered
        ? '安装器未能启动，本地 CloudCLI 服务已恢复。请稍后重试更新。'
        : '安装器未能启动，并且本地 CloudCLI 服务恢复失败。请查看日志后重试。',
      'warning',
    );
  }

  private async showMessage(
    title: string,
    message: string,
    type: Electron.MessageBoxOptions['type'] = 'info',
  ): Promise<void> {
    const options: Electron.MessageBoxOptions = {
      type,
      title,
      message,
      buttons: ['确定'],
      noLink: true,
    };
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }
}
