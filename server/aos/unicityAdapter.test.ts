import test from 'node:test';
import assert from 'node:assert/strict';
import { UnicityAdapter } from './unicityAdapter';

test('builds a current Unicity runtime blueprint', async () => {
  const originalNetwork = process.env.UNICITY_NETWORK;
  delete process.env.UNICITY_NETWORK;
  const adapter = new UnicityAdapter();

  try {
    const blueprint = await adapter.buildBlueprint();
    assert.equal(blueprint.network, 'testnet2');
    assert.equal(blueprint.walletApi.baseUrl, 'https://wallet-api.unicity.network');
    assert.ok(blueprint.oracles.length > 0);
  } finally {
    if (originalNetwork !== undefined) process.env.UNICITY_NETWORK = originalNetwork;
  }
});

test('builds the live mainnet endpoints without exposing the gateway key', async () => {
  const originalNetwork = process.env.UNICITY_NETWORK;
  const originalWalletApi = process.env.UNICITY_WALLET_API_URL;
  const originalGateway = process.env.UNICITY_GATEWAY_URL;
  process.env.UNICITY_NETWORK = 'mainnet';
  delete process.env.UNICITY_WALLET_API_URL;
  delete process.env.UNICITY_GATEWAY_URL;

  try {
    const blueprint = await new UnicityAdapter().buildBlueprint();
    assert.equal(blueprint.network, 'mainnet');
    assert.equal(blueprint.walletApi.baseUrl, 'https://wallet-api.mainnet.unicity.network');
    assert.equal(blueprint.oracles[0].url, 'https://gateway.mainnet.unicity.network');
    assert.equal('apiKey' in blueprint.oracles[0], false);
  } finally {
    if (originalNetwork === undefined) delete process.env.UNICITY_NETWORK;
    else process.env.UNICITY_NETWORK = originalNetwork;
    if (originalWalletApi === undefined) delete process.env.UNICITY_WALLET_API_URL;
    else process.env.UNICITY_WALLET_API_URL = originalWalletApi;
    if (originalGateway === undefined) delete process.env.UNICITY_GATEWAY_URL;
    else process.env.UNICITY_GATEWAY_URL = originalGateway;
  }
});
