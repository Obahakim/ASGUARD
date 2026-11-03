import type { TransactionIntent } from '../types';
import type { WatchedNearActivity } from '../nearWalletWatch';

export function findMatchingSubmittedIntent(
  activity: Pick<WatchedNearActivity, 'agent_id' | 'network' | 'transaction_hash'>,
  intents: TransactionIntent[]
): TransactionIntent | undefined {
  return intents.find((intent) => intent.agent_id === activity.agent_id
    && intent.network === activity.network
    && intent.tx_hash === activity.transaction_hash
    && ['submitted', 'confirmed'].includes(intent.status));
}