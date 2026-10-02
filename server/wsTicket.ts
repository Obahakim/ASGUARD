import { randomBytes } from 'node:crypto';
import type { ApiIdentity } from './auth';

interface TicketRecord {
  identity: ApiIdentity;
  expiresAt: number;
}

const tickets = new Map<string, TicketRecord>();
const TICKET_TTL_MS = 30_000;
const MAX_PENDING_TICKETS = 5_000;

export function issueWebSocketTicket(identity: ApiIdentity, now = Date.now()): string {
  for (const [ticket, record] of tickets) {
    if (record.expiresAt <= now) tickets.delete(ticket);
  }

  if (tickets.size >= MAX_PENDING_TICKETS) {
    throw new Error('WebSocket ticket capacity reached.');
  }

  const ticket = randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    identity: { id: identity.id, roles: [...identity.roles] },
    expiresAt: now + TICKET_TTL_MS,
  });
  return ticket;
}

export function consumeWebSocketTicket(ticket: string, now = Date.now()): ApiIdentity | undefined {
  const record = tickets.get(ticket);
  if (!record) return undefined;

  tickets.delete(ticket);
  if (record.expiresAt <= now) return undefined;
  return { id: record.identity.id, roles: [...record.identity.roles] };
}