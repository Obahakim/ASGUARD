export interface NearIntentsDefaults {
  apiUrl: string;
  verifier: string;
}

export function nearIntentsDefaults(network: 'testnet' | 'mainnet'): NearIntentsDefaults {
  return network === 'testnet'
    ? { apiUrl: 'https://www.usetidepool.tech', verifier: 'verifier.tidepool-sandbox.testnet' }
    : { apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near' };
}
