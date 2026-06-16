import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AUTH_TOKEN_STORAGE_KEY } from '../components/auth/constants';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { useTenant } from './TenantContext';
import {
  createWebSocketLifecycleState,
  isCurrentWebSocketConnectionAttempt,
  markWebSocketLifecycleClosed,
  prepareWebSocketConnectionAttempt,
  shouldAttemptTenantWebSocketConnection,
} from './webSocketLifecycle';
import { createWebSocketMessageDispatcher } from './webSocketMessageDispatch';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: any) => void;
  subscribeMessage: (listener: (message: any) => void) => () => void;
  latestMessage: any | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null, tenantId: number | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tenantPart = tenantId ? `tenantId=${encodeURIComponent(String(tenantId))}` : '';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws${tenantPart ? `?${tenantPart}` : ''}`; // Platform mode: Use same domain as the page (goes through proxy)
  const latestToken = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || token;
  if (!latestToken) return null;
  const params = new URLSearchParams({ token: latestToken });
  if (tenantId) params.set('tenantId', String(tenantId));
  return `${protocol}//${window.location.host}/ws?${params.toString()}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const lifecycleRef = useRef(createWebSocketLifecycleState());
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();
  const { currentTenant } = useTenant();
  const messageDispatcherRef = useRef<ReturnType<typeof createWebSocketMessageDispatcher<any>> | null>(null);

  if (!messageDispatcherRef.current) {
    messageDispatcherRef.current = createWebSocketMessageDispatcher({
      updateLatestMessage: setLatestMessage,
      onListenerError: (error) => {
        console.error('Error handling WebSocket message listener:', error);
      },
    });
  }

  const publishMessage = useCallback((message: any) => {
    messageDispatcherRef.current?.publish(message);
  }, []);

  const subscribeMessage = useCallback((listener: (message: any) => void) => {
    return messageDispatcherRef.current?.subscribe(listener) ?? (() => {});
  }, []);

  const connect = useCallback((attemptGeneration: number) => {
    if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) return;
    try {
      const tenantId = currentTenant?.id ?? null;
      if (!shouldAttemptTenantWebSocketConnection(tenantId)) return;

      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token, tenantId);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');
      
      const websocket = new WebSocket(wsUrl);
      wsRef.current = websocket;

      websocket.onopen = () => {
        if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) {
          websocket.close();
          return;
        }
        setIsConnected(true);
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          publishMessage({ type: 'websocket-reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) return;
        try {
          const data = JSON.parse(event.data);
          publishMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) return;
        setIsConnected(false);
        if (wsRef.current === websocket) {
          wsRef.current = null;
        }
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) return;
          connect(attemptGeneration);
        }, 3000);
      };

      websocket.onerror = (error) => {
        if (!isCurrentWebSocketConnectionAttempt(lifecycleRef, attemptGeneration)) return;
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [currentTenant?.id, publishMessage, token]); // everytime token or tenant changes, we reconnect

  useEffect(() => {
    const attemptGeneration = prepareWebSocketConnectionAttempt(lifecycleRef);
    connect(attemptGeneration);
    
    return () => {
      markWebSocketLifecycleClosed(lifecycleRef);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      const socket = wsRef.current;
      wsRef.current = null;
      if (socket) {
        socket.close();
      }
    };
  }, [connect]); // everytime token or tenant changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribeMessage,
    latestMessage,
    isConnected
  }), [sendMessage, subscribeMessage, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
