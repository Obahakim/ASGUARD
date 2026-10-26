export interface ChainHealth {
  chain: string;
  network: string;
  healthy: boolean;
  error?: string;
}
