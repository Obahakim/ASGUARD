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

const EMPTY_EVENT_TYPES: EventType[] = [];

export function useBridgeConnection(
  onEvent?: (event: Event) => void,
  options: BridgeOptions = {}
): UseBridgeConnection {
  const {
    url = typeof window !== 'undefined'
      ? (() => {
          const base = process.env.NEXT_PUBLIC_ASGUARD_API_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
          const endpoint = new URL(base);
          endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
          endpoint.pathname = '/ws';
          endpoint.search = '';
          return endpoint.toString();
        })()
      : 'ws://localhost:8080/ws',
    eventTypes = EMPTY_EVENT_TYPES,
    autoConnect = true,
    getWebSocketTicket,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<Event[]>([]);
  const [lastEvent, setLastEvent] = useState<Event | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const enabledRef = useRef(autoConnect);
  const reconnectDelay = 3000; // 3 seconds

  /**
   * Connect to WebSocket bridge
   */
  const connect = useCallback(async () => {
    if (!enabledRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    try {
      if (!getWebSocketTicket) {
        throw new Error('A one-time WebSocket ticket provider is required.');
      }
      const ticket = await getWebSocketTicket();
      if (!enabledRef.current) return;
      const ws = new WebSocket(url, ['asguard.v1', `asguard-ticket.${ticket}`]);

      ws.addEventListener('open', () => {
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
          setIsConnected(false);
        }
      });

      ws.addEventListener('close', () => {
        setIsConnected(false);
        if (!enabledRef.current) return;
        reconnectAttemptsRef.current++;
        const delay = Math.min(30_000, reconnectDelay * reconnectAttemptsRef.current);
        reconnectTimeoutRef.current = setTimeout(() => { void connect(); }, delay);
      });

      ws.addEventListener('error', () => {
        setIsConnected(false);
      });

      wsRef.current = ws;
    } catch (error) {
        if (!enabledRef.current) return;
        reconnectAttemptsRef.current++;
        const delay = Math.min(30_000, reconnectDelay * reconnectAttemptsRef.current);
        reconnectTimeoutRef.current = setTimeout(() => { void connect(); }, delay);
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
        setIsConnected(false);
      }
    },
    []
  );

  /**
   * Auto-connect on mount, disconnect on unmount
   */
  useEffect(() => {
    enabledRef.current = autoConnect;
    if (autoConnect) {
      void connect();
    } else {
      setEvents([]);
      setLastEvent(null);
    }

    return () => {
      enabledRef.current = false;
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
