import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { ApprovalAttestation } from '../server/types';

const configuredTtl = Number(process.env.ASGUARD_APPROVAL_TTL_MS || 120000);
export const DEFAULT_APPROVAL_TTL_MS = Number.isInteger(configuredTtl) && configuredTtl >= 1_000 && configuredTtl <= 600_000
  ? configuredTtl
  : 120_000;

export type ApprovalPublicKey = string | Buffer | KeyObject;

export function parseApprovalPublicKey(value: ApprovalPublicKey): KeyObject {
  let publicKey: KeyObject;
  try {
    const pem = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) throw new Error('Private key material is not accepted.');
    publicKey = typeof value === 'string' || Buffer.isBuffer(value) ? createPublicKey(value) : value;
  } catch {
    throw new Error('ASGUARD attestation public key is invalid.');
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('ASGUARD attestation public key must be an Ed25519 public key.');
  }
  return publicKey;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of entries) result[key] = sortObject(nestedValue);
    return result;
  }
  return value;
}

export function serializeApprovalPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(sortObject(payload));
}

export function buildApprovalPayload(params: {
  decision_id: string;
  intent_id: string;
  agent_id: string;
  network: string;
  chain?: string;
  payload_domain?: string;
  derivation_path?: string;
  signer_contract?: string;
  intent_type?: string;
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
    payload_domain: params.payload_domain,
    derivation_path: params.derivation_path,
    signer_contract: params.signer_contract,
    intent_type: params.intent_type,
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

export interface ApprovalVerificationOptions {
  publicKey: ApprovalPublicKey;
  bytesToSign?: Uint8Array | string;
  expectedAgentId?: string;
  expectedPayloadHash?: string;
  expectedPayloadDomain?: string;
  expectedDerivationPath?: string;
  expectedIntentType?: string;
  expectedNetwork?: string;
  expectedChain?: string;
  expectedSignerContract?: string;
  maxAmountUsd?: number;
  now?: Date;
}

export function verifyApprovalAttestation(
  attestation: Pick<ApprovalAttestation, 'decision_id' | 'intent_id' | 'agent_id' | 'network' | 'chain' | 'payload_domain' | 'derivation_path' | 'signer_contract' | 'intent_type' | 'payload_hash' | 'action' | 'max_amount_usd' | 'expires_at' | 'anomaly_score' | 'rules_triggered' | 'issued_at' | 'policy_version' | 'signature'>,
  opts: ApprovalVerificationOptions
): { valid: boolean; reason?: string } {
  let publicKey: KeyObject;
  try {
    publicKey = parseApprovalPublicKey(opts.publicKey);
  } catch {
    return { valid: false, reason: 'invalid_public_key' };
  }

  const now = opts.now ?? new Date();
  const payload = buildApprovalPayload({
    decision_id: attestation.decision_id,
    intent_id: attestation.intent_id,
    agent_id: attestation.agent_id,
    network: attestation.network,
    chain: attestation.chain,
    payload_domain: attestation.payload_domain,
    derivation_path: attestation.derivation_path,
    signer_contract: attestation.signer_contract,
    intent_type: attestation.intent_type,
    payload_hash: attestation.payload_hash,
    action: attestation.action,
    max_amount_usd: attestation.max_amount_usd,
    expires_at: attestation.expires_at,
    anomaly_score: attestation.anomaly_score,
    rules_triggered: attestation.rules_triggered,
    issued_at: attestation.issued_at,
    policy_version: attestation.policy_version,
  });
  if (!/^[\da-f]{128}$/i.test(attestation.signature)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (!verifySignature(null, Buffer.from(serializeApprovalPayload(payload)), publicKey, Buffer.from(attestation.signature, 'hex'))) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  const issuedAt = Date.parse(attestation.issued_at);
  const expiresAt = Date.parse(attestation.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now.getTime() || expiresAt <= now.getTime()
    || expiresAt <= issuedAt || expiresAt - issuedAt > DEFAULT_APPROVAL_TTL_MS) {
    return { valid: false, reason: 'expired' };
  }

  if (opts.expectedAgentId && opts.expectedAgentId !== attestation.agent_id) return { valid: false, reason: 'agent_id_mismatch' };
  if (opts.expectedPayloadHash && opts.expectedPayloadHash !== attestation.payload_hash) return { valid: false, reason: 'payload_hash_mismatch' };
  if (opts.expectedPayloadDomain && opts.expectedPayloadDomain !== attestation.payload_domain) return { valid: false, reason: 'payload_domain_mismatch' };
  if (opts.expectedDerivationPath && opts.expectedDerivationPath !== attestation.derivation_path) return { valid: false, reason: 'derivation_path_mismatch' };
  if (opts.expectedIntentType && opts.expectedIntentType !== attestation.intent_type) return { valid: false, reason: 'intent_type_mismatch' };
  if (opts.expectedNetwork && opts.expectedNetwork !== attestation.network) return { valid: false, reason: 'network_mismatch' };
  if (opts.expectedChain && opts.expectedChain !== attestation.chain) return { valid: false, reason: 'chain_mismatch' };
  if (opts.expectedSignerContract && opts.expectedSignerContract !== attestation.signer_contract) return { valid: false, reason: 'signer_contract_mismatch' };

  if (typeof opts.bytesToSign !== 'undefined') {
    const actualHash = createHash('sha256')
      .update(typeof opts.bytesToSign === 'string' ? opts.bytesToSign : Buffer.from(opts.bytesToSign))
      .digest('hex');
    if (actualHash !== attestation.payload_hash) return { valid: false, reason: 'bytes_to_sign_hash_mismatch' };
  }

  if (typeof opts.maxAmountUsd === 'number') {
    if (typeof attestation.max_amount_usd !== 'number') return { valid: false, reason: 'attested_amount_limit_missing' };
    if (attestation.max_amount_usd > opts.maxAmountUsd) return { valid: false, reason: 'attested_amount_exceeds_host_limit' };
  }

  return { valid: true };
}