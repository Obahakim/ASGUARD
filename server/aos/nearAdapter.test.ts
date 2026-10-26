import test from 'node:test';
import assert from 'node:assert/strict';

import { NearAdapter } from './nearAdapter';

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