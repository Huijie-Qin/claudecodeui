import { IS_PLATFORM } from '../../../constants/config';
import type { ShellIncomingMessage, ShellOutgoingMessage } from '../types/types';

export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tenantId = localStorage.getItem('currentTenantId');
  if (!tenantId) {
    console.error('No tenant selected for Shell WebSocket connection');
    return null;
  }

  const params = new URLSearchParams({ tenantId });

  if (IS_PLATFORM) {
    return `${protocol}//${window.location.host}/shell?${params.toString()}`;
  }

  const token = localStorage.getItem('auth-token');
  if (!token) {
    console.error('No authentication token found for Shell WebSocket connection');
    return null;
  }

  params.set('token', token);
  return `${protocol}//${window.location.host}/shell?${params.toString()}`;
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
