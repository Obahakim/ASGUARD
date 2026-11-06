import test from 'node:test';
import assert from 'node:assert/strict';
import { nearIntentsDefaults, nearRpcDefault } from './nearIntentsConfig';

test('endpoint defaults use official 1Click unless testnet Tidepool demo is enabled', () => {
  assert.deepEqual(nearIntentsDefaults('testnet'), {
    apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near',
  });
  assert.deepEqual(nearIntentsDefaults('testnet', true), {
    apiUrl: 'https://www.usetidepool.tech', verifier: 'verifier.tidepool-sandbox.testnet',
  });
  assert.deepEqual(nearIntentsDefaults('mainnet'), {
    apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near',
  });
  assert.deepEqual(nearIntentsDefaults('mainnet', true), {
    apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near',
  });
  assert.equal(nearRpcDefault('testnet'), 'https://rpc.testnet.fastnear.com');
  assert.equal(nearRpcDefault('mainnet'), 'https://rpc.mainnet.near.org');
});
