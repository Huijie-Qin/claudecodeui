declare const __DESKTOP_HOME_URL__: string;
declare const __DESKTOP_UPDATE_BASE_URL__: string;
declare const __DESKTOP_ALLOWED_ORIGINS__: string[];
declare const __DESKTOP_AUTH_ORIGINS__: string[];
declare const __DESKTOP_ALLOW_INSECURE_HTTP__: boolean;
declare const __DESKTOP_APP_VERSION__: string;

interface CloudCliDesktopNotificationInput {
  tag: string;
  title: string;
  body: string;
  sessionId?: string;
}

interface CloudCliDesktopNotificationActivation {
  sessionId?: string;
}

interface CloudCliDesktopBridge {
  readonly isDesktop: true;
  readonly platform: 'darwin' | 'win32';
  readonly appVersion: string;
  retryConnection(): void;
  showNotification(input: CloudCliDesktopNotificationInput): Promise<boolean>;
  onNotificationActivated(
    listener: (input: CloudCliDesktopNotificationActivation) => void,
  ): () => void;
}

interface Window {
  readonly cloudcliDesktop: CloudCliDesktopBridge;
}
