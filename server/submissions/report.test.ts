import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmissionReport } from './report';
import type { TransactionIntent } from '../types';

const approvedIntent = (overrides: Partial<TransactionIntent> = {}): TransactionIntent => ({
  id: 'intent-1', idempotency_key: 'idempotency-1', correlation_id: 'corr-1', agent_id: 'agent-a', wallet_id: 'watch-1',
  network: 'near:testnet', action: 'near-intent:token_diff', resource: 'alice.testnet', payload_hash: 'a'.repeat(64),
  status: 'approved', risk_level: 'low', expires_at: new Date(Date.now() + 60_000).toISOString(),
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides,
});

const report = { intent_id: 'intent-1', payload_hash: 'a'.repeat(64), tx_hash: '1'.repeat(43) };

test('accepts a host report only for the matching approved testnet intent', () => {
  assert.deepEqual(validateSubmissionReport(report, approvedIntent()), report);
});

test('rejects unapproved, mismatched, non-testnet, and malformed submissions', () => {
  assert.throws(() => validateSubmissionReport(report, undefined), /not found/i);
  assert.throws(() => validateSubmissionReport(report, approvedIntent({ status: 'pending_hitl' })), /must be approved/i);
  assert.throws(() => validateSubmissionReport({ ...report, payload_hash: 'b'.repeat(64) }, approvedIntent()), /does not match/i);
  assert.throws(() => validateSubmissionReport(report, approvedIntent({ network: 'near:mainnet' })), /testnet only/i);
  assert.throws(() => validateSubmissionReport({ ...report, tx_hash: 'not-a-hash' }, approvedIntent()), /transaction hash/i);
});

test('an identical already-recorded transaction report is idempotent', () => {
  assert.deepEqual(validateSubmissionReport(report, approvedIntent({ status: 'submitted', tx_hash: report.tx_hash })), report);
  assert.throws(() => validateSubmissionReport({ ...report, tx_hash: '2'.repeat(43) }, approvedIntent({ status: 'submitted', tx_hash: report.tx_hash })), /must be approved/i);
});