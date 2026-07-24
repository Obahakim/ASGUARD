import test from 'node:test';
import assert from 'node:assert/strict';
import { UnicityAdapter } from './unicityAdapter';

test('builds a current Unicity runtime blueprint', async () => {
  const adapter = new UnicityAdapter();
  const blueprint = await adapter.buildBlueprint();

  assert.equal(blueprint.network, 'testnet');
  assert.equal(blueprint.walletApi.baseUrl, 'https://wallet-api.unicity.network');
  assert.ok(blueprint.oracles.length > 0);
});
