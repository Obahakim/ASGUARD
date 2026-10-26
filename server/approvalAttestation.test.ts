import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { assertApprovedThenSign, assertApprovedThenSignChainPayload, assertApprovedThenSignIntent, issueApprovalAttestation, verifyApprovalAttestation, withApprovedChainSignature, withApprovedNearIntent } from './approvalAttestation';
import { normalizeNearIntent } from './aos/nearIntent';

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

test('NEAR intent attestation binds canonical payload, domain, and derivation path', () => {
  const intent = {
    intent_type: 'swap',
    origin_asset: 'nep141:wrap.near',
    destination_asset: 'nep141:usdc.near',
    amount: '1000000',
    recipient: 'alice.near',
    destination_chain: 'near',
    max_slippage_bps: 100,
  };
  const normalized = normalizeNearIntent(intent);
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_near_1',
    intent_id: 'intent_near_1',
    agent_id: 'near-agent',
    network: 'near:mainnet',
    chain: 'near',
    payload_domain: 'near-intent',
    intent_type: 'swap',
    payload_hash: normalized.payloadHash,
    action: 'approve_once',
    max_amount_usd: 25,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0,
    rules_triggered: [],
    issued_at: new Date().toISOString(),
    secret: 'near-intent-test-key-with-more-than-32-bytes',
  });

  assert.equal(assertApprovedThenSignIntent(intent, attestation, {
    signingKey: 'near-intent-test-key-with-more-than-32-bytes',
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:mainnet',
    expectedVerifier: 'intents.near',
  }), true);
  assert.throws(() => assertApprovedThenSignIntent({ ...intent, recipient: 'mallory.near' }, attestation, {
    signingKey: 'near-intent-test-key-with-more-than-32-bytes',
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:mainnet',
    expectedVerifier: 'intents.near',
  }), /payload_hash_mismatch/);
});

test('Chain Signatures host verifier rejects a different derivation path', () => {
  const payload = 'unsigned foreign-chain transaction';
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_chain_sig',
    intent_id: 'intent_chain_sig',
    agent_id: 'chain-agent',
    network: 'ethereum:mainnet',
    chain: 'ethereum',
    payload_domain: 'near-chain-signature',
    derivation_path: 'ethereum-1',
    signer_contract: 'v1.signer',
    payload_hash: payloadHash,
    action: 'approve_once',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0,
    rules_triggered: [],
    issued_at: new Date().toISOString(),
    secret: 'chain-signature-test-key-with-32-bytes-min',
  });

  assert.throws(() => assertApprovedThenSignChainPayload(payload, attestation, {
    signingKey: 'chain-signature-test-key-with-32-bytes-min',
    derivationPath: 'ethereum-2',
    payloadDomain: 'near-chain-signature',
    expectedNetwork: 'ethereum:mainnet',
    expectedChain: 'ethereum',
    signerContract: 'v1.signer',
  }), /derivation_path_mismatch/);
});

test('NEAR host callback is not invoked until its exact attestation verifies', async () => {
  const intent = {
    intent_type: 'swap',
    origin_asset: 'nep141:wrap.near',
    destination_asset: 'nep141:usdc.near',
    amount: '1000000',
    recipient: 'alice.near',
    destination_chain: 'near',
    max_slippage_bps: 100,
  };
  const { normalizeNearIntent } = await import('./aos/nearIntent.js');
  const normalized = normalizeNearIntent(intent);
  const signingKey = 'host-callback-test-key-with-more-than-32-bytes';
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_host_callback',
    intent_id: 'intent_host_callback',
    agent_id: 'near-agent',
    network: 'near:testnet',
    chain: 'near',
    payload_domain: 'near-intent',
    intent_type: 'swap',
    payload_hash: normalized.payloadHash,
    action: 'approve_once',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0,
    rules_triggered: [],
    issued_at: new Date().toISOString(),
    secret: signingKey,
  });
  let callbackCalled = false;
  let originalPayload: unknown;
  const execute = async (bytes: string, _intent: unknown, original: unknown) => {
    callbackCalled = true;
    originalPayload = original;
    return bytes;
  };

  await assert.rejects(() => withApprovedNearIntent({ ...intent, recipient: 'mallory.near' }, attestation, {
    signingKey,
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:testnet',
    expectedVerifier: 'intents.near',
  }, execute), /payload_hash_mismatch/);
  assert.equal(callbackCalled, false);

  const bytes = await withApprovedNearIntent(intent, attestation, {
    signingKey,
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:testnet',
    expectedVerifier: 'intents.near',
  }, execute);
  assert.equal(bytes, normalized.canonicalBytes);
  assert.equal(callbackCalled, true);
  assert.equal(originalPayload, intent);
});

test('Chain Signatures host callback is not invoked for a different payload path', async () => {
  const payload = 'unsigned foreign-chain payload';
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const signingKey = 'chain-callback-test-key-with-more-than-32-bytes';
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_chain_callback',
    intent_id: 'intent_chain_callback',
    agent_id: 'chain-agent',
    network: 'ethereum:mainnet',
    chain: 'ethereum',
    payload_domain: 'near-chain-signature',
    derivation_path: 'ethereum-1',
    signer_contract: 'v1.signer',
    payload_hash: payloadHash,
    action: 'approve_once',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0,
    rules_triggered: [],
    issued_at: new Date().toISOString(),
    secret: signingKey,
  });
  let called = false;
  const requestSignature = async (approvedPayload: string | Uint8Array) => { called = true; return approvedPayload; };
  const params = {
    derivationPath: 'ethereum-2',
    payloadDomain: 'near-chain-signature',
    expectedNetwork: 'ethereum:mainnet',
    expectedChain: 'ethereum',
    signerContract: 'v1.signer',
    signingKey,
    expectedAgentId: 'chain-agent',
  };

  await assert.rejects(() => withApprovedChainSignature(payload, attestation, params, requestSignature), /derivation_path_mismatch/);
  assert.equal(called, false);
});
