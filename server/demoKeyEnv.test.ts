import test from 'node:test';
import assert from 'node:assert/strict';
import { stripDemoPrivateKeysFromEnvironment } from './demoKeyEnv';

test('backend startup strips host-only demo private keys from its environment', () => {
  const environment: NodeJS.ProcessEnv = {
    ASGUARD_DEMO_NEAR_PRIVATE_KEY: 'near-secret',
    ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY: 'tidepool-secret',
    ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID: 'public-account',
  };
  stripDemoPrivateKeysFromEnvironment(environment);
  assert.equal(environment.ASGUARD_DEMO_NEAR_PRIVATE_KEY, undefined);
  assert.equal(environment.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY, undefined);
  assert.equal(environment.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID, 'public-account');
});
