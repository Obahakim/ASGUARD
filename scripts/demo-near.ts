import { randomUUID } from 'node:crypto';
import { withAsguardApproval } from '../agent-sdk/index';

type Mode = 'approve' | 'hitl' | 'block';

function runtimeToken(): string | undefined {
  if (process.env.ASGUARD_DEMO_TOKEN) return process.env.ASGUARD_DEMO_TOKEN;
  try {
    const credentials = JSON.parse(process.env.ASGUARD_API_CREDENTIALS ?? '[]') as Array<{ token?: string; roles?: string[] }>;
    return credentials.find((item) => item.roles?.includes('runtime'))?.token;
  } catch {
    return undefined;
  }
}

const token = runtimeToken();
const auditKey = process.env.ASGUARD_AUDIT_KEY;
const baseUrl = process.env.ASGUARD_API_URL || `http://localhost:${process.env.ASGUARD_PORT || '8080'}`;
if (!token || Buffer.byteLength(token, 'utf8') < 32) throw new Error('Configure ASGUARD_DEMO_TOKEN or a runtime credential in ASGUARD_API_CREDENTIALS (at least 32 bytes).');
if (!auditKey || Buffer.byteLength(auditKey, 'utf8') < 32) throw new Error('Configure ASGUARD_AUDIT_KEY for host-side attestation verification.');
const requiredToken = token;
const requiredAuditKey = auditKey;

const mode = (process.argv[2] || 'approve') as Mode;
if (!['approve', 'hitl', 'block'].includes(mode)) throw new Error('Usage: demo-near.ts [approve|hitl|block].');

const network = `near:${process.env.ASGUARD_NEAR_NETWORK || 'testnet'}`;
const verifier = process.env.ASGUARD_NEAR_INTENTS_VERIFIER || 'intents.near';
const agentId = process.env.ASGUARD_DEMO_AGENT_ID || `near-demo-${mode}`;
const intent = {
  intent_type: 'token_diff', origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:usdt.tether-token.near',
  amount: '1000000000000000000000000', min_output_amount: '1', recipient: 'demo.near', destination_chain: 'near',
  deadline: new Date(Date.now() + 10 * 60_000).toISOString(), max_slippage_bps: 100,
};

async function blockExpiredIntent(): Promise<void> {
  const expired = { ...intent, deadline: new Date(Date.now() - 1_000).toISOString() };
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/approvals/near-intent`, {
    method: 'POST', headers: { Authorization: `Bearer ${requiredToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, agent_name: 'ASGUARD Judge Demo', risk_level: 'low', idempotency_key: randomUUID(), near_intent: expired }),
  });
  const body = await response.json() as { status?: string; request_id?: string; reason?: string; preflight?: { status?: string; reasons?: string[] } };
  console.log(JSON.stringify({ request_id: body.request_id ?? null, status: body.status ?? 'rejected', preflight: body.preflight ?? { status: 'decode_rejected', reasons: [body.reason ?? `HTTP ${response.status}`] } }, null, 2));
  if (response.ok || body.status !== 'rejected') throw new Error('Expired NEAR intent was not rejected.');
}

async function main(): Promise<void> {
  if (mode === 'block') return blockExpiredIntent();
  console.log(`Submitting exact NEAR Intent to ${baseUrl}; network=${network}; mode=${mode}. No signing or submission will occur.`);
  try {
    await withAsguardApproval({
      baseUrl, token: requiredToken, auditKey: requiredAuditKey, agentId, agentName: 'ASGUARD Judge Demo', payload: intent, payloadDomain: 'near-intent',
      network, expectedVerifier: verifier, idempotencyKey: randomUUID(), riskLevel: mode === 'hitl' ? 'high' : 'low',
      expectedMaxAmountUsd: 1_000, pollIntervalMs: 1_000, timeoutMs: 300_000,
      onPendingHitl: (requestId) => console.log(`request_id=${requestId} status=pending_hitl; resolve it in the authenticated dashboard.`),
    }, ({ attestation, canonicalPayload, decision }) => {
      console.log(JSON.stringify({ request_id: decision.requestId ?? null, status: 'approved', preflight: decision.preflight ?? null, payload_hash: attestation.payload_hash }, null, 2));
      console.log('Verified host callback reached. This demo deliberately performs no signing or submission.');
      return { schema: (canonicalPayload as { schema?: string }).schema, verified: true };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ status: error instanceof Error && 'status' in error ? (error as { status?: string }).status ?? 'rejected' : 'rejected', reason, callback: 'not_called' }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
