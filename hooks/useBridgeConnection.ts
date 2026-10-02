/**
 * useBridgeConnection - React hook for Asguard WebSocket bridge connection
 * Handles real-time event streaming and policy synchronization
 */

'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { Event, EventType } from '../server/types';

interface BridgeOptions {
  url?: string;
  eventTypes?: EventType[];
  autoConnect?: boolean;
  getWebSocketTicket?: () => Promise<string>;
}

interface UseBridgeConnection {
  isConnected: boolean;
  events: Event[];
  lastEvent: Event | null;
  subscribe: (eventTypes: EventType[]) => void;
  unsubscribe: (eventTypes: EventType[]) => void;
  sendMessage: (type: string, payload: unknown) => void;
}

export function useBridgeConnection(
  onEvent?: (event: Event) => void,
  options: BridgeOptions = {}
): UseBridgeConnection {
  const {
    url = typeof window !== 'undefined'
      ? `ws://${window.location.hostname}:8080/ws`
      : 'ws://localhost:8080/ws',
    eventTypes = [],
    autoConnect = true,
    getWebSocketTicket,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [lastEvent, setLastEvent] = useState<Event | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 10;
  const reconnectDelay = 3000; // 3 seconds

  /**
   * Connect to WebSocket bridge
   */
  const connect = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    try {
      if (!getWebSocketTicket) {
        throw new Error('A one-time WebSocket ticket provider is required.');
      }
      const ticket = await getWebSocketTicket();
      const ws = new WebSocket(url, ['asguard.v1', `asguard-ticket.${ticket}`]);

      ws.addEventListener('open', () => {
        console.log('[useBridgeConnection] Connected to bridge');
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;

        // Subscribe to event types if specified
        if (eventTypes.length > 0) {
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              payload: { event_types: eventTypes },
            })
          );
        }
      });

      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'event' && message.payload) {
            const eventData = message.payload as Event;

            // Store event
            setEvents((prev) => {
              const updated = [...prev, eventData];
              // Keep only last 1000 events
              return updated.slice(-1000);
            });

            setLastEvent(eventData);

            // Call callback if provided
            if (onEvent) {
              onEvent(eventData);
            }
          }
        } catch (error) {
          console.error(
            '[useBridgeConnection] Error processing message:',
            error
          );
        }
      });

      ws.addEventListener('close', () => {
        console.log('[useBridgeConnection] Disconnected from bridge');
        setIsConnected(false);

        // Attempt to reconnect
        if (reconnectAttemptsRef.current < maxReconnectAttempts) {
          reconnectAttemptsRef.current++;
          const delay = reconnectDelay * reconnectAttemptsRef.current;
          console.log(
            `[useBridgeConnection] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`
          );

          reconnectTimeoutRef.current = setTimeout(() => {
            void connect();
          }, delay);
        } else {
          console.error(
            '[useBridgeConnection] Max reconnection attempts reached'
          );
        }
      });

      ws.addEventListener('error', (error) => {
        console.error('[useBridgeConnection] WebSocket error:', error);
      });

      wsRef.current = ws;
    } catch (error) {
      console.error('[useBridgeConnection] Connection error:', error);
    }
  }, [url, eventTypes, onEvent, getWebSocketTicket]);

  /**
   * Disconnect from WebSocket bridge
   */
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  /**
   * Subscribe to specific event types
   */
  const subscribe = useCallback((types: EventType[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'subscribe',
          payload: { event_types: types },
        })
      );
    }
  }, []);

  /**
   * Unsubscribe from specific event types
   */
  const unsubscribe = useCallback((types: EventType[]) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: 'unsubscribe',
          payload: { event_types: types },
        })
      );
    }
  }, []);

  /**
   * Send custom message to bridge
   */
  const sendMessage = useCallback(
    (type: string, payload: unknown) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type,
            payload,
          })
        );
      } else {
        console.warn(
          '[useBridgeConnection] Cannot send message: WebSocket not connected'
        );
      }
    },
    []
  );

  /**
   * Auto-connect on mount, disconnect on unmount
   */
  useEffect(() => {
    if (autoConnect) {
      void connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  return {
    isConnected,
    events,
    lastEvent,
    subscribe,
    unsubscribe,
    sendMessage,
  };
}
