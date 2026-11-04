import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { issueApprovalAttestation } from '../server/approvalAttestation';
import { normalizeNearIntent } from '../server/aos/nearIntent';
import type { ApprovalAttestation, SignApprovalResponse } from '../server/types';
import { AsguardApprovalError, AsguardReportError, connectAgent, reportSubmission, withAsguardApproval } from './index';
import { normalizeNearTransfer } from '../server/aos/nearTransfer';

const pair = generateKeyPairSync('ed25519');
const privateKey = pair.privateKey;
const attestationPublicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
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
    rules_triggered: [], privateKey,
  });
  return { status: 'approved', intent_id: attestation.intent_id, decision_id: attestation.decision_id, attestation };
}

function approvedTransferResponse(payload: unknown): SignApprovalResponse {
  const normalized = normalizeNearTransfer(payload);
  const attestation = issueApprovalAttestation({
    decision_id: randomUUID(), intent_id: randomUUID(), agent_id: 'test-agent',
    payload_hash: normalized.payloadHash, network: 'near:testnet', chain: 'near',
    payload_domain: 'near-transfer', action: 'approve_once', expires_at: new Date(Date.now() + 60_000).toISOString(),
    issued_at: new Date().toISOString(), anomaly_score: 1, rules_triggered: [], privateKey,
  });
  return { status: 'approved', intent_id: attestation.intent_id, decision_id: attestation.decision_id, attestation };
}

function options(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://localhost:8080', token: 'runtime-token-that-is-at-least-32-bytes-long', agentId: 'test-agent',
    agentName: 'Test Agent', payload: intent, payloadDomain: 'near-intent' as const, network: 'near:testnet',
    expectedVerifier: 'intents.near', idempotencyKey: randomUUID(), riskLevel: 'low' as const,
    attestationPublicKey, fetchImpl, ...overrides,
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

test('near transfer callback receives only the exact approved testnet transfer description', async () => {
  const payload = { sender: 'sender.testnet', receiver: 'receiver.testnet', amount: '1000000000000000000000' };
  const decision = approvedTransferResponse(payload);
  let callbackCount = 0;
  await withAsguardApproval(options(async (input, init) => {
    assert.equal(input, 'http://localhost:8080/api/approvals/sign-request');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.network, 'near:testnet');
    assert.equal(body.payload_domain, 'near-transfer');
    assert.deepEqual(body.transfer, payload);
    assert.equal(body.payload_hash, normalizeNearTransfer(payload).payloadHash);
    return jsonResponse(decision);
  }, { payload, payloadDomain: 'near-transfer', expectedVerifier: undefined }), async ({ canonicalPayload }) => {
    callbackCount += 1;
    assert.deepEqual(canonicalPayload, payload);
  });
  assert.equal(callbackCount, 1);
});

test('connectAgent registers watched public accounts through the SDK', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await connectAgent({
    baseUrl: 'http://localhost:8080', token: 'runtime-token-that-is-at-least-32-bytes-long',
    agentId: 'test-agent', agentName: 'Test Agent', network: 'near:testnet',
    accountIds: ['sender.testnet'],
    fetchImpl: async (input, init) => {
      assert.equal(input, 'http://localhost:8080/api/agents/connect');
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ success: true, agent_id: 'test-agent', accounts: [{ account_id: 'sender.testnet' }] });
    },
  });
  assert.deepEqual(requestBody?.account_ids, ['sender.testnet']);
  assert.equal(result.success, true);
});

test('connectAgent accepts bracketed IPv6 loopback with the stub fetch', async () => {
  let requested = '';
  const response = await connectAgent({
    baseUrl: 'http://[::1]:8080', token: 't'.repeat(32), agentId: 'agent-one', agentName: 'Agent One',
    network: 'near:testnet', accountIds: ['agent.testnet'],
    fetchImpl: async (input) => {
      requested = String(input);
      return jsonResponse({ success: true, agent_id: 'agent-one', accounts: ['agent.testnet'] });
    },
  });
  assert.equal(requested, 'http://[::1]:8080/api/agents/connect');
  assert.equal(response.success, true);
});

test('reportSubmission reports verified transaction details and keeps errors secret-safe', async () => {
  const base = {
    baseUrl: 'http://[::1]:8080', token: 'report-token-not-for-errors-123456', intentId: 'intent-one',
    payloadHash: 'a'.repeat(64), txHash: '1'.repeat(43),
  };
  let requestBody = '';
  const result = await reportSubmission({ ...base, fetchImpl: async (input, init) => {
    assert.equal(String(input), `${base.baseUrl}/api/submissions/report`);
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${base.token}`);
    requestBody = String(init?.body);
    return jsonResponse({ intent: { status: 'submitted', tx_hash: base.txHash } });
  } });
  assert.deepEqual(result, { status: 'submitted', txHash: base.txHash });
  assert.deepEqual(JSON.parse(requestBody), { intent_id: base.intentId, payload_hash: base.payloadHash, tx_hash: base.txHash });

  for (const status of [400, 500]) {
    await assert.rejects(reportSubmission({ ...base, fetchImpl: async () => jsonResponse({ error: `server rejected ${base.token}` }, status) }), (error: unknown) => {
      assert.equal(error instanceof AsguardReportError, true);
      assert.equal((error as Error).message.includes(base.token), false);
      assert.equal((error as AsguardReportError).status, status);
      assert.equal((error as AsguardReportError).txHash, base.txHash);
      assert.equal((error as Error).message.includes('Authorization'), false);
      return true;
    });
  }

  let calls = 0;
  for (const invalid of [{ txHash: 'bad' }, { payloadHash: 'bad' }] as const) {
    await assert.rejects(reportSubmission({ ...base, ...invalid, fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  }
  assert.equal(calls, 0);
  await assert.rejects(reportSubmission({ ...base, baseUrl: 'http://example.com', fetchImpl: async () => { calls += 1; return jsonResponse({}); } }));
  assert.equal(calls, 0);
});

test('reportSubmission converts request timeout into a safe SDK error', async () => {
  const options = {
    baseUrl: 'http://localhost:8080', token: 'report-token-not-for-errors-123456', intentId: 'intent-one',
    payloadHash: 'a'.repeat(64), txHash: '1'.repeat(43), timeoutMs: 100,
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')), { once: true });
    }),
  };
  await assert.rejects(reportSubmission(options), (error: unknown) => {
    assert.equal(error instanceof AsguardReportError, true);
    assert.match((error as Error).message, /timed out/i);
    assert.equal((error as Error).message.includes(options.token), false);
    return true;
  });
});

test('HITL timeout denies and never invokes the host callback', async () => {
  let calls = 0;
  let callbackCount = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ status: 'pending_hitl', request_id: 'req-test', intent_id: 'intent-test' });
  };
  await assert.rejects(withAsguardApproval(options(fetchImpl, { timeoutMs: 1_500, pollIntervalMs: 100 }), async () => {
    callbackCount += 1;
  }), (error: unknown) => error instanceof AsguardApprovalError && error.status === 'timeout_deny');
  assert.ok(calls >= 2);
  assert.equal(callbackCount, 0);
});
