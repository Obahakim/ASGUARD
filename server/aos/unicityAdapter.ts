export interface UnicityOracleEndpoint {
  id: string;
  network: string;
  url: string;
  role: 'token-gateway';
}

export interface UnicityBlueprint {
  network: string;
  gatewayApiKeyConfigured: boolean;
  walletApi: {
    baseUrl: string;
    deviceId: string;
  };
  oracles: UnicityOracleEndpoint[];
}

export class UnicityAdapter {
  async buildBlueprint(): Promise<UnicityBlueprint> {
    const network = process.env.UNICITY_NETWORK || 'testnet2';
    if (network !== 'mainnet' && network !== 'testnet2') {
      throw new Error('UNICITY_NETWORK must be either mainnet or testnet2.');
    }
    const isMainnet = network === 'mainnet';
    const gatewayUrl = process.env.UNICITY_GATEWAY_URL || (
      isMainnet
        ? 'https://gateway.mainnet.unicity.network'
        : 'https://gateway.testnet2.unicity.network'
    );

    return {
      network,
      gatewayApiKeyConfigured: Boolean(process.env.UNICITY_ORACLE_API_KEY?.trim()),
      walletApi: {
        baseUrl: process.env.UNICITY_WALLET_API_URL || (
          isMainnet
            ? 'https://wallet-api.mainnet.unicity.network'
            : 'https://wallet-api.unicity.network'
        ),
        deviceId: process.env.UNICITY_DEVICE_ID || 'asguard-runtime',
      },
      oracles: [{
        id: 'unicity-primary',
        network,
        url: gatewayUrl,
        role: 'token-gateway',
      }],
    };
  }
}
