/**
 * Send a message through a WebSocket writer or raw WebSocket.
 * - WebSocketWriter / SSEStreamWriter: call .send(data) directly (handles stringification)
 * - Raw WebSocket: stringify before sending
 */
export function sendMessage(ws, data) {
  try {
    if (ws.isSSEStreamWriter || ws.isWebSocketWriter) {
      ws.send(data);
    } else if (typeof ws.send === 'function') {
      ws.send(JSON.stringify(data));
    }
  } catch (error) {
    console.error('[sendMessage] Error sending message:', error);
  }
}
