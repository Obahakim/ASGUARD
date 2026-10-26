import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nearAdapter, type NearNetwork } from './aos/nearAdapter';

export type WatchedNearNetwork = `near:${NearNetwork}`;

export interface WatchedNearWallet {
  id: string;
  agent_id: string;
  account_id: string;
  network: WatchedNearNetwork;
  label: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  last_tx_hint?: string;
  last_scanned_height: number | null;
}

export interface WatchedNearActivity {
  id: string;
  watch_id: string;
  agent_id: string;
  account_id: string;
  network: WatchedNearNetwork;
  block_height: number;
  transaction_hash: string;
  signer_id?: string;
  receiver_id?: string;
  direction: 'outbound' | 'inbound' | 'self';
  action_kinds: string[];
  observed_at: string;
}

interface WatchStoreFile {
  version: 1;
  wallets: WatchedNearWallet[];
  activity: WatchedNearActivity[];
}

interface NormalizedChainTransaction {
  hash: string;
  signer_id?: string;
  receiver_id?: string;
  action_kinds: string[];
}

export function isValidNearAccountId(accountId: string): boolean {
  return accountId.length >= 2 && accountId.length <= 64 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(accountId);
}

function isNearNetwork(value: string): value is WatchedNearNetwork {
  return value === 'near:testnet' || value === 'near:mainnet';
}

function parseStore(value: unknown): WatchStoreFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Wallet watch store is malformed.');
  const candidate = value as Partial<WatchStoreFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.wallets) || !Array.isArray(candidate.activity)) {
    throw new Error('Wallet watch store has an unsupported format.');
  }
  const ids = new Set<string>();
  for (const wallet of candidate.wallets) {
    if (!wallet || typeof wallet !== 'object' || typeof wallet.id !== 'string' || ids.has(wallet.id)
      || typeof wallet.agent_id !== 'string' || !wallet.agent_id.trim() || typeof wallet.account_id !== 'string'
      || !isValidNearAccountId(wallet.account_id) || !isNearNetwork(wallet.network) || typeof wallet.label !== 'string'
      || typeof wallet.active !== 'boolean' || typeof wallet.created_at !== 'string' || typeof wallet.updated_at !== 'string'
      || !(wallet.last_scanned_height === null || Number.isSafeInteger(wallet.last_scanned_height) && wallet.last_scanned_height >= 0)) {
      throw new Error('Wallet watch store contains an invalid wallet record.');
    }
    ids.add(wallet.id);
  }
  for (const activity of candidate.activity) {
    if (!activity || typeof activity !== 'object' || !ids.has(activity.watch_id) || typeof activity.id !== 'string'
      || typeof activity.transaction_hash !== 'string' || !Number.isSafeInteger(activity.block_height)
      || !['outbound', 'inbound', 'self'].includes(activity.direction) || !Array.isArray(activity.action_kinds)) {
      throw new Error('Wallet watch store contains an invalid activity record.');
    }
  }
  return { version: 1, wallets: structuredClone(candidate.wallets), activity: structuredClone(candidate.activity) };
}

export class NearWalletWatchStore {
  private readonly filePath: string;
  private wallets: WatchedNearWallet[] = [];
  private activity: WatchedNearActivity[] = [];

