export const IPC_CHANNELS = {
  getBootstrapSession: 'cloudcli-desktop:get-bootstrap-session',
  getBackendStatus: 'cloudcli-desktop:get-backend-status',
  retryBackend: 'cloudcli-desktop:retry-backend',
  openBackendLogs: 'cloudcli-desktop:open-backend-logs',
  showNotification: 'cloudcli-desktop:show-notification',
  notificationActivated: 'cloudcli-desktop:notification-activated',
} as const;
