import type { ChainHealth } from './chainHealth';
import { nearAdapter, type NearAdapter } from './nearAdapter';

export interface ApprovalOnlyAdapter {
	readonly chain: string;
	readonly network: string;
	readonly approvalOnly: true;
	health(): Promise<ChainHealth>;
}

export type RegisteredChainAdapter = NearAdapter;

export class ChainRegistry {
	private readonly adapters = new Map<string, RegisteredChainAdapter>();
	private readonly defaultAdapter: RegisteredChainAdapter;

	constructor(defaultAdapter: RegisteredChainAdapter = nearAdapter) {
		this.defaultAdapter = defaultAdapter;
		this.register('near', defaultAdapter);
	}

	register(id: string, adapter: RegisteredChainAdapter): void {
		this.adapters.set(id.toLowerCase(), adapter);
		this.adapters.set(`${adapter.chain}:${adapter.network}`.toLowerCase(), adapter);
	}

	resolve(chain?: string, network?: string): RegisteredChainAdapter | ApprovalOnlyAdapter {
		if (!chain) return this.defaultAdapter;
		const [namespace, parsedNetwork] = chain.split(':', 2);
		const targetChain = namespace.trim().toLowerCase();
		const targetNetwork = network ?? parsedNetwork ?? (targetChain === 'near' ? this.defaultAdapter.network : 'unspecified');
		const adapter = this.adapters.get(`${targetChain}:${targetNetwork}`.toLowerCase());
		if (adapter) return adapter;
		if (targetChain === 'near' && targetNetwork === this.defaultAdapter.network) return this.defaultAdapter;
		return {
			chain: targetChain,
			network: targetNetwork,
			approvalOnly: true,
			async health() {
				return { chain: targetChain, network: targetNetwork, healthy: false, error: 'No target adapter registered; approval-only mode.' };
			},
		};
	}
}

export const chainRegistry = new ChainRegistry();
