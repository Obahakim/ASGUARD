import { setTimeout as delay } from 'node:timers/promises';
import { isAllowedApiEndpoint } from '../endpointPolicy';
import { nearRpcDefault } from './nearIntentsConfig';
import type { NearNetwork } from './nearAdapter';

export const DEFAULT_TESTNET_NEAR_RPC_FAILOVER_URLS = [
  'https://rpc.testnet.near.org',
  'https://near-testnet.drpc.org',
  'https://neart.lava.build',
] as const;

export interface NearRpcClientOptions {
  network: NearNetwork;
  primaryUrl?: string;
  failoverUrls?: string | string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

function validateEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('NEAR RPC endpoint must be a valid URL.'); }
  if (!isAllowedApiEndpoint(url)) {
    throw new Error('NEAR endpoints must use HTTPS unless they are loopback development endpoints.');
  }
  return url.toString();
}

export function getNearRpcEndpoints(network: NearNetwork, primaryUrl?: string, failoverUrls?: string | string[]): string[] {
  const configuredNetwork = process.env.ASGUARD_NEAR_NETWORK || 'testnet';
  const primary = primaryUrl
    || (network === configuredNetwork ? process.env.ASGUARD_NEAR_RPC_URL : undefined)
    || nearRpcDefault(network);
  const configuredFailovers = failoverUrls ?? process.env.ASGUARD_NEAR_RPC_FAILOVER_URLS ?? '';
  const failovers = typeof configuredFailovers === 'string'
    ? configuredFailovers.split(/[,\r\n]/).map((endpoint) => endpoint.trim()).filter(Boolean)
    : configuredFailovers;
  return [...new Set([primary, ...failovers].map(validateEndpoint))];
}

export function retryAfterDelayMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { message?: string };
}

export class NearRpcClient {
  readonly endpoints: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private cursor = 0;

  constructor(options: NearRpcClientOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 8_000) || (options.timeoutMs ?? 8_000) < 100) {
      throw new Error('NEAR RPC timeout must be at least 100 milliseconds.');
    }
    this.endpoints = getNearRpcEndpoints(options.network, options.primaryUrl, options.failoverUrls);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.wait = options.wait ?? ((milliseconds) => delay(milliseconds));
  }

  async request<T>(method: string, params: unknown, id: string): Promise<JsonRpcResponse<T>> {
    const start = this.cursor;
    let lastRetryableError: Error | undefined;
    for (let offset = 0; offset < this.endpoints.length; offset += 1) {
      const index = (start + offset) % this.endpoints.length;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoints[index], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timeout);
        lastRetryableError = new Error('NEAR RPC request failed before receiving a response.');
        this.cursor = (index + 1) % this.endpoints.length;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        clearTimeout(timeout);
        lastRetryableError = new Error(`NEAR RPC returned HTTP ${response.status}.`);
        this.cursor = (index + 1) % this.endpoints.length;
        const retryAfter = retryAfterDelayMs(response.headers.get('retry-after'));
        if (retryAfter > 0) await this.wait(retryAfter);
        continue;
      }
      if (!response.ok) {
        clearTimeout(timeout);
        throw new Error(`NEAR RPC returned HTTP ${response.status}.`);
      }
      this.cursor = index;
      try {
        return await response.json() as JsonRpcResponse<T>;
      } finally {
        clearTimeout(timeout);
      }
    }
    this.cursor = (start + 1) % this.endpoints.length;
    throw lastRetryableError ?? new Error('No NEAR RPC endpoints are configured.');
  }
}
