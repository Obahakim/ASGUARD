import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingSubmittedIntent } from './correlation';
import type { TransactionIntent } from '../types';

const intent = (overrides: Partial<TransactionIntent> = {}): TransactionIntent => ({
  id: 'intent-1', idempotency_key: 'idempotency-1', correlation_id: 'corr-1', agent_id: 'agent-a', wallet_id: 'watch-1',
  network: 'near:testnet', action: 'near-intent:token_diff', resource: 'alice.testnet', payload_hash: 'a'.repeat(64),
  status: 'submitted', risk_level: 'low', expires_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tx_hash: 'tx-1', ...overrides,
});

test('matches only submitted transactions for the same agent, network, and hash', () => {
  const activity = { agent_id: 'agent-a', network: 'near:testnet' as const, transaction_hash: 'tx-1' };
  assert.equal(findMatchingSubmittedIntent(activity, [intent()])?.id, 'intent-1');
  assert.equal(findMatchingSubmittedIntent(activity, [intent({ agent_id: 'agent-b' })]), undefined);
  assert.equal(findMatchingSubmittedIntent(activity, [intent({ network: 'near:mainnet' })]), undefined);
  assert.equal(findMatchingSubmittedIntent(activity, [intent({ status: 'approved' })]), undefined);
});