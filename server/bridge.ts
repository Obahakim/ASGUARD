/**
 * Asguard WebSocket Bridge
 * Real-time communication layer between astridd and the web dashboard
 */

import { Server as HTTPServer } from 'http';
import WebSocket, { Server as WebSocketServer } from 'ws';
import {
  Event,
  EventType,
  WebSocketMessage,
  SubscriptionMessage,
  HITLResponse,
} from './types';
import { logger } from './logger';
import { hitlHandler } from './hitlHandler';
import type { ApiIdentity } from './auth';

type TicketConsumer = (ticket: string) => ApiIdentity | undefined;
const REQUIRED_PROTOCOL = 'asguard.v1';
const TICKET_PROTOCOL_PREFIX = 'asguard-ticket.';

interface ConnectedClient {
  ws: WebSocket;
  identity: ApiIdentity;
  subscriptions: Set<EventType>;
  connectedAt: Date;
}

export class WebSocketBridge {
  private wss: WebSocketServer;
  private clients = new Map<string, ConnectedClient>();
  private clientCounter = 0;
  private eventQueue: Event[] = [];
  private maxQueueSize = 5000;
  private clientIdentities = new WeakMap<WebSocket, ApiIdentity>();

  constructor(
    httpServer: HTTPServer,
    port: number,
    consumeTicket: TicketConsumer,
    allowedOrigins: ReadonlySet<string>
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      handleProtocols: (protocols) => protocols.has(REQUIRED_PROTOCOL) ? REQUIRED_PROTOCOL : false,
    });

    httpServer.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      if (requestUrl.pathname !== '/ws') {
        socket.destroy();
        return;
      }

      const origin = req.headers.origin;
      const protocolHeader = req.headers['sec-websocket-protocol'];
      const protocols = typeof protocolHeader === 'string'
        ? protocolHeader.split(',').map((protocol) => protocol.trim())
        : [];
      const ticketProtocol = protocols.find((protocol) => protocol.startsWith(TICKET_PROTOCOL_PREFIX));
      const ticket = ticketProtocol?.slice(TICKET_PROTOCOL_PREFIX.length) || '';
      const originAllowed = !origin || allowedOrigins.has(origin);
      const identity = originAllowed && protocols.includes(REQUIRED_PROTOCOL) && ticket
        ? consumeTicket(ticket)
        : undefined;

      if (!identity) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clientIdentities.set(ws, identity);
        this.wss.emit('connection', ws, req);
      });
    });

    this.setupConnectionHandler();
    logger.info(`[Bridge] WebSocket server initialized on port ${port}`);
  }

  /**
   * Setup WebSocket connection handler
   */
  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const clientId = `client_${++this.clientCounter}`;
      const identity = this.clientIdentities.get(ws);
      this.clientIdentities.delete(ws);
      if (!identity) {
        ws.close(1008, 'Authentication required');
        return;
      }
      const client: ConnectedClient = {
        ws,
        identity,
        subscriptions: new Set<EventType>(),
        connectedAt: new Date(),
      };

      this.clients.set(clientId, client);
      logger.info(`[Bridge] Authenticated client connected: ${clientId}`, { identity_id: identity.id });

      // Send connection confirmation
      this.sendToClient(ws, {
        type: 'event',
        payload: {
          type: 'connection_status',
          status: 'connected',
          daemon: 'asguard-bridge',
          timestamp: new Date().toISOString(),
          id: `evt_${Date.now()}`,
        },
      });

      // Handle incoming messages
      ws.on('message', (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage;
          this.handleClientMessage(clientId, message);
        } catch (error) {
          logger.error(`[Bridge] Error parsing message from ${clientId}:`, {
            error: String(error),
          });
          this.sendError(ws, 'Invalid message format');
        }
      });

      // Handle client disconnect
      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.info(`[Bridge] Client disconnected: ${clientId}`);
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error(`[Bridge] WebSocket error from ${clientId}:`, {
          error: String(error),
        });
      });
    });
  }

  /**
   * Handle messages from connected clients
   */
  private handleClientMessage(
    clientId: string,
    message: WebSocketMessage
  ): void {
    const client = this.clients.get(clientId);
    if (!client) {
      logger.warn(`[Bridge] Message from unknown client: ${clientId}`);
      return;
    }

    try {
      switch (message.type) {
        case 'subscribe':
          this.handleSubscription(clientId, message as SubscriptionMessage);
          break;

        case 'unsubscribe':
          this.handleUnsubscription(clientId, message as SubscriptionMessage);
          break;

        case 'hitl_response':
          if (client.identity.roles.some((role) => role === 'admin' || role === 'operator')) {
            this.handleHITLResponse(clientId, message.payload as HITLResponse);
          } else {
            this.sendError(client.ws, 'Insufficient role for HITL decisions.');
          }
          break;

        case 'policy_update':
          logger.info(`[Bridge] Policy update request from ${clientId}`);
          // This will be handled by the REST API layer
          break;

        default:
          logger.warn(`[Bridge] Unknown message type from ${clientId}:`, {
            type: message.type,
          });
      }
    } catch (error) {
      logger.error(`[Bridge] Error handling message from ${clientId}:`, {
        error: String(error),
      });
      this.sendError(client.ws, String(error));
    }
  }

  /**
   * Handle client subscription to event types
   */
  private handleSubscription(
    clientId: string,
    message: SubscriptionMessage
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const requestedTypes = message.payload.event_types || [];
    const eventTypes = this.canReadAllEvents(client.identity)
      ? requestedTypes
      : requestedTypes.filter((type) => type === 'connection_status');
    eventTypes.forEach((type) => client.subscriptions.add(type));

    logger.debug(`[Bridge] Client ${clientId} subscribed to events:`, {
      subscriptions: Array.from(client.subscriptions),
    });

    // Send confirmation
    this.sendToClient(client.ws, {
      type: 'event',
      payload: {
        type: 'subscription_confirmed',
        event_types: Array.from(client.subscriptions),
      },
    });
  }

  /**
   * Handle client unsubscription
   */
  private handleUnsubscription(
    clientId: string,
    message: SubscriptionMessage
  ): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const eventTypes = message.payload.event_types || [];
    eventTypes.forEach((type) => client.subscriptions.delete(type));

    logger.debug(`[Bridge] Client ${clientId} unsubscribed from events`);
  }

  /**
   * Handle HITL response from dashboard
   */
  private handleHITLResponse(
    clientId: string,
    response: HITLResponse
  ): void {
    logger.info(`[Bridge] HITL response from ${clientId}:`, response as unknown as Record<string, unknown>);
    // This would integrate with astridd to apply the decision
    // For now, just log it
  }

  /**
   * Broadcast event to all connected clients
   */
  public broadcastEvent(event: Event): void {
    // Store in queue
    this.eventQueue.push(event);
    if (this.eventQueue.length > this.maxQueueSize) {
      this.eventQueue.shift();
    }

    // Send to interested clients
    this.clients.forEach((client, clientId) => {
      // If client has no subscriptions, send all events
      // Otherwise, only send subscribed event types
      const shouldSend =
        (this.canReadAllEvents(client.identity) || event.type === 'connection_status') &&
        (client.subscriptions.size === 0 || client.subscriptions.has(event.type));

      if (shouldSend && client.ws.readyState === WebSocket.OPEN) {
        this.sendToClient(client.ws, {
          type: 'event',
          payload: event,
        });
      }
    });
  }

  private canReadAllEvents(identity: ApiIdentity): boolean {
    return identity.roles.some((role) => role === 'admin' || role === 'operator' || role === 'auditor');
  }

  /**
   * Send message to specific client
   */
  private sendToClient(
    ws: WebSocket,
    message: WebSocketMessage
  ): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send error message to client
   */
  private sendError(ws: WebSocket, errorMessage: string): void {
    this.sendToClient(ws, {
      type: 'event',
      payload: {
        type: 'error',
        message: errorMessage,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Get connected client count
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get recent events from queue
   */
  public getRecentEvents(limit: number = 100): Event[] {
    return this.eventQueue.slice(-limit);
  }

  /**
   * Clear event queue
   */
  public clearEventQueue(): void {
    this.eventQueue = [];
  }

  /**
   * Close all connections
   */
  public close(): void {
    this.clients.forEach((client) => {
      client.ws.close();
    });
    this.clients.clear();
    this.wss.close();
    logger.info('[Bridge] WebSocket bridge closed');
  }
}