  constructor(filePath = process.env.ASGUARD_WATCHED_WALLETS_PATH || path.join(os.homedir(), '.astrid', 'watched_wallets.json')) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const parsed = parseStore(JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown);
    this.wallets = parsed.wallets;
    this.activity = parsed.activity;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, wallets: this.wallets, activity: this.activity }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }

  register(input: { agent_id: string; account_id: string; network: string; label?: string }): { wallet: WatchedNearWallet; created: boolean } {
    if (typeof input.agent_id !== 'string' || !input.agent_id.trim() || input.agent_id.length > 128) throw new Error('agent_id must be 1-128 characters.');
    if (!isValidNearAccountId(input.account_id)) throw new Error('account_id is not a valid NEAR account ID.');
    if (!isNearNetwork(input.network)) throw new Error('network must be near:testnet or near:mainnet.');
    const label = input.label?.trim() || input.account_id;
    if (label.length > 128) throw new Error('label must be at most 128 characters.');
    const existing = this.wallets.find((wallet) => wallet.agent_id === input.agent_id && wallet.account_id === input.account_id && wallet.network === input.network);
    const timestamp = new Date().toISOString();
    if (existing) {
      const previous = structuredClone(existing);
      Object.assign(existing, { label, active: true, updated_at: timestamp });
      try { this.persist(); } catch (error) { Object.assign(existing, previous); throw error; }
      return { wallet: structuredClone(existing), created: false };
    }
    const wallet: WatchedNearWallet = {
      id: `watch_${crypto.randomUUID()}`, agent_id: input.agent_id, account_id: input.account_id, network: input.network as WatchedNearNetwork,
      label, active: true, created_at: timestamp, updated_at: timestamp, last_scanned_height: null,
    };
    this.wallets.push(wallet);
    try { this.persist(); } catch (error) { this.wallets.pop(); throw error; }
    return { wallet: structuredClone(wallet), created: true };
  }

  deactivate(id: string): WatchedNearWallet | undefined {
    const wallet = this.wallets.find((item) => item.id === id);
    if (!wallet) return undefined;
    const previous = structuredClone(wallet);
    wallet.active = false;
    wallet.updated_at = new Date().toISOString();
    try { this.persist(); } catch (error) { Object.assign(wallet, previous); throw error; }
    return structuredClone(wallet);
  }

  list(agentId?: string): WatchedNearWallet[] {
    return this.wallets.filter((wallet) => agentId === undefined || wallet.agent_id === agentId).map((wallet) => structuredClone(wallet));
  }

  recentActivity(filters: { watch_id?: string; agent_id?: string; account_id?: string; limit?: number } = {}): WatchedNearActivity[] {
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
    return this.activity.filter((event) => (!filters.watch_id || event.watch_id === filters.watch_id)
      && (!filters.agent_id || event.agent_id === filters.agent_id) && (!filters.account_id || event.account_id === filters.account_id))
      .slice(-limit).reverse().map((event) => structuredClone(event));
  }

  activeByNetwork(): Map<WatchedNearNetwork, WatchedNearWallet[]> {
    const result = new Map<WatchedNearNetwork, WatchedNearWallet[]>();
    for (const wallet of this.wallets) {
      if (!wallet.active) continue;
      const group = result.get(wallet.network) ?? [];
      group.push(wallet);
      result.set(wallet.network, group);
    }
    return result;
  }

  advanceCursor(watchId: string, height: number): void {
    const wallet = this.wallets.find((item) => item.id === watchId);
    if (wallet && (wallet.last_scanned_height === null || height > wallet.last_scanned_height)) wallet.last_scanned_height = height;
  }

  addActivity(event: WatchedNearActivity): boolean {
    if (this.activity.some((item) => item.watch_id === event.watch_id && item.transaction_hash === event.transaction_hash)) return false;
    this.activity.push(event);
    const eventsForWallet = this.activity.filter((item) => item.watch_id === event.watch_id);
    if (eventsForWallet.length > 100) {
      const excess = eventsForWallet.length - 100;
      const oldIds = new Set(eventsForWallet.slice(0, excess).map((item) => item.id));
      this.activity = this.activity.filter((item) => !oldIds.has(item.id));
    }
    const wallet = this.wallets.find((item) => item.id === event.watch_id);
    if (wallet) wallet.last_tx_hint = `${event.block_height}:${event.transaction_hash}`;
    return true;
  }

  flush(): void { this.persist(); }
  get activityCount(): number { return this.activity.length; }
}

export interface NearWalletWatchStatus {
  healthy: boolean;
  running: boolean;
  interval_ms: number;
  watched_wallets: number;
  stored_activity: number;
  last_success_at?: string;
  last_error?: string;
  next_retry_at?: string;
}

type RpcFunction = (network: WatchedNearNetwork, method: string, params: Record<string, unknown>) => Promise<unknown>;
type AuditFunction = (type: string, payload: Record<string, unknown>) => void;

