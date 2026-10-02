import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';

import { WebSocketBridge } from './bridge';
import type { ApiIdentity } from './auth';

async function createTestBridge() {
  const server = createServer();
  const tickets = new Map<string, ApiIdentity>([
    ['valid-ticket', { id: 'admin-test', roles: ['admin', 'operator'] }],
    ['origin-ticket', { id: 'admin-test', roles: ['admin', 'operator'] }],
  ]);
  const bridge = new WebSocketBridge(
    server,
    0,
    (ticket) => {
      const identity = tickets.get(ticket);
      tickets.delete(ticket);
      return identity;
    },
    new Set(['https://trusted.example'])
  );

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, bridge, url: `ws://127.0.0.1:${address.port}/ws` };
}

function rejectedStatus(url: string, protocols: string[], origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, origin ? { origin } : undefined);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', () => {});
    socket.once('open', () => {
      socket.close();
      reject(new Error('Expected the WebSocket handshake to be rejected.'));
    });
  });
}

test('requires a one-time ticket and allowlisted browser origin for WebSockets', async () => {
  const { server, bridge, url } = await createTestBridge();

  try {
    assert.equal(await rejectedStatus(url, ['asguard.v1']), 401);
    assert.equal(
      await rejectedStatus(url, ['asguard.v1', 'asguard-ticket.origin-ticket'], 'https://evil.example'),
      401
    );

    const socket = new WebSocket(
      url,
      ['asguard.v1', 'asguard-ticket.valid-ticket'],
      { origin: 'https://trusted.example' }
    );
    await once(socket, 'open');
    assert.equal(socket.protocol, 'asguard.v1');

    const firstMessage = await once(socket, 'message');
    const message = JSON.parse(firstMessage[0].toString());
    assert.equal(message.payload.type, 'connection_status');
    socket.close();
  } finally {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
