import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNearTransferPolicy, normalizeNearTransfer } from './nearTransfer';

const transfer = { sender: 'sender.testnet', receiver: 'receiver.testnet', amount: '1000000000000000000000' };

test('canonicalizes only bounded NEAR transfer terms and hashes canonical JSON', () => {
  const normalized = normalizeNearTransfer(transfer);
  assert.deepEqual(normalized.transfer, transfer);
  assert.equal(normalized.canonicalBytes, JSON.stringify(transfer));
  assert.equal(normalizeNearTransfer({ amount: transfer.amount, receiver: transfer.receiver, sender: transfer.sender }).payloadHash, normalized.payloadHash);
});

test('rejects opaque, extra, malformed, and unbounded transfer terms', () => {
  for (const value of [
    'sender.testnet,receiver.testnet,1',
    { ...transfer, memo: 'opaque' },
    { ...transfer, sender: 'Bad Account' },
    { ...transfer, amount: '01' },
    { ...transfer, amount: '0' },
    { ...transfer, amount: '1'.repeat(79) },
  ]) assert.throws(() => normalizeNearTransfer(value));
});

test('NEAR transfer policy enforces recipient allowlists and USD caps', () => {
  const policy = {
    max_auto_trade_usd: 10, strict_anomaly_detection: true, device_ip_lock: true,
    remote_trigger_protection: true, active_llm_engine: 'ollama' as const,
    allowed_destinations: ['receiver.testnet'], denied_destinations: [],
  };
  assert.deepEqual(evaluateNearTransferPolicy(transfer, policy, 5), {
    blockedReasons: [], humanReviewReasons: ['near_transfer_requires_human_review'],
  });
  assert.ok(evaluateNearTransferPolicy(transfer, policy, 15).blockedReasons.includes('budget_overrun'));
  assert.ok(evaluateNearTransferPolicy({ ...transfer, receiver: 'other.testnet' }, policy, 5).humanReviewReasons.includes('destination_not_allowlisted'));
  assert.ok(evaluateNearTransferPolicy(transfer, policy).humanReviewReasons.includes('usd_value_unverified'));
});
