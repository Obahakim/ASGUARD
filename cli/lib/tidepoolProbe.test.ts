import test from 'node:test';
import assert from 'node:assert/strict';
import { nearIntentsDefaults } from '../../server/aos/nearIntentsConfig';
import { probeTidepool } from './tidepoolProbe';

function health(network: string, verifier: string): Response {
  return Response.json({ service: 'tidepool', network, verifier });
}

test('Tidepool probe accepts only the expected testnet and verifier', async () => {
  const expectedVerifier = nearIntentsDefaults('testnet', true).verifier;
  assert.deepEqual(await probeTidepool(async () => health('testnet', expectedVerifier)), { available: true });
  assert.deepEqual(await probeTidepool(async () => health('mainnet', expectedVerifier)), {
    available: false, reason: 'service is not on testnet',
  });
  assert.deepEqual(await probeTidepool(async () => health('testnet', 'wrong.verifier.testnet')), {
    available: false, reason: 'service verifier does not match testnet defaults',
  });
});

test('Tidepool probe reports HTTP, timeout, transport, and malformed response failures', async () => {
  assert.deepEqual(await probeTidepool(async () => new Response('unavailable', { status: 500 })), {
    available: false, reason: 'HTTP 500',
  });
  assert.deepEqual(await probeTidepool(async () => {
    throw new DOMException('deadline', 'TimeoutError');
  }), { available: false, reason: 'request timed out' });
  assert.deepEqual(await probeTidepool(async () => {
    throw new Error('offline');
  }), { available: false, reason: 'could not reach the service' });
  assert.deepEqual(await probeTidepool(async () => Response.json({ network: 'testnet' })), {
    available: false, reason: 'invalid health response',
  });
});

test('Tidepool probe rejects invalid timeout configuration explicitly', async () => {
  await assert.rejects(probeTidepool(fetch, 99), /timeout must be/);
});
