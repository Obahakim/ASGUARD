import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { issueApprovalAttestation } from '../server/approvalAttestation';
import { normalizeNearIntent } from '../server/aos/nearIntent';
import type { ApprovalAttestation, SignApprovalResponse } from '../server/types';
import { AsguardApprovalError, withAsguardApproval } from './index';

const key = 'agent-sdk-test-signing-key-long-enough-0001';
const intent = {
  intent_type: 'token_diff', origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:usdc.near',
  amount: '1000000000000000000000', min_output_amount: '1', recipient: 'alice.near', destination_chain: 'near',
  deadline: new Date(Date.now() + 60_000).toISOString(), max_slippage_bps: 50,
};

function approvedResponse(): SignApprovalResponse {
  const normalized = normalizeNearIntent(intent);
  const attestation = issueApprovalAttestation({
    decision_id: randomUUID(), intent_id: randomUUID(), agent_id: 'test-agent', payload_hash: normalized.payloadHash,
    network: 'near:testnet', chain: 'near', payload_domain: 'near-intent', intent_type: 'token_diff', action: 'approve_once',
    expires_at: new Date(Date.now() + 60_000).toISOString(), issued_at: new Date().toISOString(), anomaly_score: 1,
    rules_triggered: [], secret: key,
  });
  return { status: 'approved', intent_id: attestation.intent_id, decision_id: attestation.decision_id, attestation };
}

function options(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://localhost:8080', token: 'runtime-token-that-is-at-least-32-bytes-long', agentId: 'test-agent',
    agentName: 'Test Agent', payload: intent, payloadDomain: 'near-intent' as const, network: 'near:testnet',
    expectedVerifier: 'intents.near', idempotencyKey: randomUUID(), riskLevel: 'low' as const,
    auditKey: key, fetchImpl, ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('calls the host callback only after a successful REST approval and attestation verification', async () => {
  const decision = approvedResponse();
  let callbackCount = 0;
  const result = await withAsguardApproval(options(async (input, init) => {
    assert.equal(input, 'http://localhost:8080/api/approvals/near-intent');
    assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer /);
    return jsonResponse(decision);
  }), async (context) => {
    callbackCount += 1;
    assert.equal(context.attestation.payload_hash, decision.attestation?.payload_hash);
    assert.equal(context.decision.status, 'approved');
    return 'verified';
  });
  assert.equal(result, 'verified');
  assert.equal(callbackCount, 1);
});

test('bad attestation is rejected without invoking the host callback', async () => {
  const decision = approvedResponse();
  (decision.attestation as ApprovalAttestation).signature = '0'.repeat(64);
  let callbackCount = 0;
  await assert.rejects(withAsguardApproval(options(async () => jsonResponse(decision)), async () => {
    callbackCount += 1;
  }), /attestation verification failed/i);
  assert.equal(callbackCount, 0);
});

test('HITL timeout denies and never invokes the host callback', async () => {
  let calls = 0;
  let callbackCount = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ status: 'pending_hitl', request_id: 'req-test', intent_id: 'intent-test' });
  };
  await assert.rejects(withAsguardApproval(options(fetchImpl, { timeoutMs: 200, pollIntervalMs: 100 }), async () => {
    callbackCount += 1;
  }), (error: unknown) => error instanceof AsguardApprovalError && error.status === 'timeout_deny');
  assert.ok(calls >= 2);
  assert.equal(callbackCount, 0);
});
