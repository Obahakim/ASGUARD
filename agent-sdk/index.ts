import { createHash } from 'node:crypto';
import {
  verifyApprovalAttestation,
  type ApprovalVerificationOptions,
} from '../server/approvalAttestation';
import { normalizeNearIntent } from '../server/aos/nearIntent';
import type { ApprovalAttestation, SignApprovalResponse } from '../server/types';

export type AsguardPayloadDomain = 'near-intent' | 'near-chain-signature';
export type AsguardRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AsguardApprovalDecision {
  status: 'approved';
  requestId?: string;
  intentId: string;
  attestation: ApprovalAttestation;
  preflight?: SignApprovalResponse['preflight'];
}

export interface AsguardApprovalContext<TPayload> {
  attestation: ApprovalAttestation;
  canonicalPayload: TPayload;
  decision: AsguardApprovalDecision;
}

export interface AsguardApprovalOptions<TPayload> {
  baseUrl: string;
  token: string;
  agentId: string;
  agentName: string;
  payload: TPayload;
  payloadDomain: AsguardPayloadDomain;
  network: string;
  idempotencyKey: string;
  riskLevel: AsguardRiskLevel;
  action?: string;
  expectedVerifier?: string;
  chain?: string;
  derivationPath?: string;
  signerContract?: string;
  expectedMaxAmountUsd?: number;
  ipAddress?: string;
  deviceId?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPendingHitl?: (requestId: string) => void | Promise<void>;
  auditKey: string;
  fetchImpl?: typeof fetch;
}

export class AsguardApprovalError extends Error {
  constructor(message: string, readonly status?: string) {
    super(message);
    this.name = 'AsguardApprovalError';
  }
}

function assertHostRuntime(): void {
  if (typeof window !== 'undefined') {
    throw new Error('ASGUARD approval verification requires a trusted server-side host runtime.');
  }
}

function validateOptions<TPayload>(options: AsguardApprovalOptions<TPayload>): void {
  assertHostRuntime();
  let apiUrl: URL;
  try { apiUrl = new URL(options.baseUrl); } catch { throw new Error('baseUrl must be an HTTP(S) ASGUARD origin.'); }
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname))) {
    throw new Error('ASGUARD API connections must use HTTPS outside local development.');
  }
  if (!options.token || Buffer.byteLength(options.token, 'utf8') < 32) throw new Error('A runtime API token of at least 32 bytes is required.');
  if (Buffer.byteLength(options.auditKey ?? '', 'utf8') < 32) throw new Error('A host-side auditKey of at least 32 bytes is required.');
  if (!options.agentId.trim() || !options.agentName.trim()) throw new Error('agentId and agentName are required.');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(options.idempotencyKey)) throw new Error('idempotencyKey must be 8-128 permitted characters.');
  if (!options.network.trim()) throw new Error('network is required.');
  if (options.expectedMaxAmountUsd !== undefined && (!Number.isFinite(options.expectedMaxAmountUsd) || options.expectedMaxAmountUsd < 0)) {
    throw new Error('expectedMaxAmountUsd must be finite and non-negative.');
  }
  if (options.payloadDomain === 'near-intent') {
    if (!options.expectedVerifier) throw new Error('expectedVerifier is required for NEAR Intent approval.');
    if (options.network !== 'near:mainnet' && options.network !== 'near:testnet') throw new Error('NEAR Intent network must be near:mainnet or near:testnet.');
  } else {
    if (!options.chain || options.chain === 'near' || !options.network.startsWith(`${options.chain}:`)) throw new Error('Chain Signature approval requires an explicit foreign chain and namespaced network.');
    if (!options.derivationPath || !/^[A-Za-z0-9._:/-]{1,128}$/.test(options.derivationPath)) throw new Error('A valid derivationPath is required.');
    if (!options.signerContract) throw new Error('signerContract is required for Chain Signature approval.');
  }
}

function requireAttestation(response: SignApprovalResponse): ApprovalAttestation {
  if (response.status !== 'approved' || !response.attestation) {
    throw new AsguardApprovalError(response.reason ?? `ASGUARD returned ${response.status}.`, response.status);
  }
  return response.attestation;
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, token: string, deadline: number, init?: RequestInit): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AsguardApprovalError('ASGUARD request timed out; host action denied.', 'timeout_deny');
  const response = await fetchImpl(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(remaining),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string; reason?: string };
  if (!response.ok) throw new AsguardApprovalError(body.reason ?? body.error ?? `ASGUARD returned HTTP ${response.status}.`);
  return body;
}

