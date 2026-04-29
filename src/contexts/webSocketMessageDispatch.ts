export type WebSocketMessageListener<TMessage = unknown> = (message: TMessage) => void;

export function createWebSocketMessageDispatcher<TMessage = unknown>({
  updateLatestMessage,
  onListenerError,
}: {
  updateLatestMessage: (message: TMessage) => void;
  onListenerError?: (error: unknown) => void;
}) {
  const listeners = new Set<WebSocketMessageListener<TMessage>>();

  return {
    publish(message: TMessage) {
      updateLatestMessage(message);

      for (const listener of Array.from(listeners)) {
        try {
          listener(message);
        } catch (error) {
          onListenerError?.(error);
        }
      }
    },

    subscribe(listener: WebSocketMessageListener<TMessage>) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
