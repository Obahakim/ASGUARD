import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertApprovedThenSign, assertApprovedThenSignChainPayload, assertApprovedThenSignIntent, issueApprovalAttestation, verifyApprovalAttestation, withApprovedChainSignature, withApprovedNearIntent } from './approvalAttestation';
import { validateApprovalKeyPair } from './attestationConfig';
import { normalizeNearIntent } from './aos/nearIntent';

const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey;
const publicKey = pair.publicKey;

test('server accepts only a matching Ed25519 attestation keypair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'asguard-attestation-key-test-'));
  const privatePath = join(directory, 'private.pem');
  const publicPath = join(directory, 'public.pem');
  const otherPublicPath = join(directory, 'other-public.pem');
  writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(otherPublicPath, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  try {
    assert.doesNotThrow(() => validateApprovalKeyPair(privatePath, publicPath));
    assert.throws(() => validateApprovalKeyPair(privatePath, otherPublicPath), /do not match/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('approval attestation round-trips and verifies', () => {
  const attestation = issueApprovalAttestation({
    decision_id: 'dec_1',
    intent_id: 'intent_1',
    agent_id: 'agent_a',
    network: 'ethereum:mainnet',
    payload_hash: 'a'.repeat(64),
    action: 'approve_once',
    max_amount_usd: 250,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 42,
    issued_at: new Date().toISOString(),
    rules_triggered: [{ rule_id: 'frequency_spike', severity: 'medium', score_contribution: 25 }],
    policy_version: '1.0.0',
    privateKey,
  });

  const verification = verifyApprovalAttestation(attestation, {
    publicKey,
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
    privateKey,
  });

  const valid = verifyApprovalAttestation(matching, {
    publicKey,
    expectedAgentId: 'agent_b',
    expectedPayloadHash: 'b'.repeat(64),
    now: new Date(),
  });
  assert.equal(valid.valid, true);

  const attackerPublicKey = generateKeyPairSync('ed25519').publicKey;
  assert.deepEqual(verifyApprovalAttestation(matching, { publicKey: attackerPublicKey }), { valid: false, reason: 'signature_mismatch' });
  assert.deepEqual(verifyApprovalAttestation(matching, {
    publicKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }), { valid: false, reason: 'invalid_public_key' });
  assert.throws(() => issueApprovalAttestation({
    decision_id: 'dec_audit_key', intent_id: 'intent_audit_key', agent_id: 'agent_a', network: 'near:testnet',
    payload_hash: 'e'.repeat(64), action: 'approve_once', expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0, issued_at: new Date().toISOString(), rules_triggered: [],
    privateKey: 'not-an-ed25519-private-key-or-audit-hmac-secret',
  }), /Ed25519 private key/i);

  assert.throws(() => {
    assertApprovedThenSign('hello', matching, { publicKey, expectedAgentId: 'agent_b', expectedPayloadHash: 'b'.repeat(64) });
  }, /ASGUARD attestation rejected/i);
});

test('expired approval is rejected', () => {
  const expired = issueApprovalAttestation({
    decision_id: 'dec_3',
    intent_id: 'intent_3',
    agent_id: 'agent_c',
    network: 'ethereum:mainnet',
    payload_hash: 'c'.repeat(64),
    action: 'approve_session',
    expires_at: new Date(Date.now() - 1000).toISOString(),
    anomaly_score: 3,
    issued_at: new Date(Date.now() - 10_000).toISOString(),
    rules_triggered: [],
    privateKey,
  });

  const result = verifyApprovalAttestation(expired, {
    publicKey,
    now: new Date(),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'expired');
});

test('host amount ceiling accepts amounts within the cap and rejects higher HITL amounts', () => {
  const issue = (amount?: number) => issueApprovalAttestation({
    decision_id: `dec_amount_${amount ?? 'missing'}`,
    intent_id: `intent_amount_${amount ?? 'missing'}`,
    agent_id: 'amount-agent',
    network: 'near:testnet',
    chain: 'near',
    payload_domain: 'near-intent',
    payload_hash: 'd'.repeat(64),
    action: 'approve_once',
    ...(amount === undefined ? {} : { max_amount_usd: amount }),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    anomaly_score: 0,
    issued_at: new Date().toISOString(),
    rules_triggered: [],
    privateKey,
  });
  const verify = (maxAmountUsd: number | undefined) => verifyApprovalAttestation(issue(maxAmountUsd), {
    publicKey,
    expectedAgentId: 'amount-agent',
    maxAmountUsd: 1_000,
  });

  assert.equal(verify(750).valid, true);
  assert.equal(verify(1_000).valid, true);
  assert.deepEqual(verify(1_250), { valid: false, reason: 'attested_amount_exceeds_host_limit' });
  assert.deepEqual(verify(undefined), { valid: false, reason: 'attested_amount_limit_missing' });
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
    privateKey,
  });

  assert.equal(assertApprovedThenSignIntent(intent, attestation, {
    publicKey,
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:mainnet',
    expectedVerifier: 'intents.near',
  }), true);
  assert.throws(() => assertApprovedThenSignIntent({ ...intent, recipient: 'mallory.near' }, attestation, {
    publicKey,
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
    privateKey,
  });

  assert.throws(() => assertApprovedThenSignChainPayload(payload, attestation, {
    publicKey,
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
    privateKey,
  });
  let callbackCalled = false;
  let originalPayload: unknown;
  const execute = async (bytes: string, _intent: unknown, original: unknown) => {
    callbackCalled = true;
    originalPayload = original;
    return bytes;
  };

  await assert.rejects(() => withApprovedNearIntent({ ...intent, recipient: 'mallory.near' }, attestation, {
    publicKey,
    expectedAgentId: 'near-agent',
    expectedNetwork: 'near:testnet',
    expectedVerifier: 'intents.near',
  }, execute), /payload_hash_mismatch/);
  assert.equal(callbackCalled, false);

  const bytes = await withApprovedNearIntent(intent, attestation, {
    publicKey,
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
    privateKey,
  });
  let called = false;
  const requestSignature = async (approvedPayload: string | Uint8Array) => { called = true; return approvedPayload; };
  const params = {
    derivationPath: 'ethereum-2',
    payloadDomain: 'near-chain-signature',
    expectedNetwork: 'ethereum:mainnet',
    expectedChain: 'ethereum',
    signerContract: 'v1.signer',
    publicKey,
    expectedAgentId: 'chain-agent',
  };

  await assert.rejects(() => withApprovedChainSignature(payload, attestation, params, requestSignature), /derivation_path_mismatch/);
  assert.equal(called, false);
});
