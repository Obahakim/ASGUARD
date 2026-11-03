import { createHash, type KeyObject } from 'node:crypto';

export function buildPublicKeyResponse(publicKey: KeyObject): {
  algorithm: 'ed25519';
  public_key_pem: string;
  fingerprint_sha256: string;
} {
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('An Ed25519 public key is required.');
  }
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    algorithm: 'ed25519',
    public_key_pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprint_sha256: createHash('sha256').update(der).digest('hex'),
  };
}
