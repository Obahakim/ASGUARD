import crypto from 'node:crypto';
import type { AgentSphereOperator } from '../types';

type Challenge = {
  wallet_address: string;
  nonce: string;
  message: string;
  expires_at: number;
};

const challenges = new Map<string, Challenge>();
const sessions = new Map<string, AgentSphereOperator>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

export function createWalletChallenge(walletAddress: string, origin: string) {
  const normalized = walletAddress.trim();
  if (!normalized || !origin.trim()) throw new Error('wallet address and origin are required');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = `ASGUARD AgentSphere login\\nOrigin: ${origin}\\nWallet: ${normalized}\\nNonce: ${nonce}\\nExpires: ${new Date(expiresAt).toISOString()}`;
  challenges.set(nonce, { wallet_address: normalized, nonce, message, expires_at: expiresAt });
  return { nonce, message, expires_at: new Date(expiresAt).toISOString() };
}

/**
 * AgentSphere owns wallet signature verification. Until its verifier is configured,
 * authentication fails closed rather than accepting an unverifiable signature.
 */
export async function verifyWalletChallenge(input: {
  wallet_address: string;
  nonce: string;
  signature: string;
  origin: string;
}): Promise<AgentSphereOperator> {
  const challenge = challenges.get(input.nonce);
  if (!challenge || challenge.expires_at < Date.now()) throw new Error('challenge expired or unknown');
  challenges.delete(input.nonce);
  if (challenge.wallet_address !== input.wallet_address.trim()) throw new Error('wallet does not match challenge');
  if (!input.signature.trim()) throw new Error('signature is required');
  if (input.origin.trim() === '') throw new Error('origin is required');
  if (process.env.AGENTSPHERE_SIGNATURE_VERIFIER !== 'configured') {
    throw new Error('AgentSphere signature verifier is not configured; authentication denied');
  }
  throw new Error('AgentSphere verifier adapter is not implemented for this runtime');
}

export function getOperatorFromSession(sessionId: string | undefined): AgentSphereOperator | undefined {
  if (!sessionId) return undefined;
  const operator = sessions.get(sessionId);
  if (!operator || new Date(operator.expires_at).getTime() < Date.now()) {
    sessions.delete(sessionId);
    return undefined;
  }
  return operator;
}

export function revokeOperatorSession(sessionId: string) {
  sessions.delete(sessionId);
}
