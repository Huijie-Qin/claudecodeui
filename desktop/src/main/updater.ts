import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { UPDATE_BASE_URL } from '../shared/runtime-config';

const INITIAL_UPDATE_DELAY = 30_000;
const UPDATE_INTERVAL = 6 * 60 * 60 * 1_000;

export class DesktopUpdater {
  private manualCheck = false;
  private checking = false;
  private started = false;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

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
    // Electron emits before-quit when the updater actually starts quitting. Do not
    // mark the shell as quitting before that point: a failed installer launch must
    // leave the tray/window lifecycle usable.
    autoUpdater.quitAndInstall(false, true);
  }

  private async promptForRestart(): Promise<void> {
    const options: Electron.MessageBoxOptions = {
      type: 'info',
      title: 'CloudCLI 更新已就绪',
      message: '新版本已下载完成',
      detail: '立即重启以完成安装，或稍后在退出 CloudCLI 时自动安装。云端任务不会停止。',
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
      this.quitAndInstall();
    }
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
