export const SHUTDOWN_ERROR_CODE = 'SERVER_SHUTTING_DOWN';
export const SHUTDOWN_MESSAGE = 'Server is shutting down and is not accepting new work';
export const SHUTDOWN_WEBSOCKET_CLOSE_CODE = 1012;
export const SHUTDOWN_WEBSOCKET_CLOSE_REASON = 'Server shutting down';
const WEBSOCKET_CONNECTING_STATE = 0;
const WEBSOCKET_OPEN_STATE = 1;
const SHUTDOWN_REJECTED_CHAT_MESSAGE_TYPES = new Set([
  'claude-supplement',
  'cursor-resume',
]);

function assertShutdownStateReader(isShuttingDown) {
  if (typeof isShuttingDown !== 'function') {
    throw new TypeError('isShuttingDown must be a function');
  }
}

export function createShutdownErrorPayload() {
  return {
    error: SHUTDOWN_MESSAGE,
    code: SHUTDOWN_ERROR_CODE,
    retryable: true,
  };
}

export function shouldEnforceShutdownAdmission({ desktopMode, shuttingDown }) {
  return Boolean(desktopMode && shuttingDown);
}

export function isShutdownRejectedChatMessageType(type) {
  return typeof type === 'string'
    && (type.endsWith('-command') || SHUTDOWN_REJECTED_CHAT_MESSAGE_TYPES.has(type));
}

export function createShutdownAdmissionMiddleware({ isShuttingDown }) {
  assertShutdownStateReader(isShuttingDown);

  return (_req, res, next) => {
    if (!isShuttingDown()) {
      next();
      return;
    }

    res.setHeader('Connection', 'close');
    res.status(503).json({
      success: false,
      ...createShutdownErrorPayload(),
    });
  };
}

export function createShutdownWebSocketMessageGuard({
  isShuttingDown,
  closeConnection = true,
}) {
  assertShutdownStateReader(isShuttingDown);

  return (ws) => {
    if (!isShuttingDown()) {
      return false;
    }

    if (ws?.readyState === WEBSOCKET_OPEN_STATE && typeof ws.send === 'function') {
      try {
        ws.send(JSON.stringify({
          type: 'error',
          ...createShutdownErrorPayload(),
        }));
      } catch {
        // The message remains rejected even when its structured error frame
        // cannot be delivered to a connection that is already failing.
      }
    }

    if (
      closeConnection
      && (ws?.readyState === WEBSOCKET_CONNECTING_STATE || ws?.readyState === WEBSOCKET_OPEN_STATE)
      && typeof ws.close === 'function'
    ) {
      try {
        ws.close(SHUTDOWN_WEBSOCKET_CLOSE_CODE, SHUTDOWN_WEBSOCKET_CLOSE_REASON);
      } catch {
        // Admission is still rejected even when the transport cannot be closed.
      }
    }

    return true;
  };
}

export function createShutdownChatMessageGuard({ isShuttingDown }) {
  const rejectWithoutClosing = createShutdownWebSocketMessageGuard({
    isShuttingDown,
    closeConnection: false,
  });

  return (ws, messageType) => (
    isShutdownRejectedChatMessageType(messageType)
    && rejectWithoutClosing(ws)
  );
}
