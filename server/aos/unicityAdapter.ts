import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

export interface UnicityBlueprint {
  network: string;
  walletApi: {
    baseUrl: string;
    network: string;
    deviceId: string;
  };
  oracles: string[];
}

export class UnicityAdapter {
  async buildBlueprint(): Promise<UnicityBlueprint> {
    const baseProviders = createNodeProviders({
      network: 'testnet',
      dataDir: './.sphere-data',
      tokensDir: './.sphere-tokens',
      oracle: { apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590' },
    });

    const providers = createWalletApiProviders(baseProviders, {
      baseUrl: 'https://wallet-api.unicity.network',
      network: 'testnet2',
      deviceId: 'asguard-runtime',
    });

    return {
      network: 'testnet',
      walletApi: {
        baseUrl: 'https://wallet-api.unicity.network',
        network: 'testnet2',
        deviceId: 'asguard-runtime',
      },
      oracles: [providers.oracle ? 'oracle:configured' : 'oracle:missing'],
    };
  }
}