export async function withAsguardApproval<TPayload, TResult>(
  options: AsguardApprovalOptions<TPayload>,
  callback: (context: AsguardApprovalContext<unknown>) => Promise<TResult> | TResult
): Promise<TResult> {
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) throw new Error('timeoutMs must be from 100 to 900000.');
  const deadline = Date.now() + timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const expectedVerifier = options.expectedVerifier;
  let canonicalPayload: unknown;
  let payloadHash: string;
  let body: Record<string, unknown>;
  let endpoint: string;

  if (options.payloadDomain === 'near-intent') {
    const normalized = normalizeNearIntent(options.payload, Date.now(), expectedVerifier);
    canonicalPayload = normalized.intent;
    payloadHash = normalized.payloadHash;
    endpoint = '/api/approvals/near-intent';
    body = {
      agent_id: options.agentId, agent_name: options.agentName, action: options.action ?? `near-intent:${normalized.intent.intent_type}`,
      risk_level: options.riskLevel, idempotency_key: options.idempotencyKey, network: options.network,
      near_intent: options.payload, ...(options.ipAddress ? { ip_address: options.ipAddress } : {}), ...(options.deviceId ? { device_id: options.deviceId } : {}),
    };
  } else {
    const bytes = typeof options.payload === 'string' ? Buffer.from(options.payload, 'utf8') : Buffer.from(options.payload as unknown as Uint8Array);
    if (bytes.length === 0) throw new Error('Chain Signature payload must not be empty.');
    canonicalPayload = options.payload;
    payloadHash = createHash('sha256').update(bytes).digest('hex');
    endpoint = '/api/approvals/chain-signature';
    body = {
      agent_id: options.agentId, agent_name: options.agentName, action: options.action ?? 'chain-signature', risk_level: options.riskLevel,
      payload_hash: payloadHash, payload_domain: 'near-chain-signature', network: options.network, chain: options.chain,
      derivation_path: options.derivationPath, signer_contract: options.signerContract, idempotency_key: options.idempotencyKey,
      ...(options.ipAddress ? { ip_address: options.ipAddress } : {}), ...(options.deviceId ? { device_id: options.deviceId } : {}),
    };
  }

  let decision: SignApprovalResponse;
  try {
    decision = await requestJson<SignApprovalResponse>(fetchImpl, `${baseUrl}${endpoint}`, options.token, deadline, { method: 'POST', body: JSON.stringify(body) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new AsguardApprovalError('ASGUARD request timed out; host action denied.', 'timeout_deny');
    throw error;
  }
  const interval = options.pollIntervalMs ?? 2_000;
  if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) throw new Error('pollIntervalMs must be from 100 to 60000.');
  if (decision.status === 'pending_hitl') {
    if (!decision.request_id) throw new AsguardApprovalError('ASGUARD pending response omitted request_id.', decision.status);
    const requestId = decision.request_id;
    await options.onPendingHitl?.(requestId);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - Date.now())));
      decision = await requestJson<SignApprovalResponse>(fetchImpl, `${baseUrl}/api/approvals/${encodeURIComponent(requestId)}`, options.token, deadline);
      if (decision.status !== 'pending_hitl') break;
    }
    if (decision.status === 'pending_hitl') throw new AsguardApprovalError('ASGUARD human approval timed out; host action denied.', 'timeout_deny');
  }

  if (Date.now() >= deadline) throw new AsguardApprovalError('ASGUARD approval timed out; host action denied.', 'timeout_deny');
  const attestation = requireAttestation(decision);
  const verification: ApprovalVerificationOptions = {
    signingKey: options.auditKey,
    expectedAgentId: options.agentId,
    expectedPayloadHash: payloadHash,
    expectedPayloadDomain: options.payloadDomain,
    expectedNetwork: options.network,
    expectedChain: options.payloadDomain === 'near-intent' ? 'near' : options.chain,
    expectedDerivationPath: options.derivationPath,
    expectedSignerContract: options.payloadDomain === 'near-chain-signature' ? options.signerContract : undefined,
    maxAmountUsd: options.expectedMaxAmountUsd,
    bytesToSign: options.payloadDomain === 'near-intent'
      ? (canonicalPayload as { schema: string }) && normalizeNearIntent(options.payload, Date.now(), expectedVerifier).canonicalBytes
      : options.payload as unknown as Uint8Array | string,
  };
  const result = verifyApprovalAttestation(attestation, verification);
  if (!result.valid) throw new AsguardApprovalError(`ASGUARD attestation verification failed: ${result.reason ?? 'invalid'}.`, result.reason);
  const approved: AsguardApprovalDecision = {
    status: 'approved', requestId: decision.request_id, intentId: decision.intent_id ?? attestation.intent_id, attestation, preflight: decision.preflight,
  };
  return callback({ attestation, canonicalPayload, decision: approved });
}
