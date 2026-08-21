export {};

declare global {
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
    showNotification(input: CloudCliDesktopNotificationInput): Promise<boolean>;
    onNotificationActivated(
      listener: (input: CloudCliDesktopNotificationActivation) => void,
    ): () => void;
  }

  interface Window {
    __ROUTER_BASENAME__?: string;
    cloudcliDesktop?: CloudCliDesktopBridge;
    refreshProjects?: () => void | Promise<void>;
    openSettings?: (tab?: string) => void;
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
