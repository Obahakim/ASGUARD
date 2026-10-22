import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { ApprovalAttestation, SignApprovalRequest } from './types';

export const DEFAULT_APPROVAL_TTL_MS = Number(process.env.ASGUARD_APPROVAL_TTL_MS || 120000);

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const result: Record<string, unknown> = {};
    for (const [k, v] of entries) result[k] = sortObject(v);
    return result;
  }
  return value;
}

export function getApprovalSigningKey(value = process.env.ASGUARD_AUDIT_KEY || process.env.ASGUARD_APPROVAL_KEY): string {
  const signingKey = value?.trim();
  if (!signingKey) throw new Error('ASGUARD_AUDIT_KEY or ASGUARD_APPROVAL_KEY must be configured before signing approvals.');
  if (Buffer.byteLength(signingKey, 'utf8') < 32) throw new Error('Approval signing key must contain at least 32 bytes.');
  return signingKey;
}

export function buildApprovalPayload(params: {
  decision_id: string;
  intent_id: string;
  agent_id: string;
  network: string;
  chain?: string;
  payload_hash: string;
  action: 'approve_once' | 'approve_session';
  max_amount_usd?: number;
  expires_at: string;
  anomaly_score: number;
  rules_triggered: Array<{ rule_id: string; severity: string; score_contribution: number; details?: Record<string, unknown> }>;
  issued_at: string;
  policy_version?: string;
}) {
  return {
    decision_id: params.decision_id,
    intent_id: params.intent_id,
    agent_id: params.agent_id,
    network: params.network,
    chain: params.chain,
    payload_hash: params.payload_hash,
    action: params.action,
    max_amount_usd: params.max_amount_usd,
    expires_at: params.expires_at,
    anomaly_score: params.anomaly_score,
    rules_triggered: params.rules_triggered,
    issued_at: params.issued_at,
    policy_version: params.policy_version,
  };
}