function normalizeTransactions(value: unknown): NormalizedChainTransaction[] {
  if (!value || typeof value !== 'object') return [];
  const result = value as { transactions?: unknown; receipts?: unknown };
  const transactions = Array.isArray(result.transactions) ? result.transactions : [];
  const receipts = Array.isArray(result.receipts) ? result.receipts : [];
  const normalizedTransactions = transactions.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const transaction = row as { hash?: unknown; signer_id?: unknown; receiver_id?: unknown; actions?: unknown };
    if (typeof transaction.hash !== 'string') return [];
    const actions = Array.isArray(transaction.actions) ? transaction.actions.flatMap((action) => action && typeof action === 'object' ? Object.keys(action as object) : []) : [];
    return [{ hash: transaction.hash, signer_id: typeof transaction.signer_id === 'string' ? transaction.signer_id : undefined,
      receiver_id: typeof transaction.receiver_id === 'string' ? transaction.receiver_id : undefined, action_kinds: actions }];
  });
  const normalizedReceipts = receipts.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const receipt = row as { receipt_id?: unknown; predecessor_id?: unknown; receiver_id?: unknown; receipt?: unknown };
    if (typeof receipt.receipt_id !== 'string') return [];
    const details = receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt as Record<string, unknown> : {};
    const actionReceipt = details.Action && typeof details.Action === 'object' ? details.Action as Record<string, unknown> : {};
    const actions = Array.isArray(actionReceipt.actions) ? actionReceipt.actions.flatMap((action) => action && typeof action === 'object' ? Object.keys(action as object) : []) : [];
    return [{ hash: receipt.receipt_id, signer_id: typeof receipt.predecessor_id === 'string' ? receipt.predecessor_id : undefined,
      receiver_id: typeof receipt.receiver_id === 'string' ? receipt.receiver_id : undefined, action_kinds: actions.length ? actions : ['receipt'] }];
  });
  return [...normalizedTransactions, ...normalizedReceipts];
}

export class NearWalletWatcher {
  readonly intervalMs: number;
  private readonly store: NearWalletWatchStore;
  private readonly rpc: RpcFunction;
  private readonly audit: AuditFunction;
  private readonly onActivity?: (activity: WatchedNearActivity) => void;
  private timer?: NodeJS.Timeout;
  private lastSuccessAt?: string;
  private lastError?: string;
  private nextRetryAt?: string;
  private failures = 0;
  private running = false;

  private emitAudit(type: string, payload: Record<string, unknown>): void {
    try { this.audit(type, payload); }
    catch (error) { this.lastError = error instanceof Error ? `Audit persistence failed: ${error.message}` : 'Wallet watch audit persistence failed.'; }
  }

