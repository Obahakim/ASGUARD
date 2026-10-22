import test from 'node:test';
import assert from 'node:assert/strict';

import { assertApprovedThenSign, issueApprovalAttestation, verifyApprovalAttestation } from './approvalAttestation';

test('approval attestation round-trips and verifies', () => {
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_1',
    intent_id: 'intent_1',
    agent_id: 'agent_a',
    network: 'solana:devnet',
    payload_hash: 'a'.repeat(64),
    action: 'approve_once',
    max_amount_usd: 250,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 42,
    issued_at: new Date().toISOString(),
    rules_triggered: [{ rule_id: 'frequency_spike', severity: 'medium', score_contribution: 25 }],
    policy_version: '1.0.0',
    secret: 'a-long-enough-test-secret-key-1234567890',
  });

  const verification = verifyApprovalAttestation(attestation, {
    signingKey: 'a-long-enough-test-secret-key-1234567890',
    bytesToSign: 'hello world',
    expectedAgentId: 'agent_a',
    expectedPayloadHash: 'a'.repeat(64),
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.reason, 'bytes_to_sign_hash_mismatch');

  const matching = issueApprovalAttestation({
    decision_id: 'dec_2',
    intent_id: 'intent_2',
    agent_id: 'agent_b',
    network: 'ethereum:mainnet',
    payload_hash: 'b'.repeat(64),
    action: 'approve_once',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 18,
    issued_at: new Date().toISOString(),
    rules_triggered: [],
    secret: 'another-long-enough-key-value-here-123456',
  });

  const valid = verifyApprovalAttestation(matching, {
    signingKey: 'another-long-enough-key-value-here-123456',
    expectedAgentId: 'agent_b',
    expectedPayloadHash: 'b'.repeat(64),
    now: new Date(),
  });
  assert.equal(valid.valid, true);

  assert.throws(() => {
    assertApprovedThenSign('hello', matching, { signingKey: 'another-long-enough-key-value-here-123456', expectedAgentId: 'agent_b', expectedPayloadHash: 'b'.repeat(64) });
  }, /ASGUARD attestation rejected/i);
});

test('expired approval is rejected', () => {
  const expired = issueApprovalAttestation({
    decision_id: 'dec_3',
    intent_id: 'intent_3',
    agent_id: 'agent_c',
    network: 'solana:devnet',
    payload_hash: 'c'.repeat(64),
    action: 'approve_session',
    expires_at: new Date(Date.now() - 1000).toISOString(),
    anomaly_score: 3,
    issued_at: new Date(Date.now() - 10_000).toISOString(),
    rules_triggered: [],
    secret: 'zzz-very-long-test-secret-key-should-work-123',
  });

  const result = verifyApprovalAttestation(expired, {
    signingKey: 'zzz-very-long-test-secret-key-should-work-123',
    now: new Date(),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});