export function signApprovalPayload(payload: Record<string, unknown>, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

export function issueApprovalAttestation(input: {
  decision_id: string;
  intent_id: string;
  agent_id: string;
  network: string;
  chain?: string;
  payload_hash: string;
  action: 'approve_once' | 'approve_session';
  max_amount_usd?: number;
  expires_at: string;
  anomaly_score: number;
  rules_triggered: Array<{ rule_id: string; severity: string; score_contribution: number; details?: Record<string, unknown> }>;
  issued_at: string;
  policy_version?: string;
  secret?: string;
}): ApprovalAttestation {
  const secret = input.secret ?? getApprovalSigningKey();
  const payload = buildApprovalPayload({
    decision_id: input.decision_id,
    intent_id: input.intent_id,
    agent_id: input.agent_id,
    network: input.network,
    chain: input.chain,
    payload_hash: input.payload_hash,
    action: input.action,
    max_amount_usd: input.max_amount_usd,
    expires_at: input.expires_at,
    anomaly_score: input.anomaly_score,
    rules_triggered: input.rules_triggered,
    issued_at: input.issued_at,
    policy_version: input.policy_version,
  });

  return {
    ...payload,
    signature: signApprovalPayload(payload, secret),
  };
}

export function verifyApprovalAttestation(
  attestation: Pick<ApprovalAttestation, 'decision_id' | 'intent_id' | 'agent_id' | 'network' | 'chain' | 'payload_hash' | 'action' | 'max_amount_usd' | 'expires_at' | 'anomaly_score' | 'rules_triggered' | 'issued_at' | 'policy_version' | 'signature'>,
  opts?: {
    signingKey?: string;
    bytesToSign?: Uint8Array | string;
    expectedAgentId?: string;
    expectedPayloadHash?: string;
    maxAmountUsd?: number;
    now?: Date;
  }
): { valid: boolean; reason?: string } {
  const signingKey = (opts?.signingKey ?? getApprovalSigningKey()).trim();
  const now = opts?.now ?? new Date();
  const payload = buildApprovalPayload({
    decision_id: attestation.decision_id,
    intent_id: attestation.intent_id,
    agent_id: attestation.agent_id,
    network: attestation.network,
    chain: attestation.chain,
    payload_hash: attestation.payload_hash,
    action: attestation.action,
    max_amount_usd: attestation.max_amount_usd,
    expires_at: attestation.expires_at,
    anomaly_score: attestation.anomaly_score,
    rules_triggered: attestation.rules_triggered,
    issued_at: attestation.issued_at,
    policy_version: attestation.policy_version,
  });

  const expectedSignature = signApprovalPayload(payload, signingKey);
  if (!timingSafeEqual(Buffer.from(attestation.signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  if (new Date(attestation.expires_at).getTime() <= now.getTime()) {
    return { valid: false, reason: 'expired' };
  }

  if (opts?.expectedAgentId && opts.expectedAgentId !== attestation.agent_id) {
    return { valid: false, reason: 'agent_id_mismatch' };
  }

  if (opts?.expectedPayloadHash && opts.expectedPayloadHash !== attestation.payload_hash) {
    return { valid: false, reason: 'payload_hash_mismatch' };
  }

  if (typeof opts?.bytesToSign !== 'undefined') {
    const actualHash = createHash('sha256')
      .update(typeof opts.bytesToSign === 'string' ? opts.bytesToSign : Buffer.from(opts.bytesToSign))
      .digest('hex');
    if (actualHash !== attestation.payload_hash) {
      return { valid: false, reason: 'bytes_to_sign_hash_mismatch' };
    }
  }

  if (typeof opts?.maxAmountUsd === 'number' && typeof attestation.max_amount_usd === 'number' && opts.maxAmountUsd > attestation.max_amount_usd) {
    return { valid: false, reason: 'amount_exceeds_attestation_limit' };
  }

  return { valid: true };
}

export function assertApprovedThenSign(
  bytesToSign: Uint8Array | string,
  attestation: ApprovalAttestation,
  publicVerifyParams: {
    signingKey?: string;
    expectedAgentId?: string;
    expectedPayloadHash?: string;
    maxAmountUsd?: number;
    now?: Date;
  } = {}
): true {
  const verification = verifyApprovalAttestation(attestation, {
    signingKey: publicVerifyParams.signingKey,
    bytesToSign,
    expectedAgentId: publicVerifyParams.expectedAgentId,
    expectedPayloadHash: publicVerifyParams.expectedPayloadHash,
    maxAmountUsd: publicVerifyParams.maxAmountUsd,
    now: publicVerifyParams.now,
  });
  if (!verification.valid) throw new Error(`ASGUARD attestation rejected: ${verification.reason ?? 'invalid'}`);
  return true;
}

export function validateApprovalRequest(input: Partial<SignApprovalRequest>): void {
  if ([input.agent_id, input.agent_name, input.action, input.payload_hash, input.network, input.idempotency_key].some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('agent_id, agent_name, action, payload_hash, network, and idempotency_key are required.');
  }
  if (!['low', 'medium', 'high'].includes(String(input.risk_level ?? ''))) {
    throw new Error('risk_level must be low, medium, or high.');
  }
  if (input.amount_usd !== undefined && (!Number.isFinite(input.amount_usd) || input.amount_usd < 0)) {
    throw new Error('amount_usd must be a non-negative finite number.');
  }
  if (!/^[A-Fa-f0-9]{64}$/.test(String(input.payload_hash))) {
    throw new Error('payload_hash must be a SHA-256 hexadecimal string.');
  }
  if (input.chain && input.network?.includes(':') && input.chain.toLowerCase() !== input.network.split(':', 1)[0].toLowerCase()) {
    throw new Error('chain does not match the namespace in network.');
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key!)) {
    throw new Error('idempotency_key must be 8-128 characters using letters, numbers, dot, underscore, colon, or dash.');
  }
}

export default {
  DEFAULT_APPROVAL_TTL_MS,
  getApprovalSigningKey,
  buildApprovalPayload,
  signApprovalPayload,
  issueApprovalAttestation,
  verifyApprovalAttestation,
  assertApprovedThenSign,
  validateApprovalRequest,
};