  constructor(options: { store?: NearWalletWatchStore; intervalMs?: number; rpc?: RpcFunction; audit: AuditFunction; onActivity?: (activity: WatchedNearActivity) => void }) {
    this.intervalMs = options.intervalMs ?? Number(process.env.ASGUARD_WALLET_WATCH_INTERVAL_MS || 20_000);
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 5_000 || this.intervalMs > 300_000) throw new Error('ASGUARD_WALLET_WATCH_INTERVAL_MS must be 5000-300000.');
    this.store = options.store ?? new NearWalletWatchStore();
    this.rpc = options.rpc ?? ((network, method, params) => this.requestRpc(network, method, params));
    this.audit = options.audit;
    this.onActivity = options.onActivity;
  }

  private async requestRpc(network: WatchedNearNetwork, method: string, params: Record<string, unknown>): Promise<unknown> {
    const networkName = network.slice(5) as NearNetwork;
    const endpoint = networkName === nearAdapter.network ? nearAdapter.rpcUrl : `https://rpc.${networkName}.near.org`;
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Wallet watch RPC must use HTTPS.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'asguard-wallet-watch', method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}.`);
      const body = await response.json() as { result?: unknown; error?: { message?: string } };
      if (body.error || body.result === undefined) throw new Error(body.error?.message ?? 'NEAR RPC returned an invalid response.');
      return body.result;
    } finally { clearTimeout(timeout); }
  }

  async pollOnce(): Promise<void> {
    const groups = this.store.activeByNetwork();
    let succeeded = true;
    for (const [network, wallets] of groups) {
      try { await this.pollNetwork(network, wallets); }
      catch (error) {
        succeeded = false;
        const message = error instanceof Error ? error.message : 'NEAR wallet watch RPC failed.';
        this.lastError = message;
        this.emitAudit('wallet_watch_error', { network, error: message, watched_wallets: wallets.length });
      }
    }
    if (succeeded) {
      this.lastSuccessAt = new Date().toISOString();
      const recoveredError = this.lastError;
      if (recoveredError) this.emitAudit('wallet_watch_recovered', { previous_error: recoveredError });
      this.failures = this.lastError ? this.failures + 1 : 0;
      if (!this.lastError) this.nextRetryAt = undefined;
      else this.nextRetryAt = new Date(Date.now() + Math.min(this.intervalMs * 2 ** Math.min(this.failures, 5), 300_000)).toISOString();
    } else {
      this.failures += 1;
      const delay = Math.min(this.intervalMs * 2 ** Math.min(this.failures, 5), 300_000);
      this.nextRetryAt = new Date(Date.now() + delay).toISOString();
    }
  }

  private async pollNetwork(network: WatchedNearNetwork, wallets: WatchedNearWallet[]): Promise<void> {
    const status = await this.rpc(network, 'status', {});
    const chainId = (status as { chain_id?: unknown })?.chain_id;
    if (chainId !== network.slice(5)) throw new Error(`NEAR RPC network mismatch for ${network}.`);
    const head = await this.rpc(network, 'block', { finality: 'final' });
    const headHeight = (head as { header?: { height?: unknown } })?.header?.height;
    if (typeof headHeight !== 'number' || !Number.isSafeInteger(headHeight) || headHeight < 0) throw new Error('NEAR RPC block response has no valid height.');
    for (const wallet of wallets) {
      if (wallet.last_scanned_height === null) wallet.last_scanned_height = Math.max(0, headHeight - 10);
    }
    const maxBlocks = 100;
    const firstHeight = Math.min(...wallets.map((wallet) => (wallet.last_scanned_height ?? 0) + 1));
    const finalHeight = Math.min(headHeight, firstHeight + maxBlocks - 1);
    for (let height = firstHeight; height <= finalHeight; height += 1) {
      const block = await this.rpc(network, 'block', { block_id: height });
      const blockRecord = block as { header?: { height?: unknown }; chunks?: unknown };
      const chunks = Array.isArray(blockRecord.chunks) ? blockRecord.chunks as Array<{ chunk_hash?: unknown }> : [];
      const chunkTransactions = await Promise.all(chunks.filter((chunk) => typeof chunk.chunk_hash === 'string')
        .map((chunk) => this.rpc(network, 'chunk', { chunk_id: chunk.chunk_hash as string })));
      const transactions = chunkTransactions.flatMap(normalizeTransactions);
      for (const wallet of wallets) {
        if ((wallet.last_scanned_height ?? -1) >= height) continue;
        for (const transaction of transactions) {
          const outbound = transaction.signer_id === wallet.account_id;
          const inbound = transaction.receiver_id === wallet.account_id;
          if (!outbound && !inbound) continue;
          const activity: WatchedNearActivity = {
            id: `activity_${crypto.randomUUID()}`, watch_id: wallet.id, agent_id: wallet.agent_id, account_id: wallet.account_id,
            network, block_height: height, transaction_hash: transaction.hash, signer_id: transaction.signer_id,
            receiver_id: transaction.receiver_id, direction: outbound && inbound ? 'self' : outbound ? 'outbound' : 'inbound',
            action_kinds: transaction.action_kinds, observed_at: new Date().toISOString(),
          };
          if (this.store.addActivity(activity)) {
            this.emitAudit('wallet_watch_activity', { watch_id: wallet.id, agent_id: wallet.agent_id, account_id: wallet.account_id,
              network, block_height: height, transaction_hash: transaction.hash, direction: activity.direction, action_kinds: activity.action_kinds });
            try { this.onActivity?.(activity); } catch { /* dashboard notification must not stop public-chain scanning */ }
          }
        }
        this.store.advanceCursor(wallet.id, height);
      }
      this.store.flush();
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = async () => {
      if (!this.running) return;
      await this.pollOnce();
      if (this.running) {
        const delay = this.nextRetryAt ? Math.max(0, Date.parse(this.nextRetryAt) - Date.now()) : this.intervalMs;
        this.timer = setTimeout(run, delay);
      }
    };
    this.timer = setTimeout(run, 0);
  }

  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); }

  status(): NearWalletWatchStatus {
    return { healthy: !this.lastError, running: this.running, interval_ms: this.intervalMs, watched_wallets: this.store.list().filter((wallet) => wallet.active).length,
      stored_activity: this.store.activityCount, ...(this.lastSuccessAt ? { last_success_at: this.lastSuccessAt } : {}),
      ...(this.lastError ? { last_error: this.lastError } : {}), ...(this.nextRetryAt ? { next_retry_at: this.nextRetryAt } : {}) };
  }
}
