import { createPrivateKey, createPublicKey, timingSafeEqual, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseApprovalPublicKey } from '../lib/approvalAttestation';

function readKeyFile(pathValue: string | undefined, variableName: string): Buffer {
  const path = pathValue?.trim();
  if (!path) throw new Error(`${variableName} must point to an Ed25519 PEM key file.`);
  try {
    return readFileSync(resolve(path));
  } catch {
    throw new Error(`${variableName} could not read its configured PEM key file.`);
  }
}

export function getApprovalPrivateKey(pathValue = process.env.ASGUARD_ATTESTATION_PRIVATE_KEY_PATH): KeyObject {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readKeyFile(pathValue, 'ASGUARD_ATTESTATION_PRIVATE_KEY_PATH'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH')) throw error;
    throw new Error('ASGUARD attestation private key is not a valid PEM private key.');
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('ASGUARD attestation private key must be Ed25519.');
  }
  return privateKey;
}

export function getApprovalPublicKey(pathValue = process.env.ASGUARD_ATTESTATION_PUBLIC_KEY_PATH): KeyObject {
  return parseApprovalPublicKey(readKeyFile(pathValue, 'ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'));
}

export function validateApprovalKeyPair(
  privateKeyPath = process.env.ASGUARD_ATTESTATION_PRIVATE_KEY_PATH,
  publicKeyPath = process.env.ASGUARD_ATTESTATION_PUBLIC_KEY_PATH
): void {
  const privateKey = getApprovalPrivateKey(privateKeyPath);
  const publicKey = getApprovalPublicKey(publicKeyPath);
  const derivedPublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const configuredPublicKey = publicKey.export({ format: 'der', type: 'spki' });
  if (derivedPublicKey.length !== configuredPublicKey.length || !timingSafeEqual(derivedPublicKey, configuredPublicKey)) {
    throw new Error('ASGUARD attestation public and private keys do not match.');
  }
}