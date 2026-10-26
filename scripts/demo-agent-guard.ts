import { randomUUID } from 'node:crypto';
import { withAsguardApproval } from '../agent-sdk/index';

function getRuntimeToken(): string | undefined {
  if (process.env.ASGUARD_DEMO_TOKEN) return process.env.ASGUARD_DEMO_TOKEN;
  try {
    const credentials = JSON.parse(process.env.ASGUARD_API_CREDENTIALS ?? '[]') as Array<{ token?: string; roles?: string[] }>;
    return credentials.find((item) => item.roles?.includes('runtime'))?.token;
  } catch { return undefined; }
}

const token = getRuntimeToken();
const auditKey = process.env.ASGUARD_AUDIT_KEY;
const baseUrl = process.env.ASGUARD_API_URL || `http://localhost:${process.env.ASGUARD_PORT || '8080'}`;
if (!token || Buffer.byteLength(token, 'utf8') < 32) throw new Error('Configure ASGUARD_DEMO_TOKEN or a runtime credential in ASGUARD_API_CREDENTIALS (at least 32 bytes).');
if (!auditKey || Buffer.byteLength(auditKey, 'utf8') < 32) throw new Error('Configure ASGUARD_AUDIT_KEY for host-side attestation verification.');
const requiredToken = token;
const requiredAuditKey = auditKey;

const payload = {
  intent_type: 'token_diff', origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:usdt.tether-token.near',
  amount: '1000000000000000000000000', min_output_amount: '1', recipient: 'agent-guard.near', destination_chain: 'near',
  deadline: new Date(Date.now() + 10 * 60_000).toISOString(), max_slippage_bps: 100,
};

async function attempt(label: string, idempotencyKey: string): Promise<boolean> {
  let callbackCalled = false;
  try {
    await withAsguardApproval({
      baseUrl, token: requiredToken, auditKey: requiredAuditKey, agentId: 'asguard-agent-guard-demo', agentName: 'Agent Guard Demo', payload,
      payloadDomain: 'near-intent', network: `near:${process.env.ASGUARD_NEAR_NETWORK || 'testnet'}`,
      expectedVerifier: process.env.ASGUARD_NEAR_INTENTS_VERIFIER || 'intents.near', idempotencyKey,
      riskLevel: 'high', timeoutMs: 300_000, pollIntervalMs: 1_000,
      onPendingHitl: (requestId) => console.log(`${label}: request_id=${requestId}; operator action requested in dashboard.`),
    }, ({ attestation }) => {
      callbackCalled = true;
      console.log(`${label}: verified approval; host callback reached for ${attestation.payload_hash}. No wallet operation is configured.`);
    });
    return callbackCalled;
  } catch (error) {
    console.log(`${label}: blocked; callback_called=${callbackCalled}; ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log('Agent guard demo uses the live local ASGUARD API. Deny the first dashboard request, then approve the second. It never signs or submits.');
  const denyReachedCallback = await attempt('deny-check', `agent-guard-deny-${randomUUID()}`);
  if (denyReachedCallback) console.log('The first request was approved; the guard correctly ran only after verification. For the deny demonstration, rerun and deny it.');
  const approveReachedCallback = await attempt('approve-check', `agent-guard-approve-${randomUUID()}`);
  if (!approveReachedCallback) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
