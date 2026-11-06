export type TidepoolDemoMode = 'approve' | 'tamper' | 'onchain';

export function resolveTidepoolMode(value?: string): TidepoolDemoMode {
  const mode = value || 'approve';
  if (mode === 'approve' || mode === 'tamper' || mode === 'onchain') return mode;
  throw new Error('Usage: npm run demo:near:tidepool:approve | npm run demo:near:tidepool:tamper | npm run demo:onchain.');
}
