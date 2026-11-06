export interface NearIntentsDefaults {
  apiUrl: string;
  verifier: string;
}

export function nearRpcDefault(network: 'testnet' | 'mainnet'): string {
  return network === 'testnet' ? 'https://rpc.fastnear.com' : 'https://rpc.mainnet.near.org';
}

export function nearIntentsDefaults(network: 'testnet' | 'mainnet', tidepoolDemoEnabled = false): NearIntentsDefaults {
  if (network === 'testnet' && tidepoolDemoEnabled) {
    return { apiUrl: 'https://www.usetidepool.tech', verifier: 'verifier.tidepool-sandbox.testnet' };
  }
  return { apiUrl: 'https://1click.chaindefuser.com', verifier: 'intents.near' };
}
