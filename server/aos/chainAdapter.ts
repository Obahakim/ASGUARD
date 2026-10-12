/**
 * Chain boundary for ASGUARD. Policy and anomaly decisions remain chain neutral;
 * adapters only provide network identity and read/simulation operations.
 */
export interface ChainHealth {
  chain: string;
  network: string;
  healthy: boolean;
  genesis_hash?: string;
  error?: string;
}

export interface ChainAdapter {
  readonly chain: string;
  readonly network: string;
  health(): Promise<ChainHealth>;
  simulateSignedTransaction(transactionBase64: string): Promise<{
    err: unknown;
    logs?: string[];
    unitsConsumed?: number;
    returnData?: unknown;
  }>;
  sendSignedTransaction(transactionBase64: string): Promise<string>;
}

type RpcEnvelope<T> = { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string } };

export class SolanaDevnetAdapter implements ChainAdapter {
  readonly chain = 'solana';
  readonly network = process.env.ASGUARD_SOLANA_CLUSTER?.trim() || 'devnet';
  private readonly endpoint = process.env.ASGUARD_SOLANA_RPC_URL?.trim() || 'https://api.devnet.solana.com';
  // Solana's official devnet getGenesisHash response (https://solana.com/docs/rpc/http/getgenesishash).
  private readonly devnetGenesisHash = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC';

  constructor() {
    if (this.network !== 'devnet') {
      throw new Error('ASGUARD_SOLANA_CLUSTER must be devnet until a production cluster is explicitly configured.');
    }
    const url = new URL(this.endpoint);
    if (url.protocol !== 'https:' || !['api.devnet.solana.com'].includes(url.hostname) && process.env.ASGUARD_SOLANA_ALLOW_CUSTOM_RPC !== 'true') {
      throw new Error('Solana RPC must use HTTPS and the official devnet endpoint (or explicitly enable a trusted custom RPC).');
    }
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
      const body = await response.json() as RpcEnvelope<T>;
      if (body.error) throw new Error(`Solana RPC ${body.error.code}: ${body.error.message}`);
      if (body.result === undefined) throw new Error('Solana RPC response did not contain a result.');
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async assertDevnet(): Promise<string> {
    const genesis = await this.rpc<string>('getGenesisHash');
    if (genesis !== this.devnetGenesisHash) {
      throw new Error('Configured Solana RPC is not connected to the official devnet genesis. Transaction operation refused.');
    }
    return genesis;
  }

  async health(): Promise<ChainHealth> {
    try {
      const genesis = await this.assertDevnet();
      return { chain: this.chain, network: this.network, healthy: true, genesis_hash: genesis };
    } catch (error) {
      return { chain: this.chain, network: this.network, healthy: false, error: error instanceof Error ? error.message : 'RPC health check failed' };
    }
  }

  async simulateSignedTransaction(transactionBase64: string) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transactionBase64) || transactionBase64.length > 1_500_000) {
      throw new Error('transaction_base64 must be a valid base64 transaction smaller than 1.5 MB.');
    }
    await this.assertDevnet();
    return this.rpc<{ err: unknown; logs?: string[]; unitsConsumed?: number; returnData?: unknown }>(
      'simulateTransaction',
      [transactionBase64, { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' }]
    );
  }

  async sendSignedTransaction(transactionBase64: string): Promise<string> {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transactionBase64) || transactionBase64.length > 1_500_000) {
      throw new Error('transaction_base64 must be a valid base64 transaction smaller than 1.5 MB.');
    }
    await this.assertDevnet();
    return this.rpc<string>('sendTransaction', [transactionBase64, {
      encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0,
    }]);
  }
}

export const chainAdapter: ChainAdapter = new SolanaDevnetAdapter();
