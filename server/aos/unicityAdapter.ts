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
  status: 'configured' | 'unavailable';
  reason?: string;
}

function requiredEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export class UnicityAdapter {
  async buildBlueprint(): Promise<UnicityBlueprint> {
    const network = requiredEnv('UNICITY_NETWORK') ?? 'testnet2';
    const walletApiUrl = requiredEnv('UNICITY_WALLET_API_URL') ?? 'https://wallet-api.unicity.network';
    const baseProviders = createNodeProviders({
      network,
      dataDir: requiredEnv('UNICITY_DATA_DIR') ?? './.sphere-data',
      tokensDir: requiredEnv('UNICITY_TOKENS_DIR') ?? './.sphere-tokens',
    });

    const providers = createWalletApiProviders(baseProviders, {
      baseUrl: walletApiUrl,
      network,
      deviceId: requiredEnv('UNICITY_DEVICE_ID') ?? 'asguard-runtime',
    });

    return {
      network,
      walletApi: {
        baseUrl: walletApiUrl,
        network,
        deviceId: requiredEnv('UNICITY_DEVICE_ID') ?? 'asguard-runtime',
      },
      oracles: [providers.oracle ? 'oracle:configured' : 'oracle:missing'],
      status: providers.oracle ? 'configured' : 'unavailable',
      reason: providers.oracle ? undefined : 'Unicity oracle provider is unavailable.',
    };
  }
}
