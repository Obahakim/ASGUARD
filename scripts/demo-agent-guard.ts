import { randomUUID } from 'node:crypto';
import { AsguardApprovalError, withAsguardApproval } from '../agent-sdk/index';
import { runDemo, type DemoConfig } from './demo-common';

type AttemptResult = 'approved' | 'rejected' | 'failed';

const payload = {
  intent_type: 'token_diff',
  origin_asset: 'nep141:wrap.near',
  destination_asset: 'nep141:usdt.tether-token.near',
  amount: '1000000000000000000000000',
  min_output_amount: '1',
  recipient: 'agent-guard.near',
  destination_chain: 'near',
  deadline: '2099-01-01T00:00:00.000Z',
  max_slippage_bps: 100,
};

async function attempt(config: DemoConfig, label: string): Promise<AttemptResult> {
  let callbackCalled = false;
  try {
    await withAsguardApproval({
      baseUrl: config.apiUrl,
      token: config.runtimeToken,
      auditKey: config.auditKey,
      agentId: 'asguard-agent-guard-demo',
      agentName: 'Agent Guard Demo',
      action: `agent-guard:${label}`,
      payload,
      payloadDomain: 'near-intent',
      network: config.network,
      expectedVerifier: config.verifier,
      idempotencyKey: `agent-guard-${label}-${randomUUID()}`,
      riskLevel: 'high',
      timeoutMs: 180_000,
      pollIntervalMs: 1_000,
      onPendingHitl: (requestId) => console.log(`${label}: request_id=${requestId}; choose the requested action in the dashboard.`),
    }, ({ attestation }) => {
      callbackCalled = true;
      console.log(`${label}: verified approval callback reached for payload ${attestation.payload_hash}; no wallet operation is configured.`);
    });
    return callbackCalled ? 'approved' : 'failed';
  } catch (error) {
    const status = error instanceof AsguardApprovalError ? error.status : undefined;
    console.log(`${label}: ${status === 'rejected' ? 'rejected' : 'failed'}; callback_called=${callbackCalled}; ${error instanceof Error ? error.message : String(error)}`);
    return status === 'rejected' && !callbackCalled ? 'rejected' : 'failed';
  }
}

void runDemo('demo:agent-guard', async (config) => {
  console.log('Expected flow: deny the first high-risk dashboard request, then allow the second once. Each decision is bounded to 3 minutes.');
  console.log('If denied, the host callback must not run; if approved, only the verification callback runs (never a wallet action).');
  const denyResult = await attempt(config, 'deny-check');
  const approveResult = await attempt(config, 'approve-check');
  if (denyResult !== 'rejected' || approveResult !== 'approved') {
    throw new Error(`Unexpected guard outcomes: deny-check=${denyResult}, approve-check=${approveResult}. Confirm the first request was denied and the second approved once in the dashboard.`);
  }
  console.log('Expected outcomes observed: deny blocked the callback; approval reached the verified callback; no transaction was signed or submitted.');
});
