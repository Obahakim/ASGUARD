import test from 'node:test';
import assert from 'node:assert/strict';

import { NearAdapter } from './nearAdapter';

test('NEAR adapter defaults to FastNear for testnet and preserves configured overrides', () => {
  const originalNetwork = process.env.ASGUARD_NEAR_NETWORK;
  const original = process.env.ASGUARD_NEAR_RPC_URL;
  try {
    process.env.ASGUARD_NEAR_NETWORK = 'testnet';
    delete process.env.ASGUARD_NEAR_RPC_URL;
    assert.equal(new NearAdapter({ network: 'testnet' }).rpcUrl, 'https://rpc.fastnear.com');
    process.env.ASGUARD_NEAR_RPC_URL = 'https://override.example/rpc';
    assert.equal(new NearAdapter({ network: 'testnet' }).rpcUrl, 'https://override.example/rpc');
    assert.equal(new NearAdapter({ network: 'testnet', rpcUrl: 'https://custom.example/rpc' }).rpcUrl, 'https://custom.example/rpc');
  } finally {
    if (originalNetwork === undefined) delete process.env.ASGUARD_NEAR_NETWORK;
    else process.env.ASGUARD_NEAR_NETWORK = originalNetwork;
    if (original === undefined) delete process.env.ASGUARD_NEAR_RPC_URL;
    else process.env.ASGUARD_NEAR_RPC_URL = original;
  }
});

test('NEAR adapter accepts bracketed IPv6 loopback for local endpoints', () => {
  const adapter = new NearAdapter({ network: 'testnet', rpcUrl: 'http://[::1]:8080', intentsApiUrl: 'https://intents.example' });
  assert.equal(adapter.rpcUrl, 'http://[::1]:8080');
  assert.throws(() => new NearAdapter({ network: 'testnet', rpcUrl: 'http://example.com' }), /NEAR endpoints must use HTTPS unless they are loopback development endpoints/);
});

test('NEAR health rotates to a failover RPC after 429 and honors Retry-After', async () => {
  const requested: string[] = [];
  const waits: number[] = [];
  const responses = [
    new Response('', { status: 429, headers: { 'retry-after': '1' } }),
    Response.json({ result: { chain_id: 'testnet', sync_info: { latest_block_height: 10 } } }),
  ];
  const adapter = new NearAdapter({
    network: 'testnet',
    rpcUrl: 'https://primary.example',
    rpcFailoverUrls: ['https://fallback.example'],
    rpcFetchImpl: async (url) => {
      requested.push(String(url));
      return responses.shift()!;
    },
    rpcRetryWait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal((await adapter.health()).healthy, true);
  assert.deepEqual(requested, ['https://primary.example/', 'https://fallback.example/']);
  assert.deepEqual(waits, [1_000]);
});

test('NEAR token valuation rounds spend upward and rejects stale prices', async () => {
  const originalFetch = globalThis.fetch;
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([{
      assetId: 'nep141:test.near',
      decimals: 2,
      price: 1.001,
      priceUpdatedAt: new Date(now - 1_000).toISOString(),
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
    const adapter = new NearAdapter({ network: 'testnet', intentsApiUrl: 'https://intents.example' });
    assert.equal(await adapter.estimateUsdValue('nep141:test.near', '1', now), 0.02);

    globalThis.fetch = async () => new Response(JSON.stringify([{
      assetId: 'nep141:test.near', decimals: 2, price: 1, priceUpdatedAt: new Date(now - 6 * 60_000).toISOString(),
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(await adapter.estimateUsdValue('nep141:test.near', '100', now), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NEAR health fails closed when RPC reports a different network', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      result: { chain_id: 'mainnet', sync_info: { latest_block_height: 123 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const adapter = new NearAdapter({ network: 'testnet', rpcUrl: 'https://rpc.testnet.near.org' });
    const health = await adapter.health();
    assert.equal(health.healthy, false);
    assert.match(health.error ?? '', /not testnet/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('NEAR submission lookup explicitly waits for final execution', async () => {
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> | undefined;
  try {
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ result: { final_execution_status: 'FINAL' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const adapter = new NearAdapter({ network: 'testnet', rpcUrl: 'https://rpc.testnet.near.org' });
    const result = await adapter.getFinalizedTransaction('hash', 'sender.testnet');
    assert.deepEqual(request?.params, { tx_hash: 'hash', sender_account_id: 'sender.testnet', wait_until: 'FINAL' });
    assert.equal((result as { final_execution_status: string }).final_execution_status, 'FINAL');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
