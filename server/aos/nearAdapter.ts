import type { ChainHealth } from './chainAdapter';

export type NearNetwork = 'mainnet' | 'testnet';

interface IntentsTokenPrice {
  assetId?: unknown;
  decimals?: unknown;
  price?: unknown;
  priceUpdatedAt?: unknown;
}

export class NearAdapter {
  readonly chain = 'near';
  readonly network: NearNetwork;
  readonly rpcUrl: string;
  readonly intentsApiUrl: string;
  readonly intentsVerifier: string;
  readonly chainSignaturesContract: string;

  constructor(config: {
    network?: string;
    rpcUrl?: string;
    intentsApiUrl?: string;
    intentsVerifier?: string;
    chainSignaturesContract?: string;
  } = {}) {
    const network = config.network ?? process.env.ASGUARD_NEAR_NETWORK ?? 'testnet';
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('ASGUARD_NEAR_NETWORK must be mainnet or testnet.');
    }
    this.network = network;
    this.rpcUrl = config.rpcUrl ?? process.env.ASGUARD_NEAR_RPC_URL ?? `https://rpc.${network}.near.org`;
    this.intentsApiUrl = config.intentsApiUrl ?? process.env.ASGUARD_NEAR_INTENTS_API_URL ?? 'https://1click.chaindefuser.com';
    this.intentsVerifier = config.intentsVerifier ?? process.env.ASGUARD_NEAR_INTENTS_VERIFIER ?? 'intents.near';
    this.chainSignaturesContract = config.chainSignaturesContract ?? process.env.ASGUARD_NEAR_CHAIN_SIGNATURES_CONTRACT
      ?? (network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet');
    for (const endpoint of [this.rpcUrl, this.intentsApiUrl]) {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error('NEAR endpoints must use HTTPS unless they are loopback development endpoints.');
      }
    }
  }

  async health(): Promise<ChainHealth> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'asguard-health', method: 'status', params: [] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}.`);
      const body = await response.json() as { result?: { chain_id?: string; sync_info?: { latest_block_height?: number } }; error?: { message?: string } };
      if (body.error || typeof body.result?.sync_info?.latest_block_height !== 'number') {
        throw new Error(body.error?.message ?? 'NEAR RPC returned an invalid status response.');
      }
      if (body.result.chain_id !== this.network) throw new Error(`NEAR RPC is connected to ${body.result.chain_id ?? 'an unknown chain'}, not ${this.network}.`);
      return { chain: this.chain, network: this.network, healthy: true };
    } catch (error) {
      return { chain: this.chain, network: this.network, healthy: false, error: error instanceof Error ? error.message : 'NEAR RPC health check failed.' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async estimateUsdValue(assetId: string, amountInSmallestUnit: string, now = Date.now()): Promise<number | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(new URL('/v0/tokens', `${this.intentsApiUrl.replace(/\/$/, '')}/`), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return undefined;
      const tokens = await response.json() as unknown;
      if (!Array.isArray(tokens)) return undefined;
      const token = tokens.find((item): item is IntentsTokenPrice =>
        typeof item === 'object' && item !== null && (item as IntentsTokenPrice).assetId === assetId
      );
      if (!token || typeof token.decimals !== 'number' || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36
        || typeof token.price !== 'number' || !Number.isFinite(token.price) || token.price <= 0
        || typeof token.priceUpdatedAt !== 'string') return undefined;
      const updatedAt = Date.parse(token.priceUpdatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > 5 * 60_000) return undefined;
      const priceCents = Math.ceil(token.price * 100);
      if (!Number.isSafeInteger(priceCents)) return undefined;
      const scale = 10n ** BigInt(token.decimals);
      const rawValueCents = (BigInt(amountInSmallestUnit) * BigInt(priceCents) + scale - 1n) / scale;
      if (rawValueCents > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      return Number(rawValueCents) / 100;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const nearAdapter = new NearAdapter();