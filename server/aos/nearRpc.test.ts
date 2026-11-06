import test from 'node:test';
import assert from 'node:assert/strict';
import { getNearRpcEndpoints, NearRpcClient, retryAfterDelayMs } from './nearRpc';

test('NEAR RPC defaults to FastNear on testnet and preserves explicit overrides', () => {
  const oldNetwork = process.env.ASGUARD_NEAR_NETWORK;
  const oldUrl = process.env.ASGUARD_NEAR_RPC_URL;
  try {
    process.env.ASGUARD_NEAR_NETWORK = 'testnet';
    delete process.env.ASGUARD_NEAR_RPC_URL;
    assert.deepEqual(getNearRpcEndpoints('testnet'), ['https://rpc.fastnear.com/']);
    assert.deepEqual(getNearRpcEndpoints('testnet', 'https://custom.example/rpc'), ['https://custom.example/rpc']);
    process.env.ASGUARD_NEAR_RPC_URL = 'https://override.example/rpc';
    assert.deepEqual(getNearRpcEndpoints('testnet'), ['https://override.example/rpc']);
    assert.deepEqual(getNearRpcEndpoints('mainnet'), ['https://rpc.mainnet.near.org/']);
  } finally {
    if (oldNetwork === undefined) delete process.env.ASGUARD_NEAR_NETWORK;
    else process.env.ASGUARD_NEAR_NETWORK = oldNetwork;
    if (oldUrl === undefined) delete process.env.ASGUARD_NEAR_RPC_URL;
    else process.env.ASGUARD_NEAR_RPC_URL = oldUrl;
  }
});

test('NEAR RPC failover list is deduplicated and invalid endpoints are rejected', () => {
  assert.deepEqual(getNearRpcEndpoints('testnet', 'https://primary.example', [
    'https://fallback.example', 'https://primary.example',
  ]), ['https://primary.example/', 'https://fallback.example/']);
  assert.throws(() => getNearRpcEndpoints('testnet', 'https://primary.example', 'http://remote.example'), /must use HTTPS/);
});

test('NEAR RPC rotates after 429 and 5xx, honoring Retry-After before failover', async () => {
  const requested: string[] = [];
  const waits: number[] = [];
  const responses = [
    new Response('', { status: 429, headers: { 'retry-after': '2' } }),
    Response.json({ result: { chain_id: 'testnet' } }),
  ];
  const client = new NearRpcClient({
    network: 'testnet',
    primaryUrl: 'https://primary.example',
    failoverUrls: ['https://fallback.example'],
    fetchImpl: async (url) => {
      requested.push(String(url));
      return responses.shift()!;
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(await client.request('status', {}, 'test'), { result: { chain_id: 'testnet' } });
  assert.deepEqual(requested, ['https://primary.example/', 'https://fallback.example/']);
  assert.deepEqual(waits, [2_000]);

  const retryRequests: string[] = [];
  const retryResponses = [
    new Response('', { status: 503 }),
    new Response('', { status: 503 }),
    Response.json({ result: { ok: true } }),
  ];
  const retryClient = new NearRpcClient({
    network: 'testnet',
    primaryUrl: 'https://primary.example',
    failoverUrls: ['https://fallback.example'],
    fetchImpl: async (url) => {
      retryRequests.push(String(url));
      return retryResponses.shift()!;
    },
    wait: async () => undefined,
  });
  await assert.rejects(retryClient.request('status', {}, 'test'), /HTTP 503/);
  assert.deepEqual(await retryClient.request('status', {}, 'test'), { result: { ok: true } });
  assert.deepEqual(retryRequests, [
    'https://primary.example/', 'https://fallback.example/', 'https://fallback.example/',
  ]);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(retryAfterDelayMs('3', 1_000), 3_000);
  assert.equal(retryAfterDelayMs(new Date(4_000).toUTCString(), 1_000), 3_000);
  assert.equal(retryAfterDelayMs('invalid', 1_000), 0);
});
