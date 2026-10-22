import type { ChainAdapter, ChainHealth } from './chainAdapter';
import { solanaAdapter } from './chainAdapter';

export interface ApprovalOnlyAdapter { readonly chain: string; readonly network: string; readonly approvalOnly: true; health(): Promise<ChainHealth>; }
const noop: ApprovalOnlyAdapter = { chain: 'unknown', network: 'unknown', approvalOnly: true, async health(){return {chain:this.chain,network:this.network,healthy:false,error:'No adapter registered; approval only.'}} };
export class ChainRegistry {
 private adapters = new Map<string, ChainAdapter>(); private defaultKey?: string = process.env.ASGUARD_DEFAULT_CHAIN?.trim().toLowerCase();
 register(id: string, adapter: ChainAdapter, isDefault = false): void { this.adapters.set(id.toLowerCase(), adapter); this.adapters.set(`${adapter.chain}:${adapter.network}`.toLowerCase(), adapter); if(isDefault && !this.defaultKey)this.defaultKey=id.toLowerCase(); }
 resolve(chain?: string, network?: string): ChainAdapter | ApprovalOnlyAdapter { if(chain?.includes(':')&&!network){const [c,n]=chain.split(':',2);return this.adapters.get(`${c}:${n}`.toLowerCase())??this.adapters.get(c.toLowerCase())??this.fallback()} if(chain&&network){const found=this.adapters.get(`${chain}:${network}`.toLowerCase());if(found)return found;return this.fallback()} if(chain){const found=this.adapters.get(chain.toLowerCase());if(found)return found;return this.fallback()} const fallback=this.defaultKey?this.adapters.get(this.defaultKey):undefined;return fallback??this.fallback(); }
 private fallback(): ApprovalOnlyAdapter { return noop; }
}
export const chainRegistry = new ChainRegistry();
chainRegistry.register('solana', solanaAdapter);
