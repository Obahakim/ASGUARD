import type { ChainHealth } from './chainHealth';
import { isAllowedApiEndpoint } from '../endpointPolicy';
import { nearIntentsDefaults, nearRpcDefault } from './nearIntentsConfig';
import { getNearRpcEndpoints, NearRpcClient } from './nearRpc';

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
  private readonly rpc: NearRpcClient;

  constructor(config: {
    network?: string;
    rpcUrl?: string;
    intentsApiUrl?: string;
    intentsVerifier?: string;
    chainSignaturesContract?: string;
    rpcFetchImpl?: typeof fetch;
    rpcRetryWait?: (milliseconds: number) => Promise<void>;
    rpcFailoverUrls?: string | string[];
  } = {}) {
    const network = config.network ?? process.env.ASGUARD_NEAR_NETWORK ?? 'testnet';
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('ASGUARD_NEAR_NETWORK must be mainnet or testnet.');
    }
    this.network = network;
    const configuredNetwork = process.env.ASGUARD_NEAR_NETWORK || 'testnet';
    const environmentRpcUrl = network === configuredNetwork ? process.env.ASGUARD_NEAR_RPC_URL : undefined;
    this.rpcUrl = config.rpcUrl ?? environmentRpcUrl ?? nearRpcDefault(network);
    const intentsDefaults = nearIntentsDefaults(network);
    this.intentsApiUrl = config.intentsApiUrl ?? process.env.ASGUARD_NEAR_INTENTS_API_URL ?? intentsDefaults.apiUrl;
    this.intentsVerifier = config.intentsVerifier ?? process.env.ASGUARD_NEAR_INTENTS_VERIFIER ?? intentsDefaults.verifier;
    this.chainSignaturesContract = config.chainSignaturesContract ?? process.env.ASGUARD_NEAR_CHAIN_SIGNATURES_CONTRACT
      ?? (network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet');
    for (const endpoint of [this.rpcUrl, this.intentsApiUrl, ...getNearRpcEndpoints(network, this.rpcUrl, config.rpcFailoverUrls).slice(1)]) {
      const url = new URL(endpoint);
      if (!isAllowedApiEndpoint(url)) {
        throw new Error('NEAR endpoints must use HTTPS unless they are loopback development endpoints.');
      }
    }
    this.rpc = new NearRpcClient({
      network, primaryUrl: this.rpcUrl, failoverUrls: config.rpcFailoverUrls,
      fetchImpl: config.rpcFetchImpl, wait: config.rpcRetryWait,
    });
  }

  async health(): Promise<ChainHealth> {
    try {
      const body = await this.rpc.request<{ chain_id?: string; sync_info?: { latest_block_height?: number } }>('status', [], 'asguard-health');
      if (body.error || typeof body.result?.sync_info?.latest_block_height !== 'number') {
        throw new Error(body.error?.message ?? 'NEAR RPC returned an invalid status response.');
      }
      if (body.result.chain_id !== this.network) throw new Error(`NEAR RPC is connected to ${body.result.chain_id ?? 'an unknown chain'}, not ${this.network}.`);
      return { chain: this.chain, network: this.network, healthy: true };
    } catch (error) {
      return { chain: this.chain, network: this.network, healthy: false, error: error instanceof Error ? error.message : 'NEAR RPC health check failed.' };
    }
  }

  async getFinalizedTransaction(txHash: string, senderAccountId: string): Promise<unknown> {
    const body = await this.rpc.request<unknown>('tx', {
      tx_hash: txHash, sender_account_id: senderAccountId, wait_until: 'FINAL',
    }, 'asguard-submission-report');
    if (body.error || !body.result || typeof body.result !== 'object') {
      throw new Error(body.error?.message ?? 'NEAR RPC returned no transaction result.');
    }
    return body.result;
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
