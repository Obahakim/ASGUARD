import test from 'node:test';
import assert from 'node:assert/strict';

import { ChainRegistry } from './chainRegistry';
import { NearAdapter } from './nearAdapter';

test('NEAR is the default network and unknown targets are approval-only', () => {
  const near = new NearAdapter({ network: 'testnet', rpcUrl: 'https://rpc.testnet.near.org' });
  const registry = new ChainRegistry(near);

  assert.equal(registry.resolve().chain, 'near');
  assert.equal(registry.resolve('near', 'testnet').chain, 'near');
  const unknown = registry.resolve('arbitrum', 'mainnet');
  assert.equal('approvalOnly' in unknown && unknown.approvalOnly, true);
  assert.equal(unknown.chain, 'arbitrum');
  assert.equal(unknown.network, 'mainnet');
});

test('NEAR adapter rejects unsupported networks and non-TLS remote RPCs', () => {
  assert.throws(() => new NearAdapter({ network: 'devnet' }), /mainnet or testnet/);
  assert.throws(() => new NearAdapter({ network: 'mainnet', rpcUrl: 'http://rpc.example.org' }), /HTTPS/);
});