import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { ApprovalAttestation, SignApprovalRequest } from './types';
import { normalizeNearIntent } from './aos/nearIntent';
import { getApprovalPrivateKey } from './attestationConfig';
import {
  buildApprovalPayload,
  DEFAULT_APPROVAL_TTL_MS,
  serializeApprovalPayload,
  verifyApprovalAttestation,
  type ApprovalPublicKey,
} from '../lib/approvalAttestation';

export { buildApprovalPayload, DEFAULT_APPROVAL_TTL_MS, verifyApprovalAttestation };

export function signApprovalPayload(payload: Record<string, unknown>, key: KeyObject | string | Buffer = getApprovalPrivateKey()): string {
  let privateKey: KeyObject;
  try {
    privateKey = typeof key === 'string' || Buffer.isBuffer(key) ? createPrivateKey(key) : key;
  } catch {
    throw new Error('ASGUARD approval signing requires an Ed25519 private key.');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('ASGUARD approval signing requires an Ed25519 private key.');
  }
  return sign(null, Buffer.from(serializeApprovalPayload(payload)), privateKey).toString('hex');
}

export function issueApprovalAttestation(input: {
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
  privateKey?: KeyObject | string | Buffer;
}): ApprovalAttestation {
  const privateKey = input.privateKey ?? getApprovalPrivateKey();
  const payload = buildApprovalPayload({
    decision_id: input.decision_id,
    intent_id: input.intent_id,
    agent_id: input.agent_id,
    network: input.network,
    chain: input.chain,
    payload_domain: input.payload_domain,
    derivation_path: input.derivation_path,
    signer_contract: input.signer_contract,
    intent_type: input.intent_type,
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
    signature: signApprovalPayload(payload, privateKey),
  };
}

export function assertApprovedThenSign(
  bytesToSign: Uint8Array | string,
  attestation: ApprovalAttestation,
  publicVerifyParams: {
    publicKey: ApprovalPublicKey;
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
): true {
  const verification = verifyApprovalAttestation(attestation, {
    publicKey: publicVerifyParams.publicKey,
    bytesToSign,
    expectedAgentId: publicVerifyParams.expectedAgentId,
    expectedPayloadHash: publicVerifyParams.expectedPayloadHash,
    expectedPayloadDomain: publicVerifyParams.expectedPayloadDomain,
    expectedDerivationPath: publicVerifyParams.expectedDerivationPath,
    expectedIntentType: publicVerifyParams.expectedIntentType,
    expectedNetwork: publicVerifyParams.expectedNetwork,
    expectedChain: publicVerifyParams.expectedChain,
    expectedSignerContract: publicVerifyParams.expectedSignerContract,
    maxAmountUsd: publicVerifyParams.maxAmountUsd,
    now: publicVerifyParams.now,
  });
  if (!verification.valid) throw new Error(`ASGUARD attestation rejected: ${verification.reason ?? 'invalid'}`);
  return true;
}

export function assertApprovedThenSignIntent(
  intentInput: unknown,
  attestation: ApprovalAttestation,
  publicVerifyParams: {
    publicKey: ApprovalPublicKey;
    expectedAgentId?: string;
    expectedNetwork: string;
    expectedVerifier: string;
    now?: Date;
  }
): true {
  const normalized = normalizeNearIntent(intentInput, (publicVerifyParams.now ?? new Date()).getTime(), publicVerifyParams.expectedVerifier);
  const verification = verifyApprovalAttestation(attestation, {
    publicKey: publicVerifyParams.publicKey,
    bytesToSign: normalized.canonicalBytes,
    expectedAgentId: publicVerifyParams.expectedAgentId,
    expectedPayloadHash: normalized.payloadHash,
    expectedPayloadDomain: 'near-intent',
    expectedIntentType: normalized.intent.intent_type,
    expectedNetwork: publicVerifyParams.expectedNetwork,
    expectedChain: 'near',
    now: publicVerifyParams.now,
  });
  if (!verification.valid) throw new Error(`ASGUARD intent attestation rejected: ${verification.reason ?? 'invalid'}`);
  return true;
}

export async function withApprovedNearIntent<T>(
  intentInput: unknown,
  attestation: ApprovalAttestation,
  params: {
    publicKey: ApprovalPublicKey;
    expectedAgentId: string;
    expectedNetwork: string;
    expectedVerifier: string;
    now?: Date;
  },
  signOrSubmit: (
    canonicalIntentBytes: string,
    intent: ReturnType<typeof normalizeNearIntent>['intent'],
    originalIntentPayload: unknown
  ) => Promise<T>
): Promise<T> {
  const normalized = normalizeNearIntent(intentInput, (params.now ?? new Date()).getTime(), params.expectedVerifier);
  const verification = verifyApprovalAttestation(attestation, {
    publicKey: params.publicKey,
    bytesToSign: normalized.canonicalBytes,
    expectedAgentId: params.expectedAgentId,
    expectedPayloadHash: normalized.payloadHash,
    expectedPayloadDomain: 'near-intent',
    expectedIntentType: normalized.intent.intent_type,
    expectedNetwork: params.expectedNetwork,
    expectedChain: 'near',
    now: params.now,
  });
  if (!verification.valid) throw new Error(`ASGUARD intent attestation rejected: ${verification.reason ?? 'invalid'}`);
  return signOrSubmit(normalized.canonicalBytes, normalized.intent, intentInput);
}

export function assertApprovedThenSignChainPayload(
  payload: Uint8Array | string,
  attestation: ApprovalAttestation,
  params: {
    derivationPath: string;
    payloadDomain: string;
    expectedNetwork: string;
    expectedChain: string;
    signerContract: string;
    publicKey: ApprovalPublicKey;
    expectedAgentId?: string;
    maxAmountUsd?: number;
    now?: Date;
  }
): true {
  const verification = verifyApprovalAttestation(attestation, {
    publicKey: params.publicKey,
    bytesToSign: payload,
    expectedAgentId: params.expectedAgentId,
    expectedPayloadDomain: params.payloadDomain,
    expectedDerivationPath: params.derivationPath,
    expectedNetwork: params.expectedNetwork,
    expectedChain: params.expectedChain,
    expectedSignerContract: params.signerContract,
    maxAmountUsd: params.maxAmountUsd,
    now: params.now,
  });
  if (!verification.valid) throw new Error(`ASGUARD chain-signature attestation rejected: ${verification.reason ?? 'invalid'}`);
  return true;
}

export async function withApprovedChainSignature<T>(
  payload: Uint8Array | string,
  attestation: ApprovalAttestation,
  params: {
    derivationPath: string;
    payloadDomain: string;
    expectedNetwork: string;
    expectedChain: string;
    signerContract: string;
    publicKey: ApprovalPublicKey;
    expectedAgentId: string;
    now?: Date;
  },
  requestSignature: (approvedPayload: Uint8Array | string) => Promise<T>
): Promise<T> {
  assertApprovedThenSignChainPayload(payload, attestation, params);
  return requestSignature(payload);
}

export function validateApprovalRequest(input: Partial<SignApprovalRequest>): void {
  if ([input.agent_id, input.agent_name, input.action, input.payload_hash, input.network, input.idempotency_key].some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('agent_id, agent_name, action, payload_hash, network, and idempotency_key are required.');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(String(input.risk_level ?? ''))) {
    throw new Error('risk_level must be low, medium, high, or critical.');
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

const approvalAttestation = {
  DEFAULT_APPROVAL_TTL_MS,
  buildApprovalPayload,
  signApprovalPayload,
  issueApprovalAttestation,
  verifyApprovalAttestation,
  assertApprovedThenSign,
  assertApprovedThenSignIntent,
  assertApprovedThenSignChainPayload,
  withApprovedNearIntent,
  withApprovedChainSignature,
  validateApprovalRequest,
};

export default approvalAttestation;
