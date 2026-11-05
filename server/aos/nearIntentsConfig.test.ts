import test from 'node:test';
import assert from 'node:assert/strict';
import { nearIntentsDefaults } from './nearIntentsConfig';

test('testnet uses Tidepool while mainnet remains on official 1Click', () => {
  assert.deepEqual(nearIntentsDefaults('testnet'), {
    apiUrl: 'https://www.usetidepool.tech', verifier: 'verifier.tidepool-sandbox.testnet',
  });
  assert.deepEqual(nearIntentsDefaults('mainnet'), {
    apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near',
  });
});
