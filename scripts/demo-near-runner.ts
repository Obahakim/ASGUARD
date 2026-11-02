import { randomUUID } from 'node:crypto';
import { withAsguardApproval } from '../agent-sdk/index';
import type { DemoConfig } from './demo-common';

export type NearDemoMode = 'approve' | 'hitl' | 'block';

export interface NearDemoScenario {
  name?: string;
  mode: NearDemoMode;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  agentId?: string;
  intent?: Record<string, unknown>;
}

function defaultIntent(recipient: string, deadline: string): Record<string, unknown> {
  return {
    intent_type: 'token_diff',
    origin_asset: 'nep141:wrap.near',
    destination_asset: 'nep141:usdt.tether-token.near',
    amount: '1000000000000000000000000',
    min_output_amount: '1',
    recipient,
    destination_chain: 'near',
    deadline,
    max_slippage_bps: 100,
  };
}

function scenarioAgentId(scenario: NearDemoScenario, label: string): string {
  const configured = scenario.agentId || process.env.ASGUARD_DEMO_AGENT_ID;
  if (configured?.trim()) return configured.trim();
  const suffix = (scenario.name || label).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `near-demo-${suffix || label}`;
}

export async function runNearScenario(config: DemoConfig, scenario: NearDemoScenario): Promise<void> {
  if (!['approve', 'hitl', 'block'].includes(scenario.mode)) {
    throw new Error(`Unknown scenario mode "${scenario.mode}". Expected approve, hitl, or block.`);
  }
  if (scenario.riskLevel !== undefined && !['low', 'medium', 'high', 'critical'].includes(scenario.riskLevel)) {
    throw new Error(`Scenario ${scenario.name ?? scenario.mode}: riskLevel must be low, medium, high, or critical.`);
  }

  const mode = scenario.mode;
  const label = scenario.name || mode;
  const intent = {
    ...defaultIntent('demo.near', '2099-01-01T00:00:00.000Z'),
    ...scenario.intent,
  };
  const agentId = scenarioAgentId(scenario, mode);
  const riskLevel = scenario.riskLevel || (mode === 'hitl' ? 'high' : 'low');
  console.log(`Scenario: ${label}; mode=${mode}; risk=${riskLevel}; agent=${agentId}.`);
  console.log('Expected: approval is preflight-only; any HITL decision is made in the authenticated dashboard.');

  if (mode === 'block') {
    const expiredIntent = { ...intent, deadline: '2000-01-01T00:00:00.000Z' };
    let response: Response;
    try {
      response = await fetch(`${config.apiUrl}/api/approvals/near-intent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.runtimeToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId,
          agent_name: 'ASGUARD Demo Suite',
          risk_level: riskLevel,
          idempotency_key: `near-demo-block-${randomUUID()}`,
          network: config.network,
          near_intent: expiredIntent,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error(`Backend request failed during scenario "${label}". Confirm that "npm run dev:backend" is still running.`);
    }
    const body = await response.json().catch(() => ({})) as {
      status?: string;
      request_id?: string;
      reason?: string;
      preflight?: { status?: string; reasons?: string[] };
    };
    const preflight = body.preflight ?? {
      status: 'decode_rejected',
      reasons: [body.reason ?? `HTTP ${response.status}`],
    };
    console.log(JSON.stringify({
      request_id: body.request_id ?? null,
      http_status: response.status,
      status: body.status ?? 'rejected',
      preflight,
    }, null, 2));
    if (response.ok || body.status !== 'rejected') {
      throw new Error('Expected the expired NEAR intent to be rejected before approval.');
    }
    console.log('Expected outcome observed: expired intent rejected; no callback, signing, or submission.');
    return;
  }

  try {
    await withAsguardApproval({
      baseUrl: config.apiUrl,
      token: config.runtimeToken,
      attestationPublicKey: config.attestationPublicKey,
      agentId,
      agentName: 'ASGUARD Demo Suite',
      payload: intent,
      payloadDomain: 'near-intent',
      network: config.network,
      expectedVerifier: config.verifier,
      idempotencyKey: `near-demo-${mode}-${randomUUID()}`,
      riskLevel,
      expectedMaxAmountUsd: 1_000,
      pollIntervalMs: 1_000,
      timeoutMs: 180_000,
      onPendingHitl: (requestId) => console.log(`HITL pending: request_id=${requestId}; resolve it in the dashboard within 3 minutes.`),
    }, ({ attestation, canonicalPayload, decision }) => {
      console.log(JSON.stringify({
        request_id: decision.requestId ?? null,
        status: 'approved',
        preflight: decision.preflight ?? null,
        payload_hash: attestation.payload_hash,
      }, null, 2));
      console.log('Verified host callback reached. The callback performs no signing or transaction submission.');
      console.log(`Canonical payload schema: ${(canonicalPayload as { schema?: string }).schema ?? 'unknown'}.`);
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const status = error instanceof Error && 'status' in error
      ? (error as { status?: string }).status ?? 'rejected'
      : 'rejected';
    console.error(JSON.stringify({ status, reason, callback: 'not_called' }, null, 2));
    throw new Error(`Scenario "${label}" did not reach a verified approval callback.`);
  }
}
