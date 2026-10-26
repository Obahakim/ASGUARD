/**
 * Exercise NEAR Intent approval and host-side attestation verification.
 * This demo never signs or submits an intent.
 */
import { withApprovedNearIntent } from '../server/approvalAttestation';
import { randomUUID } from 'node:crypto';
import type { ApprovalAttestation, SignApprovalResponse } from '../server/types';

const configuredPort = process.env.ASGUARD_PORT;
const port = configuredPort && /^\d+$/.test(configuredPort) ? configuredPort : '8080';
const baseUrl = (process.env.ASGUARD_MCP_URL || `http://localhost:${port}/mcp`).replace(/\/$/, '');
const runtimeToken = process.env.ASGUARD_DEMO_TOKEN || (() => {
  try {
    const credentials = JSON.parse(process.env.ASGUARD_API_CREDENTIALS || '[]') as Array<{ token?: string; roles?: string[] }>;
    return credentials.find((credential) => credential.roles?.includes('runtime'))?.token;
  } catch {
    return undefined;
  }
})();

if (!runtimeToken || Buffer.byteLength(runtimeToken, 'utf8') < 32) {
  throw new Error('Set ASGUARD_DEMO_TOKEN or configure a runtime credential in ASGUARD_API_CREDENTIALS (minimum 32 bytes).');
}

let requestId = 0;
async function rpc(method: string, params?: Record<string, unknown>, notification = false) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, ...(params ? { params } : {}) }),
  });
  if (notification && response.status === 202) return undefined;
  const body = await response.json() as { error?: { message?: string }; result?: unknown };
  if (!response.ok || body.error) throw new Error(body.error?.message || `ASGUARD MCP returned HTTP ${response.status}.`);
  return body.result;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await rpc('tools/call', { name, arguments: args }) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((part) => part.type === 'text')?.text || JSON.stringify(result);
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'asguard-demo-trader', version: '1.0.0' },
  });
  await rpc('notifications/initialized', undefined, true);
  console.log('Connected to ASGUARD MCP at', baseUrl);
  console.log('Runtime status:', JSON.stringify(await callTool('asguard_get_status', {})));

  const agentId = process.env.ASGUARD_DEMO_AGENT_ID || 'near-intent-demo';
  const intent = {
    intent_type: 'token_diff',
    origin_asset: 'nep141:wrap.near',
    destination_asset: 'nep141:usdt.tether-token.near',
    amount: '10000000000000000000000',
    min_output_amount: '1',
    recipient: 'demo.near',
    destination_chain: 'near',
    deadline: new Date(Date.now() + 4 * 60_000).toISOString(),
    max_slippage_bps: 100,
  };
  console.log('Requesting approval for a sample NEAR Intent. No transaction will be signed or submitted.');
  let result = await callTool('asguard_request_near_intent_approval', {
    agent_id: agentId,
    agent_name: 'ASGUARD NEAR Intent Demo',
    risk_level: 'low',
    idempotency_key: `near-demo-${randomUUID()}`,
    near_intent: intent,
  }) as SignApprovalResponse;
  console.log('Approval response:', JSON.stringify(result));

  if (result.status === 'pending_hitl' && result.request_id) {
    console.log('Waiting for a dashboard operator decision (up to five minutes)...');
    for (let attempt = 0; attempt < 150; attempt += 1) {
      await wait(2_000);
      const status = await callTool('asguard_get_approval_status', { request_id: result.request_id }) as SignApprovalResponse;
      if (status.status !== 'pending_hitl') {
        result = status;
        break;
      }
    }
  }

  if (result.status !== 'approved' || !result.attestation) {
    console.log('Intent was not approved; host will not sign or submit it.');
    return;
  }

  await withApprovedNearIntent(intent, result.attestation as ApprovalAttestation, {
    expectedAgentId: agentId,
    expectedNetwork: `near:${process.env.ASGUARD_NEAR_NETWORK || 'testnet'}`,
    expectedVerifier: process.env.ASGUARD_NEAR_INTENTS_VERIFIER || 'intents.near',
  }, async (canonicalIntentBytes, _normalizedIntent, originalIntent) => {
    console.log('Host callback opened only after exact intent verification.');
    console.log('Original payload retained for the host signer:', JSON.stringify(originalIntent));
    console.log('No wallet signer or intent submission is configured in this demo.');
    return canonicalIntentBytes.length > 0;
  });
  void initialized;
}

main().catch((error) => {
  console.error('Demo trader failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
