const ALLOWED_WEB_PERMISSIONS = new Set([
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
]);

export interface SecureWebPreferences {
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  webviewTag: false;
  partition: string;
}

export function createSecureWebPreferences(partition: string): SecureWebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    partition,
  };
}

export function isAllowedWebPermission(
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
  allowedOrigins: ReadonlySet<string>,
  webContentsUrl?: string,
): boolean {
  if (!ALLOWED_WEB_PERMISSIONS.has(permission) || !isMainFrame) {
    return false;
  }

  try {
    const requesting = new URL(requestingUrl);
    if (requesting.username || requesting.password || !allowedOrigins.has(requesting.origin)) {
      return false;
    }
    if (!webContentsUrl) {
      return true;
    }
    const webContents = new URL(webContentsUrl);
    return !webContents.username
      && !webContents.password
      && allowedOrigins.has(webContents.origin);
  } catch {
    return false;
  }
}

function isAllowedDownloadUrl(
  value: string,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      return false;
    }
    if (parsed.protocol === 'blob:') {
      return allowedOrigins.has(parsed.origin);
    }
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export function isAllowedDownloadRequest(
  webContentsUrl: string,
  urlChain: readonly string[],
  hasUserGesture: boolean,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  return hasUserGesture
    && isAllowedDownloadUrl(webContentsUrl, allowedOrigins)
    && urlChain.length > 0
    && urlChain.length <= 10
    && urlChain.every((url) => isAllowedDownloadUrl(url, allowedOrigins));
}
